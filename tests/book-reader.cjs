const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '..');
let count = 0;
const check = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`); count++; };
(async () => {
  const engine = process.env.BOOK_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost:8123') return route.abort();
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(root + path.sep) && file !== root) return route.fulfill({ status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto('http://localhost:8123/'); await page.waitForSelector('#empty-add');
    await page.evaluate(async () => {
      const db = await import('/js/db.js'); const { buildIndex } = await import('/js/engine.js');
      const blocks = [], chapters = [];
      for (let c = 0; c < 3; c++) {
        chapters.push({ title: `Chapter ${c + 1}`, block: blocks.length });
        blocks.push({ sid: `h:${c}`, k: 'h', t: `Chapter ${c + 1}` });
        for (let p = 0; p < 16; p++) blocks.push({ sid: `${c}:${p}`, k: 'p', t: Array.from({ length: 8 }, () => 'The river carried the light of the morning between the trees. The path was quiet and the story continued.').join(' ') });
      }
      await db.saveBook({ id: 'book-view-test', title: 'The Quiet River', author: 'Test author', pos: 150,
        wordCount: buildIndex(blocks).words.length, chapters, bookmarks: [], addedAt: Date.now() }, { id: 'book-view-test', blocks });
      await db.put('kv', 'book-view-test', 'lastBook');
    });
    await page.reload(); await page.waitForSelector('#reader');
    await page.click('#r-book'); await page.waitForSelector('.book-viewport');
    await page.waitForTimeout(250);
    check('book mode opens at the same reading word', await page.evaluate(() => {
      const R = __stillpoint.R, word = R.bookView.wordEl(R.pos).getBoundingClientRect(), view = R.bookView.viewport.getBoundingClientRect();
      return R.pos === 150 && R.bookView.pageCount > 1 && word.left >= view.left - 1 && word.right <= view.right + 1;
    }));
    check('silent book mode has no word highlighting or native selection', await page.evaluate(() => !document.querySelector('.bw.current') && getComputedStyle(document.querySelector('.bw')).webkitUserSelect === 'none'));
    const before = await page.evaluate(() => ({ pos: __stillpoint.R.pos, page: __stillpoint.R.bookView.page }));
    await page.click('#book-next');
    check('next page advances the shared reading position', await page.evaluate(old => __stillpoint.R.pos > old.pos && __stillpoint.R.bookView.page === old.page + 1, before));
    await page.click('#book-prev');
    check('previous page returns to the earlier page', await page.evaluate(old => __stillpoint.R.bookView.page === old.page, before));
    await page.keyboard.press('ArrowRight');
    check('keyboard page turning keeps silent reading paused', await page.evaluate(old => __stillpoint.R.bookView.page === old.page + 1 && __stillpoint.R.state === 'paused', before));
    await page.keyboard.press('ArrowLeft');
    const frame = await page.locator('.book-viewport').boundingBox();
    await page.locator('.book-viewport').dispatchEvent('pointerdown', { pointerId: 6, pointerType: 'touch', clientX: frame.x + frame.width - 10, clientY: frame.y + 200 });
    await page.locator('.book-viewport').dispatchEvent('pointerup', { pointerId: 6, pointerType: 'touch', clientX: frame.x + 15, clientY: frame.y + 200 });
    check('horizontal swipes turn pages without changing RSVP speed', await page.evaluate(old => __stillpoint.R.bookView.page === old.page + 1 && __stillpoint.R.wpm === 300, before));
    await page.locator('.book-viewport').tap({ position: { x: frame.width / 2, y: 120 } });
    check('center tap hides reading controls', await page.locator('#reader').evaluate(el => el.classList.contains('book-chrome-hidden')));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'book-pages.png') });
    await page.locator('.book-viewport').tap({ position: { x: frame.width / 2, y: 120 } });
    await page.click('#r-settings');
    const anchor = await page.evaluate(() => __stillpoint.R.pos);
    await page.locator('[data-book-setting="textSize"]').fill('25');
    await page.waitForTimeout(250);
    check('font resizing repaginates without losing the word anchor', await page.evaluate(pos => {
      const R = __stillpoint.R, word = R.bookView.wordEl(pos).getBoundingClientRect(), view = R.bookView.viewport.getBoundingClientRect();
      return R.pos === pos && __stillpoint.S.textSize === 25 && word.left >= view.left - 1 && word.right <= view.right + 1;
    }, anchor));
    await page.click('[data-appearance="themes"]'); await page.click('[data-book-theme="paper"]');
    await page.click('[data-appearance="layout"]'); await page.click('[data-book-layout="scroll"]');
    await page.click('[data-close]'); await page.waitForTimeout(350);
    check('continuous scrolling layout can be selected', await page.evaluate(() => __stillpoint.R.bookView.layout === 'scroll' && __stillpoint.R.book.bookLayout === 'scroll'));
    const scrollStart = await page.evaluate(() => __stillpoint.R.pos);
    await page.locator('.book-viewport').evaluate(el => { el.scrollTop += el.clientHeight; });
    await page.waitForFunction(pos => __stillpoint.R.pos > pos, scrollStart);
    check('manual scrolling updates the shared reading position', await page.evaluate(pos => __stillpoint.R.pos > pos, scrollStart));
    const saved = await page.evaluate(() => __stillpoint.R.pos);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'book-scroll.png') });
    await page.click('#r-back'); await page.click('.book-title'); await page.waitForSelector('.book-viewport');
    check('book layout and position survive reopening', await page.evaluate(pos => __stillpoint.R.pos === pos && __stillpoint.R.bookView.layout === 'scroll', saved));
    await page.click('#r-book'); await page.waitForSelector('#flow-inner .w.cur');
    check('switching to RSVP preserves the same word', await page.evaluate(pos => __stillpoint.R.pos === pos && document.querySelector('#flow-inner .w.cur').textContent === __stillpoint.R.words[pos], saved));
    await page.evaluate(() => __stillpoint.S.countdown = 0); await page.click('#play');
    await page.waitForFunction(() => __stillpoint.R.state === 'playing'); await page.tap('#stage');
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    const rsvpPosition = await page.evaluate(() => __stillpoint.R.pos);
    await page.click('#r-book'); await page.waitForSelector('.book-viewport');
    check('returning from RSVP keeps its latest position', await page.evaluate(pos => __stillpoint.R.pos === pos, rsvpPosition));
    await page.setViewportSize({ width: 430, height: 800 }); await page.waitForTimeout(350);
    check('viewport resizing preserves the reading anchor', await page.evaluate(pos => {
      const R = __stillpoint.R, rect = R.bookView.wordEl(pos).getBoundingClientRect(), frame = R.bookView.viewport.getBoundingClientRect();
      return R.pos === pos && rect.right > frame.left && rect.left < frame.right;
    }, rsvpPosition));
    check('no application errors', errors.length === 0);
    console.log(`${count} book-reader checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
