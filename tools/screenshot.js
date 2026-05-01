// Generate Chrome Web Store screenshots for the MeetVcon listing.
//
// Captures three views and composites each onto a 1280x800 canvas:
//   1. Options page (configured with sample webhook URL)
//   2. Popup (with seeded recent meetings + queued retry)
//   3. Static in-call panel preview (no real Meet call needed)
//
// Output: ./screenshots/options.png, popup.png, in-call.png
//
// Usage: npm run screenshots

const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = ROOT;
const OUT_DIR = path.join(ROOT, "screenshots");
const RAW_DIR = path.join(OUT_DIR, "_raw");
const USER_DATA = path.join(ROOT, ".playwright-profile");

const TARGET_W = 1280;
const TARGET_H = 800;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.rmSync(USER_DATA, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    viewport: { width: TARGET_W, height: TARGET_H },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-position=0,0",
      `--window-size=${TARGET_W},${TARGET_H}`,
      "--use-gl=swiftshader",
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  }
  const extensionId = serviceWorker.url().split("/")[2];
  console.log("extension id:", extensionId);

  await seedStorage(context, extensionId);

  await captureOptions(context, extensionId);
  await capturePopup(context, extensionId);
  await capturePanel(context);

  await context.close();

  composite("options.raw.png", "options.png");
  composite("popup.raw.png", "popup.png");
  composite("in-call.raw.png", "in-call.png");

  console.log("\nDone. Screenshots written to", OUT_DIR);
}

async function seedStorage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  await page.evaluate(() => {
    const now = Date.now();
    const iso = (offsetMin) => new Date(now - offsetMin * 60_000).toISOString();
    return chrome.storage.local.set({
      config: {
        webhookUrl: "https://api.example.com/v1/meetvcon/webhook",
        bearerToken: "********",
        hmacSecret: "",
        deliveryMode: "periodic_snapshot",
        snapshotIntervalMin: 5,
        includeSpeakerEmail: false,
        includeCapturerEmail: true,
      },
      meetings: [
        {
          uuid: "018f3a1c-2b4d-7e0a-9c11-aa11bb22cc33",
          meetingId: "abc-defg-hij",
          subject: "Acme weekly sync",
          startedAt: iso(35),
          endedAt: iso(2),
          utteranceCount: 142,
          status: "delivered",
        },
        {
          uuid: "018f3a1c-2b4d-7e0a-9c11-aa11bb22cc34",
          meetingId: "klm-nopq-rst",
          subject: "1:1 with Bob",
          startedAt: iso(125),
          endedAt: iso(95),
          utteranceCount: 88,
          status: "delivered",
        },
        {
          uuid: "018f3a1c-2b4d-7e0a-9c11-aa11bb22cc35",
          meetingId: "uvw-xyza-bcd",
          subject: "Standup",
          startedAt: iso(360),
          endedAt: iso(345),
          utteranceCount: 0,
          status: "skipped_no_captions",
        },
      ],
      queue: [
        {
          id: "queue-1",
          vcon: {
            uuid: "018f3a1c-2b4d-7e0a-9c11-aa11bb22cc36",
            subject: "Customer call",
          },
          url: "https://api.example.com/v1/meetvcon/webhook",
          deliveryKind: "final",
          attempts: 2,
          nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          lastError: "HTTP 500",
        },
      ],
    });
  });
  await page.close();
}

async function captureOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(
    `chrome-extension://${extensionId}/src/options/options.html`,
    { waitUntil: "load" }
  );
  await page.bringToFront();
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(RAW_DIR, "options.raw.png"),
    fullPage: false,
  });
  await page.close();
}

async function capturePopup(context, extensionId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto(
    `chrome-extension://${extensionId}/src/popup/popup.html`,
    { waitUntil: "load" }
  );
  await page.bringToFront();
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(RAW_DIR, "popup.raw.png"),
    fullPage: true,
  });
  await page.close();
}

async function capturePanel(context) {
  const page = await context.newPage();
  await page.setViewportSize({ width: TARGET_W, height: TARGET_H });
  const fileUrl = "file://" + path.join(ROOT, "tools", "panel-preview.html");
  await page.goto(fileUrl, { waitUntil: "load" });
  await page.bringToFront();
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(RAW_DIR, "in-call.raw.png"),
    fullPage: false,
  });
  await page.close();
}

// Composite a raw capture onto a 1280x800 canvas with a clean background.
// ImageMagick `convert` is invoked from the shell; available in our WSL env.
function composite(rawName, outName) {
  const raw = path.join(RAW_DIR, rawName);
  const out = path.join(OUT_DIR, outName);
  const bg =
    rawName === "in-call.raw.png"
      ? "none" // keep the panel preview as-is
      : "white";

  if (rawName === "in-call.raw.png") {
    // Already 1280x800 from the panel-preview viewport.
    fs.copyFileSync(raw, out);
    return;
  }

  // Get raw dimensions so we can downscale if larger than canvas.
  const dims = execSync(`identify -format "%wx%h" "${raw}"`).toString().trim();
  const [w, h] = dims.split("x").map(Number);

  // Scale down if the raw is bigger than the target canvas.
  const scaleW = w > TARGET_W ? TARGET_W : w;
  const scaleH = h > TARGET_H ? TARGET_H : h;
  const tmp = path.join(RAW_DIR, "_scaled_" + rawName);
  execSync(
    `convert "${raw}" -resize ${scaleW}x${scaleH}\\> "${tmp}"`,
    { stdio: "inherit" }
  );

  // Place onto centered 1280x800 canvas.
  execSync(
    `convert -size ${TARGET_W}x${TARGET_H} canvas:${bg} ` +
      `"${tmp}" -gravity center -composite "${out}"`,
    { stdio: "inherit" }
  );
  fs.unlinkSync(tmp);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
