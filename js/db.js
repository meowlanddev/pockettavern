// Minimal IndexedDB wrapper. Everything lives on-device.
const DB_NAME = 'pockettavern';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('characters')) db.createObjectStore('characters', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chats')) {
          const chats = db.createObjectStore('chats', { keyPath: 'id' });
          chats.createIndex('charId', 'charId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function request(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    let result;
    if (r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const get = (store, key) => request(store, 'readonly', (s) => s.get(key));
export const getAll = (store) => request(store, 'readonly', (s) => s.getAll());
export const put = (store, value, key) => request(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => request(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => request(store, 'readwrite', (s) => s.clear());
export const byIndex = (store, index, value) => request(store, 'readonly', (s) => s.index(index).getAll(value));

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}
