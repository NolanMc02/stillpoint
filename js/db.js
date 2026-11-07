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
    tx.onerror = event => reject(event.target.error || tx.error);
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
  return saveNarrationBundle(bookId, manifest, audio);
}

// WebKit cannot reliably persist a File-backed Blob slice. Materialize only one
// small part at a time, stage it on disk, then publish all pointers atomically.
// Existing narration stays usable until that final transaction commits.
const AUDIO_PART_SIZE = 8 * 1024 * 1024;
async function saveNarrationBundle(bookId, manifest, audio, book, content, onProgress = () => {}) {
  const staged = [], records = [];
  const total = audio.reduce((sum, clip) => sum + clip.data.size, 0);
  let written = 0;
  try {
    for (const clip of audio) {
      const id = `${bookId}:${clip.file}`, parts = Math.ceil(clip.data.size / AUDIO_PART_SIZE);
      const prefix = `${id}:stage:${crypto.randomUUID()}`;
      for (let part = 0; part < parts; part++) {
        const start = part * AUDIO_PART_SIZE;
        const buffer = await clip.data.slice(start, Math.min(clip.data.size, start + AUDIO_PART_SIZE)).arrayBuffer();
        const data = new Blob([buffer], { type: clip.data.type });
        if (parts === 1) records.push({ id, bookId, data });
        else {
          const key = `${prefix}:part:${part}`;
          staged.push(key);
          await put('narrationdata', { id: key, bookId, data });
        }
        written += data.size; onProgress(written, total);
      }
      if (parts !== 1) records.push({ id, bookId, parts, partPrefix: prefix, size: clip.data.size, type: clip.data.type });
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(book ? ['books', 'contents', 'narrations', 'narrationdata'] : ['narrations', 'narrationdata'], 'readwrite');
      const store = tx.objectStore('narrationdata'), keep = new Set(staged);
      const request = store.index('bookId').openCursor(IDBKeyRange.only(bookId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { if (!keep.has(cursor.primaryKey)) cursor.delete(); cursor.continue(); return; }
        for (const record of records) store.put(record);
        tx.objectStore('narrations').put({ id: bookId, manifest });
        if (book) { tx.objectStore('books').put(book); tx.objectStore('contents').put(content); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = event => reject(event.target.error || tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    // Failed writes never publish a partial book or replace working narration.
    await Promise.all(staged.map(key => del('narrationdata', key))).catch(() => {});
    throw error;
  }
}

export async function readNarrationAudio(bookId, file) {
  const id = `${bookId}:${file}`, record = await get('narrationdata', id);
  if (!record) return null;
  if (record.data) return record.data; // Existing imports remain readable.
  if (!Number.isInteger(record.parts) || record.parts < 1) throw new Error('This audiobook’s saved audio index is damaged.');
  const parts = [];
  for (let i = 0; i < record.parts; i++) {
    const part = await get('narrationdata', `${record.partPrefix || id}:part:${i}`);
    if (!part?.data) throw new Error('This audiobook has a missing saved audio part. Import it again.');
    parts.push(part.data);
  }
  const audio = new Blob(parts, { type: record.type });
  if (audio.size !== record.size) throw new Error('This audiobook’s saved audio is incomplete. Import it again.');
  return audio;
}

export function saveGeneratedBook(book, content, manifest, audio, onProgress) {
  return saveNarrationBundle(book.id, manifest, audio, book, content, onProgress);
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
