// Generate private Chrome Web Store screenshots for SipPulse Meet Capture.
//
// Captures three views and composites each onto a 1280x800 canvas:
//   1. Consent and managed-configuration page
//   2. Status-focused popup
//   3. Static in-call panel preview (no real Meet call needed)
//
// Output: ./screenshots/options.png, popup.png, in-call.png
//
// Usage: npm run screenshots

const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");

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

  serviceWorker.on("console", (message) => {
    if (message.type() === "error") {
      console.error("service worker:", message.text());
    }
  });

  await seedStorage(context, extensionId);

  await captureOptions(context, extensionId);
  await capturePopup(context, extensionId);
  await capturePanel(context);

  await composite(context, "options.raw.png", "options.png");
  await composite(context, "popup.raw.png", "popup.png");
  await composite(context, "in-call.raw.png", "in-call.png");

  await context.close();

  console.log("\nDone. Screenshots written to", OUT_DIR);
}

async function seedStorage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  await page.evaluate(() => {
    return chrome.storage.local.set({
      storageSchemaVersion: 2,
      consent: {
        accepted: true,
        acceptedAt: new Date().toISOString(),
        version: 1,
      },
      deliveryStatus: {
        state: "processing",
        source: "sippulse_ai",
        updatedAt: new Date().toISOString(),
      },
      queue: [],
    });
  });
  await page.close();
}

async function captureOptions(context, extensionId) {
  const page = await context.newPage();
  reportPageErrors(page, "options");
  await page.goto(
    `chrome-extension://${extensionId}/src/options/options.html`,
    { waitUntil: "load" }
  );
  await page.bringToFront();
  await page.waitForFunction(
    () => document.getElementById("configuration")?.textContent !== "Checking…",
    { timeout: 5000 }
  );
  await page.screenshot({
    path: path.join(RAW_DIR, "options.raw.png"),
    fullPage: false,
  });
  await page.close();
}

async function capturePopup(context, extensionId) {
  const page = await context.newPage();
  reportPageErrors(page, "popup");
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto(
    `chrome-extension://${extensionId}/src/popup/popup.html`,
    { waitUntil: "load" }
  );
  await page.bringToFront();
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent !== "Checking status…",
    { timeout: 5000 }
  );
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

function reportPageErrors(page, label) {
  page.on("pageerror", (error) => console.error(`${label}:`, error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`${label}:`, message.text());
  });
}

// Composite with Chromium itself so this tool has no system ImageMagick
// dependency beyond the Playwright dependency already used for capture.
async function composite(context, rawName, outName) {
  const raw = path.join(RAW_DIR, rawName);
  const out = path.join(OUT_DIR, outName);

  if (rawName === "in-call.raw.png") {
    // Already 1280x800 from the panel-preview viewport.
    fs.copyFileSync(raw, out);
    return;
  }

  const dataUrl = `data:image/png;base64,${fs.readFileSync(raw).toString("base64")}`;
  const page = await context.newPage();
  await page.setViewportSize({ width: TARGET_W, height: TARGET_H });
  await page.setContent(`
    <!doctype html>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { display: flex; align-items: center; justify-content: center; background: white; }
      img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
    </style>
    <img alt="" src="${dataUrl}">
  `);
  await page.screenshot({ path: out, fullPage: false });
  await page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
