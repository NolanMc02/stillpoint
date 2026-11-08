const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium, webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '..');
let count = 0;
const check = (label, condition) => { assert.ok(condition, label); count++; console.log(`PASS ${label}`); };
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stillpoint-modes-'));
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  let browser, context;
  try {
    const options = { ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' };
    if (engine === webkit) { context = await webkit.launchPersistentContext(temporary, { headless: true, ...options }); browser = { close: () => context.close() }; }
    else { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH }); context = await browser.newContext(options); }
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      window.__hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.__hidden ? 'hidden' : 'visible' });
      window.__hide = value => { window.__hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
      window.__media = {};
      if (navigator.mediaSession) { const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession); navigator.mediaSession.setActionHandler = (key, handler) => { window.__media[key] = handler; original(key, handler); }; }
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    await page.route('http://localhost:8123/**', route => {
      let file = path.resolve(root, `.${new URL(route.request().url()).pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    const shot = async name => { if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, `${name}.png`) }); } };
    const mode = async value => {
      await page.click('#r-mode'); await page.click(`[data-mode="${value}"]`);
      await page.waitForFunction(value => __stillpoint.R.book.readerMode === value && __stillpoint.R.state === 'paused', value);
      await page.click('[data-close]');
    };
    await page.goto('http://localhost:8123/'); await page.waitForSelector('#empty-add');
    await page.evaluate(async () => {
      const db = await import('/js/db.js'), { buildIndex } = await import('/js/engine.js'), { createNarrationJob } = await import('/js/narration.js');
      const blocks = Array.from({ length: 3 }, (_, c) => ({ sid: `chapter-${c}`, k: 'p', t: Array.from({ length: 120 }, (_, i) => ['The', 'quiet', 'river', 'flowed', 'beneath', 'the', 'bridge', 'in', 'the', 'morning.'][i % 10]).join(' ') }));
      const book = { id: 'iteration', title: 'The Quiet River', author: 'Original test book', format: 'epub', readerMode: 'read', readingView: 'book', audioMode: 'off', bookLayout: 'scroll',
        pos: 20, wordCount: buildIndex(blocks).words.length, chapters: blocks.map((_, i) => ({ title: `Chapter ${i + 1}`, block: i })), bookmarks: [], addedAt: Date.now(), lastReadAt: Date.now() };
      await db.saveBook(book, { id: book.id, blocks });
      const job = await createNarrationJob(book, { blocks }), audio = [], clips = [];
      for (let c = 0; c < 3; c++) {
        const file = `audio/clip-${c}.wav`, samples = 8000 * 12, b = new ArrayBuffer(44 + samples * 2), v = new DataView(b), chars = (offset, s) => [...s].forEach((ch, i) => v.setUint8(offset + i, ch.charCodeAt(0)));
        chars(0, 'RIFF'); v.setUint32(4, b.byteLength - 8, true); chars(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); chars(36, 'data'); v.setUint32(40, samples * 2, true);
        for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 600), true);
        audio.push({ file, data: new Blob([b], { type: 'audio/wav' }) });
        clips.push({ file, durationMs: 12000, words: job.blocks[c].tokens.map((_, offset) => ({ sid: job.blocks[c].sid, offset, startMs: offset * 100, endMs: (offset + 1) * 100 })) });
      }
      await db.saveNarration(book.id, { format: 'stillpoint-audiobook', version: 1, tokenizer: job.tokenizer, textHash: job.textHash, clips }, audio);
      await db.put('kv', { openLast: false, countdown: 0, ramp: 0, sound: 'brown', volume: .15, soundMode: 'reading' }, 'settings');
    });
    await page.reload(); await page.waitForSelector('.continue-card');
    check('Continue card shows last-used mode and chapter', (await page.locator('.continue-card').innerText()).includes('Continue reading') && (await page.locator('.continue-card').innerText()).includes('Chapter 1'));
    check('library identifies available audio', (await page.locator('.book-badges').innerText()).includes('Audio available')); await shot('continue-reading');
    await page.click('.continue-card'); await page.waitForSelector('.book-viewport');
    check('opening Continue stays paused at the saved word', await page.evaluate(() => __stillpoint.R.pos === 20 && __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    check('reading text remains above the visible controls', await page.evaluate(() => document.querySelector('.book-viewport').getBoundingClientRect().bottom < document.querySelector('#bottom-bar').getBoundingClientRect().top));
    await page.click('#r-mode');
    check('one selector offers Read, Listen and RSVP', await page.locator('[data-mode]').count() === 3); await shot('mode-selector');
    await page.click('[data-mode="listen"]'); await page.click('[data-close]');
    check('switching to Listen preserves the word and stays paused', await page.evaluate(() => __stillpoint.R.pos === 20 && __stillpoint.R.narration.audio.paused));
    await page.click('#r-mode'); await page.uncheck('#listen-follow'); await page.click('[data-close]');
    check('Listen without following shows a dedicated listening screen', await page.locator('#listen-view').isVisible() && !await page.locator('#book-view').isVisible()); await shot('listen-player');
    await page.click('#audio-forward');
    await page.waitForFunction(() => __stillpoint.R.narration.positionSeconds() > 14);
    check('forward skip is exactly 15 seconds and stays paused across clips', await page.evaluate(() => Math.abs(__stillpoint.R.narration.positionSeconds() - 17) < .1 && __stillpoint.R.narration.clipIndex === 1 && __stillpoint.R.state === 'paused'));
    await page.click('#r-rew'); await page.waitForFunction(() => __stillpoint.R.narration.clipIndex === 0);
    check('back skip preserves the paused position across clips', await page.evaluate(() => Math.abs(__stillpoint.R.narration.positionSeconds() - 2) < .1 && __stillpoint.R.narration.audio.paused));
    await page.click('#r-rew'); await page.waitForFunction(() => __stillpoint.R.narration.positionSeconds() < .1);
    await page.click('#audio-options'); await page.selectOption('#audio-rate', '2'); await page.click('[data-close]');
    check('speed updates chapter/book remaining time', (await page.locator('#audio-times').getAttribute('aria-label')).includes('0:06 remaining in chapter') && (await page.locator('#audio-times').getAttribute('aria-label')).includes('0:18 remaining in book'));
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.narration.audio.currentTime > .2);
    check('native narration and background sound run together', await page.evaluate(async () => !__stillpoint.R.narration.audio.paused && (await import('/js/sounds.js')).soundState().playing === 'brown'));
    const mediaSession = await page.evaluate(() => typeof __media.pause === 'function');
    await page.evaluate(() => { if (__media.pause) __media.pause(); else __stillpoint.R.narration.audio.pause(); }); await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    const before = await page.evaluate(() => __stillpoint.R.narration.positionSeconds());
    await page.evaluate(async () => { if (__media.seekforward) __media.seekforward({ seekOffset: 15 }); else await __stillpoint.R.narration.seekSeconds(__stillpoint.R.narration.positionSeconds() + 15, { paused: true }); }); await page.waitForFunction(() => __stillpoint.R.narration.clipIndex === 1);
    check(mediaSession ? 'system media skips use seconds and keep paused state' : 'native seek fallback uses seconds and keeps paused state', await page.evaluate(before => Math.abs(__stillpoint.R.narration.positionSeconds() - before - 15) < .15 && __stillpoint.R.narration.audio.paused, before));
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await mode('read');
    check('switching away pauses native audio and preserves position', await page.evaluate(() => __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused && __stillpoint.R.pos >= 150));
    await mode('rsvp');
    await page.click('#r-mode'); await page.check('#rsvp-audio'); await page.click('[data-close]');
    check('RSVP audiobook timing is an explicit paused option', await page.evaluate(() => __stillpoint.R.book.audioMode === 'rsvp' && __stillpoint.R.state === 'paused'));
    await page.locator('#flow-inner .w.cur').dispatchEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 120, clientY: 300 });
    await page.locator('#flow-inner .w.cur').dispatchEvent('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 120, clientY: 300 });
    check('tapping paused RSVP does not start a session', await page.evaluate(() => __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    await mode('listen');
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await page.evaluate(() => { __stillpoint.R.sleepTimer.duration(.01); window.__hide(true); });
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    check('duration sleep timer stops narration and ambience while simulated hidden', await page.evaluate(async () => __stillpoint.R.sleepTimer.state().kind === 'off' && __stillpoint.R.narration.audio.paused && (await import('/js/sounds.js')).soundState().playing === 'off'));
    await page.evaluate(() => window.__hide(false));
    await page.evaluate(async () => { await __stillpoint.R.narration.seekSeconds(1, { paused: true }); });
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await page.click('#audio-options'); await page.selectOption('#sleep-choice', 'chapter'); await page.click('[data-close]');
    await page.evaluate(async () => { await __stillpoint.R.narration.seekSeconds(12.2, { paused: false }); __stillpoint.R.narration.audio.dispatchEvent(new Event('timeupdate')); });
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    check('end-of-chapter sleep stops at the chapter boundary', await page.evaluate(() => Math.abs(__stillpoint.R.narration.positionSeconds() - 12) < .15 && __stillpoint.R.sleepTimer.state().kind === 'off'));
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await page.evaluate(() => { __stillpoint.R.sleepTimer.duration(.01); __stillpoint.R.sleepTimer.clear(); });
    await page.waitForTimeout(850);
    check('cancelling a sleep timer does not pause playback later', await page.evaluate(() => __stillpoint.R.state === 'playing'));
    await page.evaluate(() => __stillpoint.R.narration.audio.dispatchEvent(new Event('error')));
    await page.waitForSelector('#playback-error:not([hidden])');
    check('playback errors offer recovery and leave the book paused', await page.evaluate(() => __stillpoint.R.state === 'paused') && await page.locator('#audio-retry').isVisible() && await page.locator('#audio-read-instead').isVisible());
    await page.click('#audio-retry'); await page.waitForSelector('#playback-error[hidden]', { state: 'attached' });
    check('reloading saved audio waits for an explicit Play', await page.evaluate(() => __stillpoint.R.narration.audio.paused && __stillpoint.R.state === 'paused'));
    await page.click('#r-back'); await page.waitForSelector('.continue-card');
    check('Continue listening uses accurate audio remaining time', (await page.locator('.continue-card').innerText()).includes('Continue listening') && (await page.locator('.book-meta').innerText()).includes('Audio ·')); await shot('continue-listening');
    const stored = await page.evaluate(async () => (await (await import('/js/db.js')).get('books', 'iteration')).pos);
    await page.click('.continue-card'); await page.waitForSelector('#listen-view:not([hidden])');
    check('reopening restores mode, speed, follow choice and word without autoplay', await page.evaluate(pos => __stillpoint.R.book.readerMode === 'listen' && __stillpoint.R.book.audioRate === 2 && __stillpoint.R.book.listenFollow === false && __stillpoint.R.pos === pos && __stillpoint.R.narration.audio.paused, stored));
    await page.click('#r-back'); await page.waitForSelector('[data-more]');
    await page.click('[data-more]'); await page.click('[data-a="narration"]'); await page.click('#manage-reading-mode');
    await page.waitForSelector('#mode-body');
    check('audiobook management from the library opens mode selection safely', await page.evaluate(pos => __stillpoint.R.pos === pos && __stillpoint.R.state === 'paused', stored) && await page.locator('[data-mode="listen"]').getAttribute('aria-pressed') === 'true');
    await page.click('#mode-audiobook'); await page.click('#narration-remove'); await page.waitForSelector('.book-viewport');
    await page.click('#r-mode');
    check('removing narration preserves Read and disables unavailable Listen', await page.locator('[data-mode="listen"]').isDisabled() && await page.evaluate(() => __stillpoint.R.book.readerMode === 'read' && !__stillpoint.R.book.audioReady));
    await page.click('[data-mode="rsvp"]');
    check('removed audio also clears the narrated RSVP preference', await page.locator('#rsvp-audio').isDisabled() && !await page.locator('#rsvp-audio').isChecked());
    await page.click('[data-close]'); await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    check('independent RSVP still starts after removing narration', await page.evaluate(() => !__stillpoint.R.narration));
    await page.tap('#stage');
    check('no application errors', errors.length === 0);
    console.log(`${count} reading iteration checks passed`);
  } finally { if (browser) await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
