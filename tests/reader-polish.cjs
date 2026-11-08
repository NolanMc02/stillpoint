const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium, webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '..');
let count = 0;
const check = (label, condition) => { assert.ok(condition, label); count++; console.log(`PASS ${label}`); };
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stillpoint-polish-'));
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  let browser, context;
  try {
    const options = { ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' };
    if (engine === webkit) { context = await webkit.launchPersistentContext(temporary, { headless: true, ...options }); browser = { close: () => context.close() }; }
    else { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH }); context = await browser.newContext(options); }
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.setProperty('--safe-t', '59px');
        document.documentElement.style.setProperty('--safe-b', '34px');
      });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });
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
    await page.goto('http://localhost:8123/'); await page.waitForSelector('#empty-add');
    await page.evaluate(async () => {
      const db = await import('/js/db.js'), { buildIndex } = await import('/js/engine.js'), { createNarrationJob } = await import('/js/narration.js');
      const blocks = Array.from({ length: 10 }, (_, b) => ({ sid: `block-${b}`, k: 'p', t: Array.from({ length: 100 }, (_, i) => {
        if (b === 0 && i === 90) return 'STOPWORD';
        if (b === 0 && i === 91) return 'FUTURE_SECRET_SENTINEL';
        return ['The', 'quiet', 'river', 'flowed', 'beneath', 'the', 'bridge', 'in', 'the', 'morning.'][i % 10];
      }).join(' ') }));
      const book = { id: 'polish', title: 'The Quiet River', author: 'Original test book', readerMode: 'listen', readingView: 'book', audioMode: 'page', listenFollow: true, bookLayout: 'scroll',
        pos: 90, wordCount: buildIndex(blocks).words.length, addedAt: Date.now(), chapters: [{ title: 'Chapter Five: The River', block: 0 }, { title: 'FUTURE_CHAPTER_SENTINEL', block: 5 }], bookmarks: [] };
      await db.saveBook(book, { id: book.id, blocks });
      const job = await createNarrationJob(book, { blocks });
      const rate = 8000, samples = rate * 60, data = new ArrayBuffer(44 + samples * 2), v = new DataView(data), chars = (p, s) => [...s].forEach((ch, i) => v.setUint8(p + i, ch.charCodeAt(0)));
      chars(0, 'RIFF'); v.setUint32(4, data.byteLength - 8, true); chars(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); chars(36, 'data'); v.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 300), true);
      const words = job.blocks.flatMap(b => b.tokens.map((_, offset) => ({ sid: b.sid, offset }))).map((word, i) => ({ ...word, startMs: i * 60, endMs: (i + 1) * 60 }));
      await db.saveNarration(book.id, { format: 'stillpoint-audiobook', version: 1, tokenizer: job.tokenizer, textHash: job.textHash, playback: 'continuous', clips: [{ file: 'audio/clip-0.wav', durationMs: 60000, words }] }, [{ file: 'audio/clip-0.wav', data: new Blob([data], { type: 'audio/wav' }) }]);
      await db.put('kv', { openLast: true, theme: 'oled', bookProgress: 'percent', countdown: 0 }, 'settings');
      await db.put('kv', book.id, 'lastBook');
    });
    await page.reload(); await page.waitForSelector('.book-viewport'); await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const header = getComputedStyle(document.querySelector('#top-bar'));
      const mode = rect('#r-mode');
      const percentages = ['#audio-progress', '#m-pct', '#book-page-info', '.book-page-count'].filter(selector => {
        const el = document.querySelector(selector); return el && el.getClientRects().length && el.textContent === '9%';
      });
      return { footer: rect('#bottom-bar').height, percentages, nav: document.querySelector('#book-navigation').hidden,
        header: { position: header.position, background: header.backgroundColor, filter: header.filter, backdrop: header.backdropFilter || header.webkitBackdropFilter, transform: header.transform },
        clearance: getComputedStyle(document.documentElement).getPropertyValue('--header-clearance'),
        belowHeader: rect('.book-viewport').top >= rect('#top-bar').bottom + 10,
        modeTappable: !!document.elementFromPoint(mode.x + mode.width / 2, mode.y + mode.height / 2)?.closest('#r-mode') };
    });
    check('scrolling Listen shows percentage once and hides the unused page-navigation row', layout.percentages.length === 1 && layout.nav);
    check('compact controls use less than 175 px including a simulated 34 px home-indicator inset', layout.footer < 175);
    check('iPhone header is fixed, opaque and free of CSS filters or transforms', layout.header.position === 'fixed' && layout.header.background === 'rgb(0, 0, 0)' && layout.header.filter === 'none' && layout.header.backdrop === 'none' && layout.header.transform === 'none');
    check('iPhone header clearance keeps text below the header without blocking its buttons', layout.clearance.trim() === '32px' && layout.belowHeader && layout.modeTappable);
    await shot('compact-listen');
    await page.click('#r-context'); await page.waitForSelector('#story-prompt');
    check('the explanation panel also stays below the iPhone header-shield region', await page.locator('.sheet').evaluate(el => el.getBoundingClientRect().top >= 102));
    const prompt = await page.locator('#story-prompt').inputValue();
    check('explanation prompt identifies book, chapter and exact cutoff', prompt.includes('The Quiet River') && prompt.includes('Chapter Five: The River') && prompt.includes('word 91 of 1000') && prompt.includes('"STOPWORD"'));
    check('prompt excludes unread words in the same paragraph and future chapter titles', !prompt.includes('FUTURE_SECRET_SENTINEL') && !prompt.includes('FUTURE_CHAPTER_SENTINEL'));
    check('prompt explicitly requests concise explanations without completing sentences or foreshadowing', prompt.includes('3–5 short bullets') && prompt.includes('150 words') && prompt.includes('Do not finish an incomplete sentence') && prompt.includes('hint at future importance'));
    await page.click('#story-copy');
    check('Copy prompt copies the frozen snapshot', await page.evaluate(() => window.__copied === document.querySelector('#story-prompt').value)); await shot('story-prompt');
    await page.selectOption('#story-kind', 'summary');
    const summary = await page.locator('#story-prompt').inputValue();
    check('book recap asks for events from the beginning to the cutoff', summary.startsWith('Summarize this book from its beginning') && summary.includes('5–7 short bullets') && summary.includes('250 words'));
    check('recap keeps the same exact cutoff and excludes unread words and future chapter labels', summary.includes('word 91 of 1000') && !summary.includes('FUTURE_SECRET_SENTINEL') && !summary.includes('FUTURE_CHAPTER_SENTINEL'));
    check('recap asks for earlier text rather than invented plot when book knowledge is insufficient', summary.includes('location marker, not the full earlier book') && summary.includes('ask me for earlier text instead of inventing a recap'));
    await page.click('#story-copy');
    check('copying after switching copies the recap rather than the scene prompt', await page.evaluate(() => window.__copied === document.querySelector('#story-prompt').value) && summary !== prompt);
    await page.selectOption('#story-kind', 'scene');
    check('switching help types preserves the frozen reading point and paused playback', await page.locator('#story-prompt').inputValue() === prompt && await page.evaluate(() => __stillpoint.R.pos === 90 && __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('blocked', 'NotAllowedError'); }; document.execCommand = () => false; });
    await page.click('#story-copy');
    check('blocked clipboard access offers selectable text without falsely reporting success', (await page.locator('#story-copy-status').innerText()).includes('blocked') && await page.locator('#story-prompt').evaluate(el => getComputedStyle(el).webkitUserSelect === 'text'));
    await page.click('[data-close]');
    check('closing the explanation does not resume narration', await page.evaluate(() => __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await page.click('#r-context');
    check('opening explanation during playback pauses native audio', await page.evaluate(() => __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    const frozen = await page.locator('#story-prompt').inputValue(); await page.waitForTimeout(250);
    check('prompt position stays fixed while the panel is open', frozen === await page.locator('#story-prompt').inputValue());
    await page.click('[data-close]'); await page.click('#r-mode'); await page.click('[data-mode="read"]'); await page.click('[data-close]');
    const word = page.locator('.book-text [data-i="40"]'); await word.scrollIntoViewIfNeeded();
    await word.dispatchEvent('pointerdown', { pointerId: 4, pointerType: 'touch', clientX: 120, clientY: 300 });
    await page.waitForSelector('[data-a="explain"]');
    await page.locator('.book-viewport').dispatchEvent('pointerup', { pointerId: 4, pointerType: 'touch', clientX: 120, clientY: 300 });
    await page.click('[data-a="explain"]');
    const precise = await page.locator('#story-prompt').inputValue();
    check('word-menu explanation uses that exact word instead of the page anchor', precise.includes('word 41 of 1000') && !precise.includes('STOPWORD') && !precise.includes('FUTURE_SECRET_SENTINEL'));
    const boundary = await page.evaluate(async () => {
      const { buildStoryPrompt } = await import('/js/story-context.js'), r = __stillpoint.R;
      return { first: buildStoryPrompt({ ...r, position: 0 }), late: buildStoryPrompt({ ...r, position: 900 }) };
    });
    check('first-word and long-book prompt boundaries remain bounded and past-only', boundary.first.includes('word 1 of 1000') && !boundary.first.includes('quiet river') && boundary.late.includes('[Earlier text omitted]') && boundary.late.length < 9000);
    check('no application errors', errors.length === 0);
    console.log(`${count} reader polish checks passed`);
  } finally { if (browser) await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
