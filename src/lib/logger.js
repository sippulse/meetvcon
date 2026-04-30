// Shared logger. Attaches to self.MeetVcon so it's usable from both
// content scripts (where self===window) and the service worker.

(function (root) {
  const ns = (root.MeetVcon = root.MeetVcon || {});
  if (ns.log) return;

  const PREFIX = "[MeetVcon]";
  const DEBUG = true; // flip to false for production builds

  ns.log = {
    debug: (...args) => DEBUG && console.debug(PREFIX, ...args),
    info: (...args) => console.info(PREFIX, ...args),
    warn: (...args) => console.warn(PREFIX, ...args),
    error: (...args) => console.error(PREFIX, ...args),
  };
})(typeof self !== "undefined" ? self : this);
