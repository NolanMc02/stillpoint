// STORE ZIPs retain file-backed Blobs. Only one 8 MiB CRC buffer is in JS memory.
// ZIP64 keeps multi-book libraries readable beyond the 4 GiB ZIP limit.
const CHUNK = 8 * 1024 * 1024, LIMIT = 0xffffffff;
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export async function crcBlob(blob, progress = () => {}, signal) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
    progress(Math.min(blob.size, offset + bytes.length));
    // Let Cancel and progress painting run even for many small entries.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return (crc ^ 0xffffffff) >>> 0;
}
const buffer = size => {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  return { bytes, u16: (o, n) => view.setUint16(o, n, true), u32: (o, n) => view.setUint32(o, n, true),
    u64: (o, n) => { view.setUint32(o, n % 4294967296, true); view.setUint32(o + 4, Math.floor(n / 4294967296), true); } };
};
export async function writeBackupZip(entries, { progress = () => {}, signal } = {}) {
  if (entries.length > 8192) throw new Error('This backup has too many files. Back up a smaller library.');
  const total = entries.reduce((n, e) => n + e.data.size, 0), parts = [], directory = [];
  let offset = 0, checked = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    if (!name.length || name.length > 65535) throw new Error('A backup filename is invalid.');
    const crc = await crcBlob(entry.data, n => progress(checked + n, total), signal);
    checked += entry.data.size;
    const large = entry.data.size >= LIMIT, distant = offset >= LIMIT;
    const extraLength = large ? 20 : 0, size = large ? LIMIT : entry.data.size;
    const local = buffer(30 + name.length + extraLength);
    local.u32(0, 0x04034b50); local.u16(4, large ? 45 : 20); local.u16(6, 0x800);
    local.u32(14, crc); local.u32(18, size); local.u32(22, size); local.u16(26, name.length); local.u16(28, extraLength);
    local.bytes.set(name, 30);
    if (large) { const p = 30 + name.length; local.u16(p, 1); local.u16(p + 2, 16); local.u64(p + 4, entry.data.size); local.u64(p + 12, entry.data.size); }
    const centralExtra = large || distant ? 4 + (large ? 16 : 0) + (distant ? 8 : 0) : 0;
    const central = buffer(46 + name.length + centralExtra);
    central.u32(0, 0x02014b50); central.u16(4, 45); central.u16(6, large || distant ? 45 : 20); central.u16(8, 0x800);
    central.u32(16, crc); central.u32(20, size); central.u32(24, size); central.u16(28, name.length); central.u16(30, centralExtra); central.u32(42, distant ? LIMIT : offset);
    central.bytes.set(name, 46);
    if (centralExtra) {
      let p = 46 + name.length; central.u16(p, 1); central.u16(p + 2, centralExtra - 4); p += 4;
      if (large) { central.u64(p, entry.data.size); central.u64(p + 8, entry.data.size); p += 16; }
      if (distant) central.u64(p, offset);
    }
    parts.push(local.bytes, entry.data); directory.push(central.bytes);
    offset += local.bytes.length + entry.data.size;
  }
  const directorySize = directory.reduce((n, e) => n + e.length, 0);
  parts.push(...directory);
  const zip64 = offset >= LIMIT || directorySize >= LIMIT;
  if (zip64) {
    const record = buffer(56), locator = buffer(20);
    record.u32(0, 0x06064b50); record.u64(4, 44); record.u16(12, 45); record.u16(14, 45);
    record.u64(24, entries.length); record.u64(32, entries.length); record.u64(40, directorySize); record.u64(48, offset);
    locator.u32(0, 0x07064b50); locator.u64(8, offset + directorySize); locator.u32(16, 1);
    parts.push(record.bytes, locator.bytes);
  }
  const end = buffer(22); end.u32(0, 0x06054b50); end.u16(8, entries.length); end.u16(10, entries.length);
  end.u32(12, directorySize >= LIMIT ? LIMIT : directorySize); end.u32(16, offset >= LIMIT ? LIMIT : offset);
  parts.push(end.bytes);
  signal?.throwIfAborted(); progress(total, total);
  return new Blob(parts, { type: 'application/zip' });
}
