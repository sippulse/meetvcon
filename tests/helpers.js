const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

// Load one or more browser-style library files (those attaching to
// self.MeetVcon) into a single vm context and return the namespace.
function loadLibraries(relativePaths, globals = {}) {
  const context = vm.createContext({
    URL,
    console,
    crypto: webcrypto,
    Date,
    Map,
    Set,
    Uint8Array,
    ...globals,
  });
  context.self = context;
  context.window = context;
  for (const relativePath of relativePaths) {
    const filename = path.join(__dirname, "..", relativePath);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  }
  return context.MeetVcon;
}

function loadLibrary(relativePath, globals) {
  return loadLibraries([relativePath], globals);
}

module.exports = { loadLibrary, loadLibraries };
