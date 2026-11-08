const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium, webkit, devices } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const check = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`); };
function tone(seconds) {
  const rate = 8000, samples = Math.ceil(seconds * rate), b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 500), 44 + i * 2);
  return b;
}
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stillpoint-upgrades-'));
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  let browser, context;
  try {
    const options = { ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'no-preference' };
    if (engine === webkit) { context = await webkit.launchPersistentContext(temporary, { headless: true, ...options }); browser = { close: () => context.close() }; }
    else { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH }); context = await browser.newContext(options); }
    await context.addInitScript(() => {
      window.__testHidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__testHidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.__testHidden ? 'hidden' : 'visible' });
      window.__setHidden = hidden => { window.__testHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    await page.route('http://localhost:8123/**', route => {
      const url = new URL(route.request().url());
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    const shot = async name => { if (process.env.SHOTS) { await page.waitForTimeout(500); fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }); } };
    await page.goto('http://localhost:8123/'); await page.waitForSelector('#empty-add');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 450;
      const c = canvas.getContext('2d'); c.fillStyle = '#1b4545'; c.fillRect(0, 0, 300, 450);
      c.strokeStyle = '#c1ad77'; c.strokeRect(22, 22, 256, 406); c.fillStyle = '#eee8d8'; c.font = '32px Georgia';
      c.fillText('The Quiet', 50, 150); c.fillText('River', 50, 193); c.font = '15px Georgia'; c.fillText('ORIGINAL TEST BOOK', 50, 340);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const epub = async kind => {
      const z = new JSZip(); z.file('mimetype', 'application/epub+zip');
      z.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
      const marker = kind === 3 ? 'properties="cover-image"' : '';
      const legacy = kind === 2 ? '<meta name="cover" content="art"/>' : '';
      const guide = kind === 1 ? '<guide><reference type="cover" href="cover.xhtml"/></guide>' : '';
      z.file('OEBPS/book.opf', `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>The Quiet River</dc:title><dc:creator>Original test book</dc:creator>${legacy}</metadata><manifest><item id="art" href="art/front.png" media-type="image/png" ${marker}/><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine>${guide}</package>`);
      z.file('OEBPS/cover.xhtml', '<html><body><img src="art/front.png"/></body></html>');
      z.file('OEBPS/art/front.png', Buffer.from(png, 'base64'));
      z.file('OEBPS/chapter.xhtml', `<html><body><h1>Chapter One</h1>${Array.from({ length: 50 }, () => '<p>The quiet river moved slowly beneath the bridge. We watched the light turn gold along the distant shore.</p>').join('')}</body></html>`);
      return z.generateAsync({ type: 'nodebuffer' });
    };
    for (const kind of [3, 2, 1]) {
      const cover = await page.evaluate(async bytes => {
        const { importFile } = await import('/js/importers.js');
        const parsed = await importFile(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], 'cover.epub'));
        return { cover: parsed.cover, source: parsed.cleanup.source.cover };
      }, (await epub(kind)).toString('base64'));
      check(`EPUB ${kind === 3 ? '3 cover-image' : kind === 2 ? '2 cover metadata' : 'guide cover page'} survives cleanup`, cover.cover?.startsWith('data:image/jpeg;base64,') && cover.cover === cover.source && cover.cover.length < 600000);
    }
    await page.click('#empty-add'); await page.setInputFiles('#file-pick', { name: 'river.epub', mimeType: 'application/epub+zip', buffer: await epub(3) });
    await page.click('#book-add'); await page.waitForSelector('#reader');
    await page.click('#r-back'); await page.waitForSelector('.book-cover img');
    await page.waitForFunction(() => document.querySelector('.book-cover img').naturalWidth > 0);
    check('library shows locally stored cover artwork', await page.locator('.book-row .book-cover img').count() === 1); await shot('library-covers');
    await page.click('.book-title'); await page.waitForSelector('#reader');
    await page.click('#r-mode'); await page.click('[data-mode="rsvp"]'); await page.click('[data-close]');
    await page.click('#r-settings'); await page.waitForSelector('#set-body');
    check('settings has five clear groups', await page.locator('.set-nav').count() === 5); await shot('settings');
    await page.click('[data-page="RSVP"]');
    check('detailed RSVP controls are collapsed by default', await page.locator('.settings-advanced[open]').count() === 0);
    const anchor = await page.locator('#w-pivot').evaluate(el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
    await page.check('#s-contextWords'); await page.click('[data-close]');
    await page.evaluate(() => { const { R, S } = __stillpoint; R.pos = 8; S.countdown = 0; S.ramp = 0; R.wpm = 50; dispatchEvent(new Event('resize')); });
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    const wordContext = await page.evaluate(() => {
      const r = __stillpoint.R, before = document.querySelector('#context-before'), after = document.querySelector('#context-after');
      const left = document.querySelector('#w-left').getBoundingClientRect(), right = document.querySelector('#w-right').getBoundingClientRect();
      return { previous: before.textContent, next: after.textContent, expectedBefore: r.words.slice(r.pos - 2, r.pos).join(' '), expectedAfter: r.words.slice(r.pos + 1, r.pos + 3).join(' '),
        overlap: before.getBoundingClientRect().right > left.left || after.getBoundingClientRect().left < right.right,
        pivot: document.querySelector('#w-pivot').getBoundingClientRect().left + document.querySelector('#w-pivot').getBoundingClientRect().width / 2 };
    });
    check('RSVP context shows the adjacent words without overlap', wordContext.previous === wordContext.expectedBefore && wordContext.next === wordContext.expectedAfter && !wordContext.overlap);
    check('context preserves the fixed focus position', Math.abs(wordContext.pivot - anchor) < 1); await shot('rsvp-context');
    await page.locator('#stage').tap({ position: { x: 200, y: 400 } });
    const job = await page.evaluate(async () => {
      const { R, S } = __stillpoint; R.pos = 0; S.sound = 'brown'; S.volume = .15;
      const { createNarrationJob } = await import('/js/narration.js'); return createNarrationJob(R.book, { blocks: R.blocks });
    });
    const words = job.blocks.flatMap(b => b.tokens.map((_, offset) => ({ sid: b.sid, offset })));
    const zip = new JSZip(), durationMs = words.length * 35 + 200;
    zip.file('audio/clip-00000.wav', tone(durationMs / 1000));
    zip.file('audiobook.json', JSON.stringify({ format: 'stillpoint-audiobook', version: 1, tokenizer: job.tokenizer, textHash: job.textHash, playback: 'continuous', clips: [{ file: 'audio/clip-00000.wav', durationMs, words: words.map((w, i) => ({ ...w, startMs: i * 35, endMs: (i + 1) * 35 })) }] }));
    await page.click('#r-mode'); await page.click('#mode-audiobook'); await page.setInputFiles('#narration-import', { name: 'audio.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
    await page.waitForFunction(() => !!__stillpoint.R.narration && !document.querySelector('#narration-import'));
    await page.waitForFunction(() => !document.documentElement.dataset.nav);
    await page.waitForTimeout(300);
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.narration.audio.currentTime > .4);
    const both = await page.evaluate(async () => ({ sound: (await import('/js/sounds.js')).soundState(), audio: !__stillpoint.R.narration.audio.paused }));
    check('narration and background sound play together', both.audio && both.sound.running && both.sound.playing === 'brown');
    await page.evaluate(() => window.__setHidden(true)); await page.waitForTimeout(350);
    check('simulated screen hiding keeps both sources active', await page.evaluate(async () => !__stillpoint.R.narration.audio.paused && (await import('/js/sounds.js')).soundState().playing === 'brown'));
    await page.evaluate(() => window.__setHidden(false));
    await page.click('#play'); await page.waitForTimeout(100);
    check('Pause stops reading-only background sound', await page.evaluate(async () => __stillpoint.R.narration.audio.paused && (await import('/js/sounds.js')).soundState().playing === 'off'));
    await page.evaluate(() => { __stillpoint.R.book.bookLayout = 'scroll'; __stillpoint.R.pos = 0; });
    await page.click('#r-mode'); await page.click('[data-mode="listen"]'); await page.click('[data-close]'); await page.waitForSelector('.book-viewport');
    await page.click('#play');
    const motion = await page.evaluate(async () => {
      const viewport = document.querySelector('.book-viewport'), samples = [viewport.scrollTop], started = performance.now();
      await new Promise(resolve => {
        const frame = () => { samples.push(viewport.scrollTop); if (performance.now() - started > 6000) resolve(); else requestAnimationFrame(frame); }; frame();
      });
      return { delta: Math.max(...samples.slice(1).map((n, i) => Math.abs(n - samples[i]))), range: Math.max(...samples) - Math.min(...samples), state: __stillpoint.R.state };
    });
    check('listen-and-follow scrolls in small eased steps without pausing itself', motion.range > 40 && motion.delta < 50 && motion.state === 'playing');
    await shot('smooth-follow'); await page.click('#play');
    await page.click('#r-back'); await page.waitForSelector('.book-cover img');
    await page.click('[data-more]'); await page.setInputFiles('#cover-pick', { name: 'original.epub', mimeType: 'application/epub+zip', buffer: await epub(2) });
    await page.waitForSelector('.book-cover img');
    check('existing audiobook cover can be updated without replacing its text or audio', await page.evaluate(async () => {
      const db = await import('/js/db.js'), books = await db.getAll('books');
      return books.length === 1 && !!books[0].cover && !!await db.get('narrations', books[0].id);
    }));
    check('no application errors', errors.length === 0);
  } finally { if (browser) await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
