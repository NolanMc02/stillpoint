// Read the central directory and selected entries, never the complete audiobook.
// Stored M4A data remains a file-backed Blob range instead of a large JS buffer.
const MAX_DIRECTORY = 16 * 1024 * 1024;
const MAX_METADATA = 64 * 1024 * 1024;
const bad = message => { throw new Error(message); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (data, offset) => {
  const value = data.getUint32(offset, true) + data.getUint32(offset + 4, true) * 4294967296;
  if (!Number.isSafeInteger(value)) bad('This ZIP is too large to read safely.');
  return value;
};

async function bytes(file, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) bad('This ZIP is incomplete or damaged. Copy the complete download to your phone and try again.');
  try {
    const result = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (result.length !== length) bad('The selected file could not be read completely.');
    return result;
  } catch (error) {
    if (['NotReadableError', 'NotFoundError', 'SecurityError'].includes(error.name)) bad('The phone could not access this file. In Files, copy the completed ZIP to a new folder under On My iPhone, then choose that copy.');
    throw error;
  }
}

export async function openAudiobookZip(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await bytes(file, tailStart, file.size - tailStart), end = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (end.getUint32(i, true) === 0x06054b50 && i + 22 + end.getUint16(i + 20, true) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) bad('This is not a complete ZIP file. Download or copy the ZIP again; keep it zipped.');
  if (end.getUint16(eocd + 4, true) || end.getUint16(eocd + 6, true)) bad('Split ZIP files are not supported. Choose a complete, single ZIP file.');
  let count = end.getUint16(eocd + 10, true), size = end.getUint32(eocd + 12, true), offset = end.getUint32(eocd + 16, true);
  if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) {
    const locator = view(await bytes(file, tailStart + eocd - 20, 20));
    if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) bad('This ZIP64 directory is not supported.');
    const record = view(await bytes(file, u64(locator, 8), 56));
    if (record.getUint32(0, true) !== 0x06064b50 || record.getUint32(16, true) || record.getUint32(20, true)) bad('This ZIP64 directory is damaged.');
    count = u64(record, 32); size = u64(record, 40); offset = u64(record, 48);
  }
  if (size > MAX_DIRECTORY || count > 8192) bad('This ZIP has too many entries. Use a continuous M4A export from Studio.');
  const directory = await bytes(file, offset, size), central = view(directory), entries = new Map();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || central.getUint32(cursor, true) !== 0x02014b50) bad('This ZIP has a damaged directory.');
    const nameSize = central.getUint16(cursor + 28, true), extraSize = central.getUint16(cursor + 30, true), commentSize = central.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > size) bad('This ZIP has an incomplete directory.');
    const name = new TextDecoder().decode(directory.subarray(cursor + 46, cursor + 46 + nameSize));
    if (entries.has(name)) bad('This ZIP contains duplicate filenames. Choose a fresh copy of the ZIP.');
    const entry = { name, flags: central.getUint16(cursor + 8, true), method: central.getUint16(cursor + 10, true),
      crc: central.getUint32(cursor + 16, true), compressedSize: central.getUint32(cursor + 20, true),
      size: central.getUint32(cursor + 24, true), offset: central.getUint32(cursor + 42, true) };
    if (central.getUint16(cursor + 34, true)) bad('Split ZIP entries are not supported.');
    if ([entry.size, entry.compressedSize, entry.offset].includes(0xffffffff)) {
      let extra = cursor + 46 + nameSize, found = false;
      while (extra + 4 <= next - commentSize) {
        const length = central.getUint16(extra + 2, true);
        if (extra + 4 + length > cursor + 46 + nameSize + extraSize) bad('This ZIP64 entry is damaged.');
        if (central.getUint16(extra, true) === 1) {
          let p = extra + 4, limit = p + length;
          for (const field of ['size', 'compressedSize', 'offset']) if (entry[field] === 0xffffffff) {
            if (p + 8 > limit) bad('This ZIP64 entry is incomplete.');
            entry[field] = u64(central, p); p += 8;
          }
          found = true; break;
        }
        extra += 4 + length;
      }
      if (!found) bad('This ZIP64 entry is missing its sizes.');
    }
    entries.set(name, entry); cursor = next;
  }

  async function range(name) {
    const entry = entries.get(name);
    if (!entry) bad(`This ZIP is missing ${name}.`);
    if (entry.flags & 1) bad('Password-protected ZIPs are not supported.');
    const header = view(await bytes(file, entry.offset, 30));
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== entry.method) bad('A ZIP entry is damaged.');
    const nameSize = header.getUint16(26, true), extraSize = header.getUint16(28, true);
    const localName = new TextDecoder().decode(await bytes(file, entry.offset + 30, nameSize));
    if (localName !== name) bad('A ZIP filename does not match its directory.');
    const start = entry.offset + 30 + nameSize + extraSize;
    if (start + entry.compressedSize > offset) bad('A ZIP entry is incomplete.');
    return { entry, data: file.slice(start, start + entry.compressedSize) };
  }

  async function smallEntry(name) {
    const { entry, data } = await range(name);
    if (entry.size > MAX_METADATA || entry.compressedSize > MAX_METADATA) bad('This compressed audiobook entry is too large for safe phone import. Use Studio’s original M4A ZIP export, or generate a shorter chapter selection.');
    if (![0, 8].includes(entry.method)) bad('This ZIP compression format is not supported.');
    if (!window.JSZip) bad('The ZIP reader did not load. Check for an app update and try again.');
    // Give JSZip a single small entry with fresh offsets, not the entire archive.
    const filename = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + filename.length), l = view(local);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(8, entry.method, true);
    l.setUint32(14, entry.crc, true); l.setUint32(18, entry.compressedSize, true); l.setUint32(22, entry.size, true); l.setUint16(26, filename.length, true); local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length), c = view(central);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, entry.method, true);
    c.setUint32(16, entry.crc, true); c.setUint32(20, entry.compressedSize, true); c.setUint32(24, entry.size, true); c.setUint16(28, filename.length, true); central.set(filename, 46);
    const footer = new Uint8Array(22), f = view(footer);
    f.setUint32(0, 0x06054b50, true); f.setUint16(8, 1, true); f.setUint16(10, 1, true); f.setUint32(12, central.length, true); f.setUint32(16, local.length + data.size, true);
    try {
      const zip = await window.JSZip.loadAsync(await new Blob([local, data, central, footer]).arrayBuffer(), { checkCRC32: true });
      return zip.file(name);
    } catch { bad(`The audiobook entry ${name} is damaged. Copy the original ZIP again.`); }
  }

  return {
    has: name => entries.has(name),
    size: name => entries.get(name)?.size,
    crc: name => entries.get(name)?.crc,
    async json(name) { return JSON.parse(await (await smallEntry(name)).async('string')); },
    async audio(name, { signal, progress = () => {} } = {}) {
      const { entry, data } = await range(name);
      if (entry.method === 0) {
        if (entry.size !== entry.compressedSize) bad('The audio entry has invalid sizes.');
        return data;
      }
      // Older library backups DEFLATE-compressed the audio too. Inflate those
      // incrementally; handing the complete entry to JSZip exhausts phone RAM.
      if (entry.method === 8 && (entry.size > MAX_METADATA || entry.compressedSize > MAX_METADATA)) {
        let decoder;
        try { decoder = new DecompressionStream('deflate-raw'); }
        catch { bad('This older backup has large compressed audio. Restore it in an updated desktop browser, then save a new backup for your phone.'); }
        const reader = data.stream().pipeThrough(decoder).getReader(), parts = [];
        let batch = [], batchSize = 0, total = 0;
        try {
          for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > entry.size) bad('A compressed audio entry has invalid sizes.');
            batch.push(value); batchSize += value.byteLength;
            if (batchSize >= 8 * 1024 * 1024) { parts.push(new Blob(batch)); batch = []; batchSize = 0; }
            progress(total, entry.size);
          }
          if (total !== entry.size) bad('A compressed audio entry is incomplete.');
          if (batch.length) parts.push(new Blob(batch));
          return new Blob(parts);
        } finally { await reader.cancel().catch(() => {}); }
      }
      return (await smallEntry(name)).async('blob');
    },
  };
}
