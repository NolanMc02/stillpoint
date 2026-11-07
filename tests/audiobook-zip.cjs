const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost:8123/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script src="/vendor/jszip.min.js"></script>' });
      const file = path.resolve(root, `.${url.pathname}`);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: fs.readFileSync(file), contentType: 'text/javascript' });
    });
    await page.goto('http://localhost:8123/');
    const read = async (buffer, audio = false) => page.evaluate(async ({ data, audio }) => {
      const { openAudiobookZip } = await import('/js/audiobook-zip.js');
      try {
        const zip = await openAudiobookZip(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))]));
        return audio ? { text: await (await zip.audio('audio/test.wav')).text() } : await zip.json('audiobook.json');
      } catch (error) { return { error: error.message }; }
    }, { data: buffer.toString('base64'), audio });
    for (const compression of ['STORE', 'DEFLATE']) for (const streamFiles of [false, true]) {
      const zip = new JSZip(); zip.file('audiobook.json', '{"test":true}'); zip.file('audio/test.wav', 'test audio');
      const data = await zip.generateAsync({ type: 'nodebuffer', compression, streamFiles });
      assert.deepEqual(await read(data), { test: true }); assert.deepEqual(await read(data, true), { text: 'test audio' });
    }
    console.log('PASS stored/deflated entries and streaming data descriptors decode correctly');
    const zip = new JSZip(); zip.file('audiobook.json', '{"test":true}');
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    const centralOffset = data.readUInt32LE(data.length - 6);
    const central = Buffer.from(data.subarray(centralOffset, data.length - 22));
    const extra = Buffer.alloc(28); extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(central.readUInt32LE(24)), 4); extra.writeBigUInt64LE(BigInt(central.readUInt32LE(20)), 12); extra.writeBigUInt64LE(0n, 20);
    central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24); central.writeUInt32LE(0xffffffff, 42); central.writeUInt16LE(extra.length, 30);
    const directory = Buffer.concat([central, extra]), record = Buffer.alloc(56), locator = Buffer.alloc(20), end = Buffer.from(data.subarray(-22));
    record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32); record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(centralOffset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(centralOffset + directory.length), 8); locator.writeUInt32LE(1, 16);
    end.writeUInt16LE(65535, 8); end.writeUInt16LE(65535, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    assert.deepEqual(await read(Buffer.concat([data.subarray(0, centralOffset), directory, record, locator, end])), { test: true });
    console.log('PASS ZIP64 directory and entry sizes decode correctly');
    const corrupt = Buffer.from(data); corrupt[30 + Buffer.byteLength('audiobook.json')] ^= 1;
    assert.match((await read(corrupt)).error, /damaged/);
    const encrypted = Buffer.from(data); encrypted.writeUInt16LE(1, centralOffset + 8);
    assert.match((await read(encrypted)).error, /Password/);
    assert.match((await read(data.subarray(0, data.length - 10))).error, /complete ZIP/);
    const duplicateEnd = Buffer.from(data.subarray(-22)); duplicateEnd.writeUInt16LE(2, 8); duplicateEnd.writeUInt16LE(2, 10); duplicateEnd.writeUInt32LE(central.length * 2, 12);
    assert.match((await read(Buffer.concat([data.subarray(0, centralOffset), data.subarray(centralOffset, -22), data.subarray(centralOffset, -22), duplicateEnd]))).error, /duplicate/);
    console.log('PASS corrupt metadata, encrypted entries, truncation and duplicate names are rejected');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
