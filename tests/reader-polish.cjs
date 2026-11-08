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
      const mode = rect('#r-mode'), play = rect('#play');
      const percentages = ['#audio-progress', '#m-pct', '#book-page-info', '.book-page-count'].filter(selector => {
        const el = document.querySelector(selector); return el && el.getClientRects().length && el.textContent === '9%';
      });
      return { footer: rect('#bottom-bar').height, percentages, nav: document.querySelector('#book-navigation').hidden,
        header: { position: header.position, background: header.backgroundColor, filter: header.filter, backdrop: header.backdropFilter || header.webkitBackdropFilter, transform: header.transform },
        playBottom: play.bottom, playVisible: !!document.elementFromPoint(play.x + play.width / 2, play.bottom - 2)?.closest('#play'),
        headerHeight: rect('#top-bar').height,
        clearance: getComputedStyle(document.documentElement).getPropertyValue('--header-clearance'),
        belowHeader: rect('.book-viewport').top >= rect('#top-bar').bottom + 10,
        modeTappable: !!document.elementFromPoint(mode.x + mode.width / 2, mode.y + mode.height / 2)?.closest('#r-mode') };
    });
    check('scrolling Listen shows percentage once and hides the unused page-navigation row', layout.percentages.length === 1 && layout.nav);
    check('compact controls use less than 175 px including a simulated 34 px home-indicator inset', layout.footer < 175);
    check('iPhone header is fixed, opaque and free of CSS filters or transforms', layout.header.position === 'fixed' && layout.header.background === 'rgb(0, 0, 0)' && layout.header.filter === 'none' && layout.header.backdrop === 'none' && layout.header.transform === 'none');
    check('compact iPhone header has no extra spacer and keeps text below tappable buttons', layout.clearance.trim() === '0px' && layout.headerHeight <= 120 && layout.belowHeader && layout.modeTappable);
    check('the full play button clears the bottom safe-area shield', layout.playVisible && layout.playBottom <= 852 - 34);
    await shot('compact-listen');
    await page.click('#r-context'); await page.waitForSelector('#story-prompt');
    check('the explanation panel also stays below the iPhone header-shield region', await page.locator('.sheet').evaluate(el => el.getBoundingClientRect().top >= 59));
    const prompt = await page.locator('#story-prompt').inputValue();
    check('explanation prompt identifies book, chapter and exact cutoff', prompt.includes('The Quiet River') && prompt.includes('Chapter Five: The River') && prompt.includes('9.1%') && prompt.includes('STOPWORD”'));
    check('prompt excludes unread words in the same paragraph and future chapter titles', !prompt.includes('FUTURE_SECRET_SENTINEL') && !prompt.includes('FUTURE_CHAPTER_SENTINEL'));
    check('scene prompt is a simple request with a brief cutoff excerpt and no-spoiler instruction', prompt.includes('Can you help me understand what is going on at this point') && prompt.includes('don’t spoil anything after the quoted text') && prompt.length < 1100 && !prompt.includes('Please follow these rules'));
    await page.click('#story-copy');
    check('Copy prompt copies the frozen snapshot', await page.evaluate(() => window.__copied === document.querySelector('#story-prompt').value)); await shot('story-prompt');
    await page.selectOption('#story-kind', 'summary');
    const summary = await page.locator('#story-prompt').inputValue();
    check('book recap asks for events from the beginning to the cutoff', summary.includes('Can you briefly explain the story from the beginning up to this point?'));
    check('recap keeps the same exact cutoff and excludes unread words and future chapter labels', summary.includes('STOPWORD”') && summary.includes('9.1%') && !summary.includes('FUTURE_SECRET_SENTINEL') && !summary.includes('FUTURE_CHAPTER_SENTINEL'));
    check('recap stays short and carries the same simple spoiler boundary', summary.length < 1100 && summary.includes('don’t spoil anything after the quoted text, even later in this chapter'));
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
    check('word-menu explanation uses that exact word instead of the page anchor', precise.includes('4.1%') && !precise.includes('STOPWORD') && !precise.includes('FUTURE_SECRET_SENTINEL'));
    const boundary = await page.evaluate(async () => {
      const { buildStoryPrompt } = await import('/js/story-context.js'), r = __stillpoint.R;
      return { first: buildStoryPrompt({ ...r, position: 0 }), late: buildStoryPrompt({ ...r, position: 900 }) };
    });
    check('first-word and long-book prompt boundaries remain bounded and past-only', boundary.first.includes('0.1%') && !boundary.first.includes('quiet river') && boundary.late.includes('90.1%') && boundary.late.length < 1100);
    // Exercise viewport correction against a simulated installed-iPhone short viewport.
    const sizing = await page.evaluate(async () => {
      const { appViewportHeight: fit } = await import('/js/viewport.js');
      const base = { height: 793, width: 393, screenWidth: 393, screenHeight: 852, apple: true, standalone: true, safeTop: 59, safeBottom: 34 };
      return [fit(base), fit({ ...base, height: 852 }), fit({ ...base, visualHeight: 450 }), fit({ ...base, standalone: false }), fit({ ...base, height: 372, width: 852, screenWidth: 852, screenHeight: 393, safeTop: 0, safeBottom: 21 })];
    });
    check('viewport correction covers the shortened iPhone screen without extending through a keyboard or browser toolbar', sizing.join(',') === '852,852,450,793,393');
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => window.__reportedHeight ?? 852 });
      window.__reportedHeight = 793; visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);
    check('a shortened iPhone viewport still places the app at the physical bottom', await page.evaluate(() => Math.abs(document.body.getBoundingClientRect().height - 852) < 1 && Math.abs(document.querySelector('#bottom-bar').getBoundingClientRect().bottom - 852) < 1));
    await page.evaluate(() => { window.__reportedHeight = 450; visualViewport.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(120);
    check('keyboard-sized viewport keeps sheets above the keyboard', await page.evaluate(() => Math.abs(document.querySelector('#sheets').getBoundingClientRect().bottom - 450) < 1));
    await page.evaluate(() => { window.__reportedHeight = 852; visualViewport.dispatchEvent(new Event('resize')); });
    await page.evaluate(async () => {
      const db = await import('/js/db.js'), r = __stillpoint.R;
      await db.saveBook({ ...r.book, readerMode: 'listen', audioMode: 'page', readingView: 'book', bookLayout: 'scroll', pos: 90 }, { id: r.book.id, blocks: r.blocks });
      await db.put('kv', { ...__stillpoint.S, textSize: 19, textMargin: 22, textFont: 'iowan', theme: 'oled' }, 'settings');
    });
    await page.reload(); await page.waitForSelector('.book-viewport'); await page.waitForTimeout(350);
    const bottom = await page.evaluate(() => ({ gap: document.body.getBoundingClientRect().bottom - document.querySelector('#play').getBoundingClientRect().bottom, count: document.querySelectorAll('#audio-toolbar button').length }));
    check('player leaves only the home-gesture inset plus four pixels below Play', Math.abs(bottom.gap - 38) < 1);
    check('one listening-options button replaces duplicate speed and Sleep buttons', bottom.count === 1 && await page.locator('#audio-options').textContent() === '1× ▾');
    await page.click('#audio-options'); await page.selectOption('#sleep-choice', '5'); await page.click('[data-close]');
    check('the single listening button also indicates an active sleep timer', (await page.locator('#audio-options').getAttribute('aria-label')).includes('sleep timer active'));
    await page.click('#audio-options'); await page.selectOption('#sleep-choice', 'off'); await page.click('[data-close]');
    const audioBefore = await page.evaluate(() => __stillpoint.R.narration.audio.currentTime);
    await page.evaluate(() => { const v = __stillpoint.R.bookView; v.suppressUntil = 0; v.viewport.scrollTop += 400; });
    await page.waitForTimeout(350);
    check('scrolling paused Listen browses without seeking audio or changing the saved position', await page.evaluate(async time => {
      const r = __stillpoint.R, db = await import('/js/db.js'); dispatchEvent(new Event('pagehide')); await new Promise(resolve => setTimeout(resolve, 30));
      return r.bookView.browsing && r.pos === 90 && Math.abs(r.narration.audio.currentTime - time) < .05 && (await db.get('books', r.book.id)).pos === 90;
    }, audioBefore));
    check('scrolling away offers Back to my place', await page.locator('#back-place').isVisible());
    await page.click('#back-place'); await page.click('#play'); await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    const runningBefore = await page.evaluate(() => __stillpoint.R.narration.audio.currentTime);
    await page.locator('.book-viewport').dispatchEvent('pointerdown', { pointerId: 11, pointerType: 'touch', clientX: 160, clientY: 380 });
    await page.locator('.book-viewport').dispatchEvent('pointermove', { pointerId: 11, pointerType: 'touch', clientX: 160, clientY: 300 });
    await page.evaluate(() => { const v = __stillpoint.R.bookView; v.viewport.scrollTop += 400; });
    await page.locator('.book-viewport').dispatchEvent('pointerup', { pointerId: 11, pointerType: 'touch', clientX: 160, clientY: 300 });
    await page.waitForTimeout(300);
    const browsingTop = await page.evaluate(() => __stillpoint.R.bookView.viewport.scrollTop);
    await page.waitForTimeout(300);
    check('audio continues at its own clock while manual browsing remains still', await page.evaluate(({ time, top }) => {
      const r = __stillpoint.R; return r.bookView.browsing && !r.narration.audio.paused && r.narration.audio.currentTime > time && r.narration.audio.currentTime - time < 2 && Math.abs(r.bookView.viewport.scrollTop - top) < 2;
    }, { time: runningBefore, top: browsingTop }));
    await shot('listen-browsing');
    await page.click('#back-place');
    check('Back to my place restores following at the spoken word without pausing', await page.evaluate(() => { const r = __stillpoint.R, el = r.bookView.wordEl(r.pos), frame = r.bookView.viewport.getBoundingClientRect(), rect = el.getBoundingClientRect(); return !r.bookView.browsing && !r.narration.audio.paused && rect.top >= frame.top && rect.bottom <= frame.bottom; }));
    await page.click('#play');
    const saved = await page.evaluate(() => __stillpoint.R.pos);
    await page.click('#r-settings'); await page.waitForTimeout(150);
    await shot('appearance-open');
    check('appearance panel leaves the actual book visible and tappable above it', await page.evaluate(() => {
      const view = document.querySelector('.book-viewport').getBoundingClientRect(), panel = document.querySelector('.sheet').getBoundingClientRect();
      return view.height > 250 && view.bottom <= panel.top - 8 && !!document.elementFromPoint(view.x + view.width / 2, view.y + view.height / 2)?.closest('.book-viewport') && panel.height <= 345;
    }));
    await page.locator('[data-book-setting="textSize"]').evaluate(el => { el.value = 30; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(180);
    check('font size previews directly on the book without changing the listening position', await page.evaluate(pos => getComputedStyle(document.querySelector('.book-text')).fontSize === '30px' && __stillpoint.R.pos === pos, saved));
    await page.click('[data-appearance="layout"]');
    await page.locator('[data-book-setting="textMargin"]').evaluate(el => { el.value = 44; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(180);
    check('margin changes preview on the actual book while the panel stays open', await page.evaluate(pos => document.querySelector('.book-viewport').getBoundingClientRect().left === 44 && __stillpoint.R.pos === pos && !!document.querySelector('.appearance-scrim'), saved));
    await shot('live-appearance');
    await page.click('[data-book-layout="pages"]'); await page.waitForTimeout(180);
    check('switching to pages keeps the live preview and saved listening point', await page.evaluate(pos => __stillpoint.R.bookView.layout === 'pages' && __stillpoint.R.pos === pos && document.querySelector('#reader').classList.contains('appearance-open'), saved));
    await page.click('[data-close]'); await page.waitForTimeout(200);
    const normalHeight = await page.locator('.book-viewport').evaluate(el => el.getBoundingClientRect().height);
    await page.click('#r-fullscreen'); await page.waitForTimeout(180);
    check('explicit fullscreen hides app controls and gives the space to the book', await page.evaluate(({ pos, height }) => {
      const v = document.querySelector('.book-viewport').getBoundingClientRect(); return __stillpoint.R.fullscreen && __stillpoint.R.pos === pos && v.height > height + 100 && getComputedStyle(document.querySelector('#top-bar')).opacity === '0' && getComputedStyle(document.querySelector('#bottom-bar')).pointerEvents === 'none';
    }, { pos: saved, height: normalHeight }));
    await shot('fullscreen');
    await page.locator('.book-viewport').evaluate(el => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 17, clientX: r.x + r.width * .5, clientY: r.y + r.height * .4 })); el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 17, clientX: r.x + r.width * .5, clientY: r.y + r.height * .4 })); });
    await page.waitForTimeout(180);
    check('center tap exits fullscreen and restores controls without autoplay', await page.evaluate(pos => !__stillpoint.R.fullscreen && __stillpoint.R.pos === pos && getComputedStyle(document.querySelector('#bottom-bar')).opacity === '1' && __stillpoint.R.narration.audio.paused, saved));
    check('no application errors', errors.length === 0);
    console.log(`${count} reader polish checks passed`);
  } finally { if (browser) await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
