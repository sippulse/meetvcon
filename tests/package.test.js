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
    manifest.side_panel.default_path,
    manifest.storage.managed_schema,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])]),
    "src/offscreen/offscreen.html",
    "src/offscreen/pcm-worklet.js",
    "src/permissions/microphone.html",
    "src/background/worker-core.mjs",
  ];
  for (const reference of references) {
    assert.equal(fs.existsSync(path.join(root, reference)), true, reference);
  }
});

test("the store zip carries every file the manifest loads, and nothing else", () => {
  const script = fs.readFileSync(path.join(root, "tools", "package.sh"), "utf8");
  const line = script.split("\n").find((entry) => entry.startsWith("python3 -m zipfile -c"));
  assert.ok(line, "tools/package.sh builds the zip");
  const packaged = line.split(/\s+/).slice(5);
  assert.deepEqual(packaged, ["manifest.json", "enterprise-policy.json", "icons", "src"]);

  const referenced = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.action.default_popup,
    manifest.side_panel.default_path,
    manifest.storage.managed_schema,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])]),
    "src/offscreen/offscreen.html",
    "src/permissions/microphone.html",
  ];
  for (const reference of referenced) {
    const root_ = reference.split("/")[0];
    assert.ok(packaged.includes(root_), `${reference} is outside the packaged files`);
  }

  // The store reads the manifest; a mismatch ships the wrong version number.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
});

test("manifest builds in no destination: configured hosts are optional permissions granted at runtime", () => {
  assert.deepEqual(manifest.host_permissions, ["https://meet.google.com/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
});

test("extension pages reference existing local assets", () => {
  for (const htmlPath of [
    "src/options/options.html",
    "src/popup/popup.html",
    "src/sidepanel/sidepanel.html",
    "src/offscreen/offscreen.html",
    "src/permissions/microphone.html",
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
