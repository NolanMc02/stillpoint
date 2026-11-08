import * as db from './db.js';
import { openAudiobookZip } from './audiobook-zip.js';
import { crcBlob, writeBackupZip } from './backup-zip.js';
import { createNarrationJob, validateManifest } from './narration.js';
import { selectMode } from './reading-state.js';

const idOK = id => typeof id === 'string' && /^[\w-]+$/.test(id);
const jsonBlob = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const require = (condition, message) => { if (!condition) throw new Error(message); };
export async function createBackup(settings, { signal, progress = () => {} } = {}) {
  const [books, contents, sessions, tracks, narrations] = await Promise.all([
    db.getAll('books'), db.getAll('contents'), db.getAll('sessions'),
    settings.backupTracks ? db.getAll('tracks') : [], settings.backupNarration ? db.getAll('narrations') : [],
  ]);
  const entries = [], keptTracks = [], keptNarrations = narrations.filter(n => books.some(b => b.id === n.id));
  for (const record of keptNarrations) {
    signal?.throwIfAborted(); progress('Collecting audiobooks', 0, 0);
    entries.push({ name: `narrations/${record.id}.json`, data: jsonBlob(record.manifest) });
    for (const clip of record.manifest.clips) {
      const data = await db.readNarrationAudio(record.id, clip.file);
      require(data?.size, 'An audiobook clip is missing. Import it again before backing up.');
      entries.push({ name: `narrations/${record.id}/${clip.file}`, data });
    }
  }
  for (const book of books) {
    const content = contents.find(c => c.id === book.id);
    require(content, `The text for “${book.title}” is missing. The backup was not created.`);
    entries.push({ name: `books/${book.id}.json`, data: jsonBlob(content) });
  }
  for (const track of tracks) {
    signal?.throwIfAborted();
    const record = await db.get('trackdata', track.id);
    require(record, `The background audio “${track.name}” is missing.`);
    entries.push({ name: `tracks/${track.id}.bin`, data: new Blob([record.data]) }); keptTracks.push(track);
  }
  entries.unshift({ name: 'stillpoint.json', data: jsonBlob({ app: 'stillpoint', version: 2, createdAt: Date.now(),
    settings, books, sessions, tracks: keptTracks, narrationIds: keptNarrations.map(n => n.id) }) });
  return writeBackupZip(entries, { signal, progress: (n, total) => progress('Preparing backup', n, total) });
}

// Preflight the complete manifest before offering a restore. Old v1 ZIPs still work.
export async function inspectBackup(file, { signal } = {}) {
  const zip = await openAudiobookZip(file);
  require(zip.has('stillpoint.json'), 'Choose a Stillpoint backup ZIP, rather than an audiobook export.');
  const data = await zip.json('stillpoint.json');
  require(data?.app === 'stillpoint' && [1, 2].includes(data.version), 'This backup version is not supported.');
  require(Array.isArray(data.books) && Array.isArray(data.sessions || []) && Array.isArray(data.tracks || []) && Array.isArray(data.narrationIds || []), 'The backup index is damaged.');
  const ids = new Set(), narrationIds = new Set(data.narrationIds || []), books = [];
  require(narrationIds.size === (data.narrationIds || []).length, 'The backup has duplicate audiobooks.');
  for (const source of data.books) {
    signal?.throwIfAborted();
    require(source && idOK(source.id) && !ids.has(source.id), 'The backup has an invalid or duplicate book ID.');
    ids.add(source.id);
    const content = await zip.json(`books/${source.id}.json`);
    require(content?.id === source.id && Array.isArray(content.blocks) && content.blocks.every(b => b && typeof b.t === 'string'), 'A book’s text is missing or damaged.');
    require(Array.isArray(source.chapters || []) && (source.chapters || []).every(c => c && typeof c.title === 'string' && Number.isInteger(c.block) && c.block >= 0 && c.block < content.blocks.length), 'A book’s chapter index is damaged.');
    require(Array.isArray(source.bookmarks || []), 'A book’s bookmarks are damaged.');
    const book = { ...source, chapters: source.chapters || [], bookmarks: source.bookmarks || [] }, job = await createNarrationJob(book, content);
    book.wordCount = job.blocks.reduce((n, b) => n + b.tokens.length, 0);
    book.pos = Math.min(Math.max(0, Math.floor(Number(book.pos) || 0)), Math.max(0, book.wordCount - 1));
    let manifest = null;
    if (narrationIds.has(book.id)) {
      manifest = validateManifest(await zip.json(`narrations/${book.id}.json`), job);
      for (const clip of manifest.clips) require(zip.size(`narrations/${book.id}/${clip.file}`) > 0, `Audio for “${book.title}” is missing. Nothing has been restored.`);
    } else {
      delete book.audioReady; delete book.audioDurationMs; delete book.audioRemainingMs;
      book.rsvpAudio = false; selectMode(book, book.readerMode === 'rsvp' ? 'rsvp' : 'read');
    }
    books.push({ book, content, manifest });
  }
  require([...narrationIds].every(id => ids.has(id)), 'An audiobook has no matching book in this backup.');
  const trackIds = new Set();
  for (const t of data.tracks || []) {
    require(t && idOK(t.id) && !trackIds.has(t.id) && zip.size(`tracks/${t.id}.bin`) > 0 && zip.size(`tracks/${t.id}.bin`) <= 60 * 1024 * 1024, 'A background audio file is missing or too large.');
    trackIds.add(t.id);
  }
  return { data, books, zip, file };
}

export async function restoreBackup(plan, { replace = false, signal, progress = () => {} } = {}) {
  const { zip, data, books } = plan, result = { restored: 0, skipped: 0, tracks: 0, sessions: 0 };
  const existing = new Set((await db.getAll('books')).map(b => b.id));
  const selected = books.filter(({ book }) => replace || !existing.has(book.id));
  result.skipped = books.length - selected.length;
  for (let i = 0; i < selected.length; i++) {
    signal?.throwIfAborted();
    const { book, content, manifest } = selected[i], audio = [];
    const label = `${i + 1}/${selected.length}: ${book.title || 'Untitled'}`;
    progress(`Checking ${label}`, 0, 0);
    if (manifest) {
      for (const clip of manifest.clips) {
        const name = `narrations/${book.id}/${clip.file}`, blob = await zip.audio(name, { signal,
          progress: (n, total) => progress(`Unpacking ${label}`, n, total) });
        require(await crcBlob(blob, n => progress(`Checking ${label}`, n, blob.size), signal) === zip.crc(name), `Audio for “${book.title}” is damaged. This book was not replaced.`);
        audio.push({ file: clip.file, data: blob });
      }
      await db.saveGeneratedBook(book, content, manifest, audio, (n, total) => {
        signal?.throwIfAborted(); progress(`Restoring ${label}`, n, total); signal?.throwIfAborted();
      });
    } else await db.saveBook(book, content, { clearAudio: true });
    result.restored++;
  }
  const sessionKeys = new Set((await db.getAll('sessions')).map(s => `${s.bookId}|${s.at}`));
  const allBooks = new Set((await db.getAll('books')).map(b => b.id));
  for (const source of data.sessions || []) {
    signal?.throwIfAborted();
    const { id, ...session } = source || {};
    const key = `${session.bookId}|${session.at}`;
    if (!allBooks.has(session.bookId) || !Number.isFinite(session.at) || sessionKeys.has(key)) continue;
    await db.put('sessions', session); sessionKeys.add(key); result.sessions++;
  }
  for (const t of data.tracks || []) {
    signal?.throwIfAborted();
    if (await db.get('tracks', t.id)) continue;
    const name = `tracks/${t.id}.bin`, blob = await zip.audio(name);
    require(await crcBlob(blob, n => progress('Checking background audio', n, blob.size), signal) === zip.crc(name), 'A background audio file is damaged.');
    const clamp = (v, low, high) => Math.min(high, Math.max(low, Number(v) || 1));
    await db.saveTrack({ id: t.id, name: String(t.name || 'Untitled track').slice(0, 60), size: blob.size,
      duration: Number(t.duration) || 0, norm: clamp(t.norm, .1, 8), level: clamp(t.level, .25, 2), addedAt: Number(t.addedAt) || Date.now() }, await blob.arrayBuffer());
    result.tracks++;
  }
  return result;
}
