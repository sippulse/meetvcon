// Non-sensitive extension state. Transcript bodies are encrypted by the
// service worker before being written to chrome.storage.local.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.storage) return;

  async function getConfig() {
    return ns.config.get();
  }

  async function getQueue() {
    const { queue } = await chrome.storage.local.get("queue");
    return queue || [];
  }

  async function setQueue(items) {
    await chrome.storage.local.set({ queue: items });
  }

  async function getConsent() {
    const { consent } = await chrome.storage.local.get("consent");
    return consent || null;
  }

  async function setConsent(accepted) {
    const consent = accepted
      ? { accepted: true, acceptedAt: new Date().toISOString(), version: 1 }
      : null;
    await chrome.storage.local.set({ consent });
    return consent;
  }

  async function getDeliveryStatus() {
    const { deliveryStatus } = await chrome.storage.local.get("deliveryStatus");
    return deliveryStatus || { state: "idle" };
  }

  async function setDeliveryStatus(patch) {
    const current = await getDeliveryStatus();
    await chrome.storage.local.set({
      deliveryStatus: {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  ns.storage = {
    getConfig,
    getQueue,
    setQueue,
    getConsent,
    setConsent,
    getDeliveryStatus,
    setDeliveryStatus,
  };
})(typeof self !== "undefined" ? self : window);
