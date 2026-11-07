// Exercise an actual service-worker upgrade, HTTP-cache bypass and retained IDB data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const currentWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const cacheName = currentWorker.match(/const CACHE = '([^']+)'/)[1];
const oldWorker = `self.addEventListener('install', e => e.waitUntil(caches.open('stillpoint-old-test').then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));`;
let published = false;

(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      response.end(published ? currentWorker : oldWorker); return;
    }
    const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    const data = fs.readFileSync(file);
    response.end(file.endsWith(`${path.sep}js${path.sep}app.js`)
      ? Buffer.concat([data, Buffer.from(published ? '\nwindow.__appDelivery = "new";' : '\nwindow.__appDelivery = "old"; /* previous-http-cache */')])
      : !published && file.endsWith('.css') ? Buffer.concat([data, Buffer.from('\n/* previous-http-cache */')]) : data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ serviceWorkers: 'allow', reducedMotion: 'reduce' });
    await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForSelector('#empty-add');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      const db = await import('/js/db.js');
      await db.saveBook({ id: 'update-test', title: 'Keep my book', author: '', pos: 17, wordCount: 80,
        addedAt: Date.now(), chapters: [], bookmarks: [{ word: 12, label: 'Keep my bookmark' }] },
      { id: 'update-test', blocks: [{ sid: 'test:0', k: 'p', t: Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') }] });
      await db.put('kv', 'update-test', 'lastBook');
    });
    await page.reload(); await page.waitForSelector('#reader');
    assert.equal(await page.evaluate(() => __stillpoint.R.pos), 17);
    published = true;
    await page.click('#r-settings');
    await page.click('[data-page="Library and data"]');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }),
      page.click('[data-a="app-update"]'),
    ]);
    await page.waitForSelector('#reader');
    const result = await page.evaluate(async cacheName => {
      const cache = await caches.open(cacheName);
      const app = await cache.match(new URL('js/app.js', location.href).href);
      return { caches: await caches.keys(), position: __stillpoint.R.pos, title: __stillpoint.R.book.title,
        bookmark: __stillpoint.R.book.bookmarks[0].word, words: __stillpoint.R.words.length,
        delivery: window.__appDelivery, fresh: app && !(await app.text()).includes('previous-http-cache') };
    }, cacheName);
    assert.equal(result.position, 17); assert.equal(result.title, 'Keep my book');
    assert.equal(result.bookmark, 12); assert.equal(result.words, 80);
    assert.ok(result.fresh); assert.equal(result.delivery, 'new'); assert.deepEqual(result.caches, [cacheName]);
    assert.deepEqual(errors, []);
    console.log('PASS app update activates the latest worker and bypasses old HTTP-cached files');
    console.log('PASS app update preserves books, reading position and bookmarks');
    console.log(JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exit(1); });
