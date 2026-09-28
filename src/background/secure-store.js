// Obfuscate sensitive records before they reach chrome.storage.local.
//
// Honest scope: the AES-GCM key is a non-extractable CryptoKey kept in the
// extension's IndexedDB. "Non-extractable" only restricts JavaScript; Chromium
// still serializes the key bytes to disk in the same profile directory as the
// ciphertext. This stops casual reading of chrome.storage.local (backups,
// sync dumps, devtools of another extension) but does NOT protect against an
// attacker with access to the Chrome profile on disk.

const DB_NAME = "sipulse-meet-capture";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const KEY_ID = "local-records-v1";
const RECORD_PREFIX = "secureRecord:";

let keyPromise = null;

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

// Single in-flight promise so concurrent first calls cannot generate two keys
// and leave records encrypted with a key that was then overwritten.
function getEncryptionKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await databaseRequest("readonly", (store) => store.get(KEY_ID));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      await databaseRequest("readwrite", (store) => store.put(key, KEY_ID));
      return key;
    })().catch((error) => {
      keyPromise = null;
      throw error;
    });
  }
  return keyPromise;
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
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
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

// A record that no longer decrypts (key lost, storage corrupted) is dropped
// rather than left to fail every read forever.
export async function getSecureRecord(id) {
  const key = storageKey(id);
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) return null;
  try {
    return await decrypt(stored[key]);
  } catch (error) {
    console.warn("[SipPulse Meet] dropping unreadable secure record", id, error);
    await chrome.storage.local.remove(key);
    return null;
  }
}

export async function removeSecureRecord(id) {
  await chrome.storage.local.remove(storageKey(id));
}

export const secureStore = {
  get: getSecureRecord,
  put: putSecureRecord,
  remove: removeSecureRecord,
};
