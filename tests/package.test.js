const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("manifest references existing packaged files", () => {
  const references = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.action.default_popup,
    manifest.storage.managed_schema,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...entry.css]),
    "src/offscreen/offscreen.html",
  ];
  for (const reference of references) {
    assert.equal(fs.existsSync(path.join(root, reference)), true, reference);
  }
});

test("internal manifest has no arbitrary network destination", () => {
  assert.deepEqual(manifest.host_permissions, [
    "https://meet.google.com/*",
    "https://api.sippulse.com/*",
  ]);
  assert.equal("optional_host_permissions" in manifest, false);
});

test("extension pages reference existing local assets", () => {
  for (const htmlPath of [
    "src/options/options.html",
    "src/popup/popup.html",
    "src/offscreen/offscreen.html",
  ]) {
    const html = fs.readFileSync(path.join(root, htmlPath), "utf8");
    const directory = path.dirname(path.join(root, htmlPath));
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value) => !value.startsWith("http"));
    for (const reference of refs) {
      assert.equal(fs.existsSync(path.resolve(directory, reference)), true, `${htmlPath}: ${reference}`);
    }
  }
});
