// A sparse, playable 416 MiB M4A ZIP exercises the real import UI and storage.
// Guard against regressions that materialize the complete archive in JS memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const JSZip = require('jszip');
const { chromium, webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '..');
const target = 416 * 1024 * 1024;

async function fixture(destination) {
  const source = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'demo/audiobook.zip')));
  const manifest = JSON.parse(await source.file('audiobook.json').async('string'));
  const job = JSON.parse(fs.readFileSync(path.join(root, 'demo/job.json')));
  const reading = { format: 'stillpoint-reading-book', version: 1, book: job.book,
    content: { blocks: job.blocks.map(b => ({ sid: b.sid, k: 'p', t: b.text })) } };
  const clip = manifest.clips[0], audio = await source.file(clip.file).async('nodebuffer');
  const free = Buffer.alloc(8); free.writeUInt32BE(target - audio.length); free.write('free', 4);
  let crc = zlib.crc32(free, zlib.crc32(audio)), remaining = target - audio.length - free.length;
  const zeros = Buffer.alloc(1024 * 1024);
  while (remaining) { const n = Math.min(remaining, zeros.length); crc = zlib.crc32(zeros.subarray(0, n), crc); remaining -= n; }
  const entries = [
    ['reading-book.json', Buffer.from(JSON.stringify(reading))],
    ['audiobook.json', Buffer.from(JSON.stringify(manifest))],
    [clip.file, audio],
  ];
  const fd = fs.openSync(destination, 'w'), central = [];
  let position = 0;
  try {
    for (const [name, data] of entries) {
      const isAudio = name === clip.file, encoded = Buffer.from(name);
      const packed = isAudio ? data : zlib.deflateRawSync(data);
      const size = isAudio ? target : data.length, packedSize = isAudio ? target : packed.length;
      const checksum = isAudio ? crc : zlib.crc32(data), method = isAudio ? 0 : 8;
      const local = Buffer.alloc(30 + encoded.length);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
      local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packedSize, 18); local.writeUInt32LE(size, 22);
      local.writeUInt16LE(encoded.length, 26); encoded.copy(local, 30);
      fs.writeSync(fd, local, 0, local.length, position);
      fs.writeSync(fd, packed, 0, packed.length, position + local.length);
      if (isAudio) { fs.writeSync(fd, free, 0, free.length, position + local.length + packed.length); fs.ftruncateSync(fd, position + local.length + size); }
      const header = Buffer.alloc(46 + encoded.length);
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(method, 10);
      header.writeUInt32LE(checksum, 16); header.writeUInt32LE(packedSize, 20); header.writeUInt32LE(size, 24);
      header.writeUInt16LE(encoded.length, 28); header.writeUInt32LE(position, 42); encoded.copy(header, 46); central.push(header);
      position += local.length + packedSize;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(position, 16);
    fs.writeSync(fd, directory, 0, directory.length, position); fs.writeSync(fd, end, 0, end.length, position + directory.length);
  } finally { fs.closeSync(fd); }
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stillpoint-large-'));
  let browser;
  try {
    const file = path.join(temporary, 'large-audiobook.zip'); await fixture(file);
    const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
    const options = { ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' };
    // Use normal disk-backed WebKit storage, as in an installed Home Screen app.
    let context;
    if (engine === webkit) {
      context = await engine.launchPersistentContext(path.join(temporary, 'profile'), { headless: true, ...options });
      browser = { close: () => context.close() };
    } else {
      browser = await engine.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
      context = await browser.newContext(options);
    }
    await context.addInitScript(() => {
      window.__reads = [];
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        window.__reads.push(this.size);
        if (this.size > 64 * 1024 * 1024) throw new Error('Whole-file buffer regression');
        return read.call(this);
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    // Do not intercept blob: URLs: WebKit routes native audio through them.
    await page.route('http://localhost:8123/**', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost:8123') return route.abort();
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto('http://localhost:8123/'); await page.click('#empty-add');
    console.log('Importing 416 MiB ZIP…');
    await page.setInputFiles('#file-pick', file);
    try {
      await page.waitForFunction(() => document.querySelector('.book-viewport') || document.body.innerText.includes('A file was not added'), null, { timeout: 120000 });
      assert.ok(await page.locator('.book-viewport').count(), await page.locator('body').innerText());
    }
    catch (error) { console.error(await page.locator('body').innerText(), await page.evaluate(() => window.__reads)); throw error; }
    const saved = await page.evaluate(async () => {
      const db = await import('/js/db.js'), book = (await db.getAll('books'))[0];
      const manifest = (await db.get('narrations', book.id)).manifest;
      const record = await db.get('narrationdata', `${book.id}:${manifest.clips[0].file}`);
      return { record, reads: window.__reads, pending: await db.get('kv', 'pendingAudiobookImport') };
    });
    assert.equal(saved.record.size, target); assert.equal(saved.record.parts, Math.ceil(target / (8 * 1024 * 1024)));
    assert.ok(Math.max(...saved.reads) <= 8 * 1024 * 1024); assert.ok(saved.reads.reduce((a, b) => a + b, 0) < target + 2 * 1024 * 1024);
    console.log('PASS 416 MiB combined ZIP imports with reads bounded to 8 MiB and 52 saved parts');
    await page.reload(); await page.waitForSelector('.book-viewport');
    await page.click('#play');
    try { await page.waitForFunction(() => __stillpoint.R.narration?.audio?.currentTime > .3, null, { timeout: 20000 }); }
    catch (error) { console.error(await page.locator('body').innerText()); throw error; }
    await page.click('#play');
    console.log('PASS persisted 416 MiB audiobook reopens and plays native M4A audio');
    const rollback = await page.evaluate(async () => {
      const db = await import('/js/db.js');
      const data = new Blob([new Uint8Array(17 * 1024 * 1024)], { type: 'audio/mp4' });
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (this.name === 'narrationdata' && record.id.endsWith(':part:1')) {
          // Fail after the first chunk has succeeded, through a normal IDB error.
          return this.add({ ...record, id: record.id.replace(/:1$/, ':0') });
        }
        return originalPut.call(this, record, ...args);
      };
      let rejected = false;
      try { await db.saveGeneratedBook({ id: 'failed-import' }, { id: 'failed-import', blocks: [] }, {}, [{ file: 'test.m4a', data }]); }
      catch (error) { rejected = !!error; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const partial = (await db.getAll('narrationdata')).filter(r => r.bookId === 'failed-import');
      const clean = rejected && !await db.get('books', 'failed-import') && !await db.get('narrations', 'failed-import') && !partial.length;
      await db.saveNarration('replacement', { tag: 'original' }, [{ file: 'old.m4a', data: new Blob(['original']) }]);
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (this.name === 'narrations' && record.id === 'replacement') return this.add(record);
        return originalPut.call(this, record, ...args);
      };
      rejected = false;
      try { await db.saveNarration('replacement', { tag: 'new' }, [{ file: 'new.m4a', data }]); }
      catch (error) { rejected = !!error; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const retained = (await db.get('narrations', 'replacement')).manifest.tag === 'original'
        && await (await db.readNarrationAudio('replacement', 'old.m4a')).text() === 'original'
        && (await db.getAll('narrationdata')).filter(r => r.bookId === 'replacement').length === 1;
      await db.removeNarration('replacement');
      return clean && rejected && retained;
    });
    assert.ok(rollback); console.log('PASS failed chunk writes leave no partial book; failed final commit preserves old narration');
    await page.evaluate(async () => {
      const db = await import('/js/db.js');
      await db.put('narrationdata', { id: 'interrupted:stage:part:0', bookId: 'interrupted', data: new Blob(['unfinished']) });
      await db.put('kv', { name: 'interrupted.zip', bookId: 'interrupted', startedAt: Date.now() }, 'pendingAudiobookImport');
    });
    await page.reload(); await page.waitForSelector('#go-add');
    assert.ok((await page.locator('body').innerText()).includes('Audiobook import interrupted'));
    assert.equal(await page.locator('.book-viewport').count(), 0);
    assert.equal(await page.evaluate(async () => (await import('/js/db.js')).get('narrationdata', 'interrupted:stage:part:0')), undefined);
    console.log('PASS interrupted import cleans unfinished audio and explains recovery without reopening');
    await page.click('[data-close]'); await page.click('#go-add');
    await page.setInputFiles('#file-pick', { name: 'damaged.zip', mimeType: 'application/zip', buffer: Buffer.from('incomplete zip') });
    await page.waitForFunction(() => document.body.innerText.includes('not a complete ZIP'));
    assert.equal(await page.evaluate(async () => (await (await import('/js/db.js')).getAll('books')).length), 1);
    console.log('PASS damaged ZIP reports a useful error and preserves the existing book');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
