// Local storage on the device, using IndexedDB.
const NAME = 'stillpoint';
let db;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('contents', { keyPath: 'id' });
      d.createObjectStore('kv');
      d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function run(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = store => run(store, 'readonly', s => s.getAll());
export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const clear = store => run(store, 'readwrite', s => s.clear());

export function saveBook(book, content) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'contents'], 'readwrite');
    tx.objectStore('books').put(book);
    tx.objectStore('contents').put(content);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function deleteBook(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'contents'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('contents').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
