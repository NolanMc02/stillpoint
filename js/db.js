// Local storage on the device, using IndexedDB.
const NAME = 'stillpoint';
let db;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 3);
    req.onupgradeneeded = event => {
      const d = req.result;
      if (event.oldVersion < 1) {
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('contents', { keyPath: 'id' });
        d.createObjectStore('kv');
        d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      }
      if (event.oldVersion < 2) {
        // Track details are kept apart from the audio so the list loads without reading every file.
        d.createObjectStore('tracks', { keyPath: 'id' });
        d.createObjectStore('trackdata', { keyPath: 'id' });
      }
      if (event.oldVersion < 3) {
        d.createObjectStore('narrations', { keyPath: 'id' });
        d.createObjectStore('narrationdata', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      }
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
    const tx = db.transaction(['books', 'contents', 'narrations', 'narrationdata'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('contents').delete(id);
    tx.objectStore('narrations').delete(id);
    deleteNarrationData(tx, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteNarrationData(tx, bookId) {
  const request = tx.objectStore('narrationdata').index('bookId').openCursor(IDBKeyRange.only(bookId));
  request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
}

export function saveNarration(bookId, manifest, audio) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['narrations', 'narrationdata'], 'readwrite');
    // Delete existing clips before adding replacements; all requests share one transaction.
    const store = tx.objectStore('narrationdata');
    const request = store.index('bookId').openCursor(IDBKeyRange.only(bookId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); return; }
      for (const clip of audio) store.put({ id: `${bookId}:${clip.file}`, bookId, data: clip.data });
      tx.objectStore('narrations').put({ id: bookId, manifest });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function removeNarration(bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['narrations', 'narrationdata'], 'readwrite');
    tx.objectStore('narrations').delete(bookId);
    deleteNarrationData(tx, bookId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function saveTrack(track, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'trackdata'], 'readwrite');
    tx.objectStore('tracks').put(track);
    tx.objectStore('trackdata').put({ id: track.id, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function deleteTrack(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'trackdata'], 'readwrite');
    tx.objectStore('tracks').delete(id);
    tx.objectStore('trackdata').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
