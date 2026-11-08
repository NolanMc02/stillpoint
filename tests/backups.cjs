// Large backup buffers, restore safety, cancellation, and legacy compatibility.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium, webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stillpoint-backups-'));
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  let browser;
  try {
    const options = { ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' };
    const context = await engine.launchPersistentContext(temporary, { headless: true, ...options,
      ...(engine === chromium ? { executablePath: process.env.CHROME_PATH } : {}) });
    browser = context;
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**/*', r => r.abort());
    await page.route('http://localhost:8123/**', route => {
      let file = path.resolve(root, `.${new URL(route.request().url()).pathname}`);
      if (!file.startsWith(root + path.sep)) file = path.join(root, 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      return route.fulfill({ status: fs.existsSync(file) ? 200 : 404, body: fs.existsSync(file) ? fs.readFileSync(file) : '', contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto('http://localhost:8123/'); await page.waitForSelector('#empty-add');
    const reports = await page.evaluate(async () => {
      const db = await import('/js/db.js'), backup = await import('/js/backups.js');
      const { createNarrationJob } = await import('/js/narration.js');
      const { writeBackupZip } = await import('/js/backup-zip.js');
      const reports = [], check = (label, yes) => { if (!yes) throw Error(label); reports.push(label); };
      const book = { id: 'backup-test', title: 'Large original test', author: '', pos: 1, wordCount: 2, bookmarks: [{ word: 1, label: 'Saved' }], chapters: [], readerMode: 'listen' };
      const content = { id: book.id, blocks: [{ sid: 'p1', k: 'p', t: 'Hello world.' }] };
      const job = await createNarrationJob(book, content);
      const manifest = { format: 'stillpoint-audiobook', version: 1, tokenizer: job.tokenizer, textHash: job.textHash, playback: 'continuous', clips: [{ file: 'audio/clip-0.m4a', durationMs: 1000, words: [{ sid: 'p1', offset: 0, startMs: 0, endMs: 400 }, { sid: 'p1', offset: 1, startMs: 500, endMs: 1000 }] }] };
      const chunk = new Blob([new Uint8Array(1024 * 1024)]);
      const huge = new Blob(Array(416).fill(chunk), { type: 'audio/mp4' });
      const original = Blob.prototype.arrayBuffer; let largest = 0;
      Blob.prototype.arrayBuffer = function () { largest = Math.max(largest, this.size); if (this.size > 8 * 1024 * 1024 + 65536) throw Error('Oversized JS buffer: ' + this.size); return original.call(this); };
      try {
        await db.saveGeneratedBook(book, content, manifest, [{ file: manifest.clips[0].file, data: huge }]);
        await db.put('sessions', { bookId: book.id, at: 123, words: 2, ms: 1000 });
        let updates = 0;
        const archive = await backup.createBackup({ backupNarration: true, backupTracks: false }, { progress: () => updates++ });
        check('416 MiB backup uses bounded buffers and reports progress', archive.size > huge.size && largest <= 8 * 1024 * 1024 + 65536 && updates > 50);
        window.__backup = archive;
        const plan = await backup.inspectBackup(archive);
        check('large restore preview finds book and audiobook without changing storage', plan.books.length === 1 && plan.books[0].book.pos === 1 && (await db.get('books', book.id)).pos === 1);
        const newer = { ...book, pos: 0, bookmarks: [{ word: 0, label: 'Newer' }] };
        await db.saveBook(newer, content);
        const skip = await backup.restoreBackup(plan);
        check('default restore preserves existing progress and bookmarks', skip.skipped === 1 && (await db.get('books', book.id)).bookmarks[0].label === 'Newer');
        const oldKeys = (await db.getAll('narrationdata')).map(r => r.id).sort().join('|');
        const controller = new AbortController(); let canceled = false;
        try { await backup.restoreBackup(plan, { replace: true, signal: controller.signal, progress: (label, n) => { if (label.startsWith('Restoring') && n > 8 * 1024 * 1024) controller.abort(); } }); } catch (e) { canceled = e.name === 'AbortError'; }
        check('canceled audio restore rolls back current book and keeps its working audio', canceled && (await db.get('books', book.id)).pos === 0 && (await db.readNarrationAudio(book.id, manifest.clips[0].file)).size === huge.size && (await db.getAll('narrationdata')).map(r => r.id).sort().join('|') === oldKeys);
        const restored = await backup.restoreBackup(plan, { replace: true });
        check('complete large restore replaces book and audio together', restored.restored === 1 && (await db.get('books', book.id)).pos === 1 && (await db.readNarrationAudio(book.id, manifest.clips[0].file)).size === huge.size);
        check('repeated restores merge reading history without duplicates', (await db.getAll('sessions')).length === 1);
        const small = await backup.createBackup({ backupNarration: false, backupTracks: false });
        const zip = await window.JSZip.loadAsync(await small.arrayBuffer(), { checkCRC32: true });
        check('new backups are standard ZIPs with verifiable CRCs', !!zip.file('stillpoint.json') && !!zip.file('books/backup-test.json'));
        const textPlan = await backup.inspectBackup(small);
        await backup.restoreBackup(textPlan, { replace: true });
        check('text-only replacement clears stale narration and Listen mode', !(await db.get('narrations', book.id)) && !(await db.get('books', book.id)).audioReady && (await db.get('books', book.id)).readerMode === 'read');
        const v1 = new window.JSZip();
        v1.file('stillpoint.json', JSON.stringify({ app: 'stillpoint', version: 1, books: [book], narrationIds: [book.id], sessions: [], tracks: [] }));
        v1.file(`books/${book.id}.json`, JSON.stringify(content));
        v1.file(`narrations/${book.id}.json`, JSON.stringify(manifest));
        v1.file(`narrations/${book.id}/audio/clip-0.m4a`, new Uint8Array([1, 2, 3]));
        const legacy = await backup.inspectBackup(await v1.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
        await backup.restoreBackup(legacy, { replace: true });
        check('legacy compressed v1 backups still restore', (await db.readNarrationAudio(book.id, manifest.clips[0].file)).size === 3);
        v1.file(`narrations/${book.id}/audio/clip-0.m4a`, new Uint8Array(66 * 1024 * 1024));
        const oldLarge = await backup.inspectBackup(await v1.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } }));
        await backup.restoreBackup(oldLarge, { replace: true });
        check('large compressed legacy audio inflates incrementally', (await db.readNarrationAudio(book.id, manifest.clips[0].file)).size === 66 * 1024 * 1024);
        await backup.restoreBackup(legacy, { replace: true });

        const data = { ...legacy.data, version: 2 };
        const entries = [ { name: 'stillpoint.json', data: new Blob([JSON.stringify(data)]) }, { name: `books/${book.id}.json`, data: new Blob([JSON.stringify(content)]) }, { name: `narrations/${book.id}.json`, data: new Blob([JSON.stringify(manifest)]) }, { name: `narrations/${book.id}/audio/clip-0.m4a`, data: new Blob([new Uint8Array([1, 2, 3])]) } ];
        const valid = await writeBackupZip(entries);
        const bytes = new Uint8Array(await valid.arrayBuffer());
        // Locate the unique three-byte payload immediately before the central directory.
        const signature = bytes.findIndex((_, i) => bytes[i] === 1 && bytes[i + 1] === 2 && bytes[i + 2] === 3); bytes[signature] = 9;
        let failed = false;
        try { await backup.restoreBackup(await backup.inspectBackup(new Blob([bytes])), { replace: true }); } catch (e) { failed = e.message.includes('damaged'); }
        check('corrupt audio CRC fails before replacing existing book or audio', failed && (await db.readNarrationAudio(book.id, manifest.clips[0].file)).size === 3);
        entries.pop(); let missing = false;
        try { await backup.inspectBackup(await writeBackupZip(entries)); } catch (e) { missing = e.message.includes('missing'); }
        check('missing audio is rejected during preflight', missing);
      } finally { Blob.prototype.arrayBuffer = original; }
      return reports;
    });
    reports.forEach(r => console.log('PASS ' + r));
    // The actual UI must preview first and retain settings unless explicitly selected.
    await page.reload(); await page.waitForSelector('#go-settings');
    await page.click('#go-settings'); await page.click('[data-page="Library and data"]');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => { window.__sharedSize = files[0].size; } });
    });
    await page.click('[data-a="backup"]'); await page.click('#backup-save');
    await page.waitForFunction(() => __sharedSize > 0);
    console.log('PASS backup save offers the prepared file to the share sheet');
    await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new Error('Share unavailable'); } }); });
    const download = page.waitForEvent('download'); await page.click('#backup-save');
    const downloaded = await download;
    assert.ok(fs.statSync(await downloaded.path()).size > 0);
    console.log('PASS failed native sharing falls back to a downloadable ZIP');
    await page.click('[data-close]'); await page.click('#go-settings'); await page.click('[data-page="Library and data"]');

    const payload = await page.evaluate(async () => Array.from(new Uint8Array(await (await (await import('/js/backups.js')).createBackup({ backupNarration: false, backupTracks: false })).arrayBuffer())));
    await page.setInputFiles('#restore', { name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from(payload) });
    await page.waitForSelector('#restore-start');
    assert.equal(await page.isChecked('#restore-replace'), false); assert.equal(await page.isChecked('#restore-settings'), false);
    console.log('PASS restore UI previews contents with safe defaults');
    assert.deepEqual(errors, []);
    console.log(`${reports.length + 3} backup checks passed in ${engine === webkit ? 'WebKit' : 'Chrome'}`);
  } finally { await browser?.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
