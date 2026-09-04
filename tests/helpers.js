const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function loadLibrary(relativePath) {
  const context = vm.createContext({
    URL,
    console,
    crypto: webcrypto,
    Date,
    Map,
    Uint8Array,
  });
  context.self = context;
  context.window = context;
  const filename = path.join(__dirname, "..", relativePath);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.MeetVcon;
}

module.exports = { loadLibrary };
