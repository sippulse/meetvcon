// Minimal in-memory chrome.* stand-in for worker-core tests.

function storageArea() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    },
    _dump: () => data,
  };
}

function createFakeChrome(options = {}) {
  const alarms = new Map();
  const runtimeMessages = [];
  const tabMessages = [];
  const state = { offscreenOpen: false, email: "ana@sippulse.com", ...options };

  return {
    _state: state,
    storage: { local: storageArea(), session: storageArea(), managed: storageArea() },
    alarms: {
      create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        alarms.delete(name);
      },
      _alarms: alarms,
    },
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (state.onRuntimeMessage) return state.onRuntimeMessage(message);
        return { ok: true };
      },
      async getContexts() {
        return state.offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      getURL: (path) => `chrome-extension://test/${path}`,
      _messages: runtimeMessages,
    },
    offscreen: {
      async createDocument() {
        state.offscreenOpen = true;
      },
      async closeDocument() {
        state.offscreenOpen = false;
      },
    },
    tabs: {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
      },
      _messages: tabMessages,
    },
    tabCapture: {
      async getMediaStreamId({ targetTabId }) {
        return `stream-for-tab-${targetTabId}`;
      },
    },
    permissions: {
      // Every origin is granted unless the test lists the missing ones.
      async contains({ origins }) {
        return !origins.some((origin) => (state.missingOrigins || []).includes(origin));
      },
    },
    identity: {
      async getProfileUserInfo() {
        return state.email ? { email: state.email, id: "profile-1" } : {};
      },
    },
  };
}

function createFakeSecureStore() {
  const records = new Map();
  return {
    async get(id) {
      return records.has(id) ? structuredClone(records.get(id)) : null;
    },
    async put(id, value) {
      records.set(id, structuredClone(value));
    },
    async remove(id) {
      records.delete(id);
    },
    _records: records,
  };
}

function createFakeFetch(responder = () => ({ status: 200 })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const outcome = await responder(url, init, calls.length);
    if (outcome instanceof Error) throw outcome;
    const status = outcome.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => outcome.body || {} };
  };
  fetch.calls = calls;
  return fetch;
}

module.exports = { createFakeChrome, createFakeSecureStore, createFakeFetch };
