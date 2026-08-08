// Email delivery — builds provider-specific HTTP requests for sending the
// meeting summary + plain-text transcript by email. No SMTP is possible
// from an extension, so we POST to the HTTP API of the provider the user
// configured (API key lives in chrome.storage.local, same as the webhook
// credentials — never hardcoded in source).

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.email) return;

  const PROVIDERS = {
    resend: { label: "Resend", host: "api.resend.com" },
    sendgrid: { label: "SendGrid", host: "api.sendgrid.com" },
    mailgun: { label: "Mailgun", host: "api.mailgun.net" },
  };

  function providerHost(cfg) {
    return PROVIDERS[cfg.emailProvider]?.host || null;
  }

  // True when enough config is present to attempt a send.
  function configComplete(cfg) {
    if (!PROVIDERS[cfg.emailProvider]) return false;
    if (!cfg.emailApiKey || !cfg.emailFrom) return false;
    if (cfg.emailProvider === "mailgun" && !cfg.emailMailgunDomain) return false;
    return true;
  }

  // "Jane <jane@x.com>" → { name: "Jane", email: "jane@x.com" }
  // "jane@x.com"        → { email: "jane@x.com" }
  function parseAddress(s) {
    const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(s || "");
    if (m) {
      const out = { email: m[2].trim() };
      if (m[1]) out.name = m[1].replace(/^"|"$/g, "");
      return out;
    }
    return { email: String(s || "").trim() };
  }

  // msg: { from: string, to: string[], subject, text }
  // Returns { url, headers, body } or null for an unknown provider.
  function buildRequest(cfg, msg) {
    switch (cfg.emailProvider) {
      case "resend":
        return {
          url: "https://api.resend.com/emails",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.emailApiKey}`,
          },
          body: JSON.stringify({
            from: msg.from,
            to: msg.to,
            subject: msg.subject,
            text: msg.text,
          }),
        };
      case "sendgrid":
        return {
          url: "https://api.sendgrid.com/v3/mail/send",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.emailApiKey}`,
          },
          body: JSON.stringify({
            personalizations: [{ to: msg.to.map((email) => ({ email })) }],
            from: parseAddress(msg.from),
            subject: msg.subject,
            content: [{ type: "text/plain", value: msg.text }],
          }),
        };
      case "mailgun":
        return {
          url: `https://api.mailgun.net/v3/${encodeURIComponent(
            cfg.emailMailgunDomain
          )}/messages`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`api:${cfg.emailApiKey}`)}`,
          },
          body: new URLSearchParams({
            from: msg.from,
            to: msg.to.join(", "),
            subject: msg.subject,
            text: msg.text,
          }).toString(),
        };
      default:
        return null;
    }
  }

  // Compose the email for a vCon doc. Body is the plain-text rendering
  // (summary section included when doc.analysis carries one).
  // opts: { from: string, to: string[] }
  function buildMessage(doc, opts) {
    const meta =
      doc.attachments?.find((a) => a.type === "meeting_metadata")?.body || {};
    const title = doc.subject || meta.meeting_code || "Google Meet call";
    const when = doc.created_at ? new Date(doc.created_at) : null;
    const dateStr =
      when && !isNaN(when)
        ? when.toLocaleDateString([], {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "";
    return {
      from: opts.from,
      to: opts.to,
      subject: `Meeting notes: ${title}${dateStr ? ` — ${dateStr}` : ""}`,
      text: ns.vcon.toPlainText(doc),
    };
  }

  // "a@x.com, b@y.com" → ["a@x.com", "b@y.com"]
  function splitRecipients(s) {
    return String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  ns.email = {
    PROVIDERS,
    providerHost,
    configComplete,
    buildRequest,
    buildMessage,
    splitRecipients,
  };
})(typeof self !== "undefined" ? self : window);
