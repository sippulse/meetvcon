// Encrypt sensitive records before they reach chrome.storage.local. The
// non-extractable AES key is kept in the extension's IndexedDB origin.

const DB_NAME = "sipulse-meet-capture";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const KEY_ID = "local-records-v1";
const RECORD_PREFIX = "secureRecord:";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function databaseRequest(mode, operation) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(KEY_STORE, mode);
        const request = operation(tx.objectStore(KEY_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => reject(tx.error);
      })
  );
}

async function getEncryptionKey() {
  let key = await databaseRequest("readonly", (store) => store.get(KEY_ID));
  if (key) return key;

  key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await databaseRequest("readwrite", (store) => store.put(key, KEY_ID));
  return key;
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encrypt(value) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  return {
    version: 1,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decrypt(envelope) {
  if (!envelope || envelope.version !== 1) return null;
  const key = await getEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function storageKey(id) {
  return `${RECORD_PREFIX}${id}`;
}

export async function putSecureRecord(id, value) {
  await chrome.storage.local.set({ [storageKey(id)]: await encrypt(value) });
}

export async function getSecureRecord(id) {
  const key = storageKey(id);
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) return null;
  return decrypt(stored[key]);
}

export async function removeSecureRecord(id) {
  await chrome.storage.local.remove(storageKey(id));
}
