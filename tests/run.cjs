const { chromium, devices } = require('playwright');
const path = require('path');
const S = path.join(__dirname, 'samples');
const SHOTS = process.env.SHOTS;
const results = [];
const ok = (name, cond, info = '') => { results.push([!!cond, name, info]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== '' ? '  [' + info + ']' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'allow', recordVideo: undefined });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/cdn\.jsdelivr|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = n => SHOTS ? page.screenshot({ path: `${SHOTS}/${n}.png` }) : null;
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const swipe = async (x0, y0, x1, y1, steps = 8, ms = 240) => {
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(ms / steps); }
    await touch('touchEnd');
  };
  const sp = fn => page.evaluate(fn);
  await page.goto('http://localhost:8123/');
  await page.waitForSelector('.empty');
  await shot('01-empty');

  const addFiles = async files => {
    await page.click('#go-add, #empty-add').catch(() => {});
    await page.setInputFiles('#file-pick', files.map(f => path.join(S, f)));
  };
  const backToLib = async () => { await page.click('#r-back'); await page.waitForSelector('.book-row'); };

  // Formats
  const expected = { 'book.epub': 5, 'book.docx': 5, 'book.html': 5, 'book.md': 5, 'book.txt': 5, 'book.mobi': 2 };
  for (const [file, chapters] of Object.entries(expected)) {
    await addFiles([file]);
    await page.waitForSelector('#reader');
    const info = await sp(() => { const R = __stillpoint.R; return { n: R.words.length, c: R.book.chapters.length, t: R.book.title, a: R.book.author, sample: R.words.slice(0, 12).join(' '), joined: R.words.join(' ') }; });
    ok(`${file} imports with chapters`, info.n > 50 && info.c >= chapters, `${info.n} words, ${info.c} chapters, "${info.t}"`);
    ok(`${file} keeps dash and ellipsis handling`, /bridge—/.test(info.joined) && /people…|people\.\.\./.test(info.joined) && !/ — /.test(info.joined));
    await backToLib();
  }
  await addFiles(['book.rtf']);
  await page.waitForSelector('#reader');
  let rtf = await sp(() => { const R = __stillpoint.R; return { n: R.words.length, sample: R.words.slice(0, 15).join(' '), bad: /fonttbl|colortbl|\\/.test(R.words.join(' ')) }; });
  ok('book.rtf imports cleanly', rtf.n > 300 && !rtf.bad, rtf.sample);
  await backToLib();
  await addFiles(['latin1.txt']);
  await page.waitForSelector('#reader');
  ok('older text encoding decodes', (await sp(() => __stillpoint.R.words.join(' '))).includes('Café'));
  await backToLib();

  // Rejections
  for (const [f, re] of [['scanned.pdf', /scanned/i], ['drm.epub', /DRM/], ['bad.doc', /docx/i]]) {
    await addFiles([f]);
    await page.waitForSelector('.sheet-head h2:text-matches("not added")', { timeout: 15000 });
    const text = await page.textContent('.sheet');
    ok(`${f} gives a clear message`, re.test(text), text.slice(0, 90));
    await page.click('[data-close]');
    await page.waitForSelector('.book-row');
  }

  // PDF review
  await addFiles(['book.pdf']);
  await page.waitForSelector('#pdf-add', { timeout: 30000 });
  await shot('02-pdf-review');
  const reviewText = await page.textContent('.sheet');
  ok('PDF review finds headers and numbers', /12 found/.test(reviewText), (reviewText.match(/\d+ found/g) || []).join(', '));
  await page.fill('#skip-list', '12');
  await page.dispatchEvent('#skip-list', 'change');
  await page.click('#pdf-add');
  await page.waitForSelector('#reader');
  const pdf = await sp(() => { const R = __stillpoint.R; const j = R.words.join(' '); return { n: R.words.length, c: R.book.chapters.map(c => c.title), header: /Running Header/.test(j), hyphen: /contin-/.test(j), joined: /continuation/.test(j), num: R.blocks.some(b => /^\d+$/.test(b.t)) }; });
  ok('PDF removes headers', !pdf.header);
  ok('PDF rejoins split words', pdf.joined && !pdf.hyphen);
  ok('PDF removes page numbers', !pdf.num);
  ok('PDF chapters come from outline', pdf.c.length === 3, pdf.c.join(', '));
  ok('PDF keeps chapter titles in the text', await sp(() => __stillpoint.R.blocks.filter(b => /^Chapter \d$/.test(b.t)).length === 3));
  await backToLib();
  await page.waitForTimeout(100);
  await shot('03-library');

  // Reader with EPUB
  await page.click('.book-title:text("The Quiet River") >> nth=0').catch(() => {});
  await page.waitForSelector('#reader');
  await sp(() => { document.querySelector('#r-back'); });
  await shot('04-paused');

  const anchor = () => sp(() => { const r = document.querySelector('#w-pivot').getBoundingClientRect(); return r.left + r.width / 2; });
  // Default settings: countdown then RSVP
  const start = await sp(() => __stillpoint.R.pos);
  await page.tap('#flow-inner p');
  await sleep(150);
  ok('tap starts: reader enters focus mode', await sp(() => document.querySelector('#reader').classList.contains('starting')));
  await sleep(600);
  await shot('05-countdown');
  ok('countdown shows', (await page.textContent('#count')).trim() !== '');
  await sleep(2700);
  ok('RSVP is playing after countdown', await sp(() => __stillpoint.R.state === 'playing'));
  ok('text is hidden during RSVP', (await sp(() => getComputedStyle(document.querySelector('#flow')).opacity)) === '0');
  const xs = [];
  const seen = new Set();
  const t0 = Date.now(); const p0 = await sp(() => __stillpoint.R.pos);
  while (Date.now() - t0 < 6000) { xs.push(await anchor()); seen.add(await page.textContent('#w-pivot') + await page.textContent('#w-right')); await sleep(70); }
  await shot('06-rsvp');
  const p1 = await sp(() => __stillpoint.R.pos);
  const spread = Math.max(...xs) - Math.min(...xs);
  ok('highlighted letter stays in one spot', spread < 1, `moved ${spread.toFixed(2)}px over ${xs.length} samples, ${seen.size} words`);
  const rate = (p1 - p0) / 6 * 60;
  ok('speed moves words steadily', rate > 100 && rate < 300, `${Math.round(rate)} words per minute in the first 6 seconds at 300 WPM`);

  // Swipes while playing
  const w0 = await sp(() => __stillpoint.R.wpm);
  await swipe(100, 500, 300, 500);
  const w1 = await sp(() => __stillpoint.R.wpm);
  ok('swipe right raises WPM', w1 > w0, `${w0} to ${w1}`);
  await swipe(300, 500, 100, 500);
  ok('swipe left lowers WPM', (await sp(() => __stillpoint.R.wpm)) < w1);
  ok('still playing after swipes', await sp(() => __stillpoint.R.state === 'playing'));
  const pr0 = await sp(() => __stillpoint.R.pos);
  await swipe(200, 300, 200, 560, 10, 500);
  const pr1 = await sp(() => __stillpoint.R.pos);
  ok('swipe down rewinds', pr1 < pr0, `${pr0} to ${pr1}`);
  await sleep(600);
  ok('reading resumes after rewinding', await sp(() => __stillpoint.R.state === 'playing'));

  // Pause
  await touch('touchStart', 200, 500); await sleep(40); await touch('touchEnd');
  await sleep(600);
  ok('tap pauses', await sp(() => __stillpoint.R.state === 'paused'));
  const cur = await sp(() => { const R = __stillpoint.R; const el = document.querySelector('.w.cur'); const f = document.querySelector('#flow').getBoundingClientRect(); const r = el?.getBoundingClientRect(); return { txt: el?.textContent, want: R.words[R.pos], top: r?.top, h: f.height, op: getComputedStyle(document.querySelector('#flow')).opacity }; });
  ok('paused view highlights the current word', cur.txt === cur.want && cur.top > 60 && cur.top < cur.h - 150, `"${cur.txt}" at y=${Math.round(cur.top)}`);
  ok('text fades back', Number(cur.op) > 0.95, cur.op);
  await shot('07-paused-mid');

  // Sideways swipe on paused text
  const wp = await sp(() => __stillpoint.R.wpm);
  await sleep(600); await swipe(100, 400, 300, 400);
  ok('sideways swipe works while paused', (await sp(() => __stillpoint.R.wpm)) > wp);
  ok('sideways swipe does not start playback', await sp(() => __stillpoint.R.state === 'paused'));

  // TOC jump
  await sleep(900);
  await page.tap('#r-toc');
  await page.waitForSelector('.toc-item');
  await shot('08-chapters');
  const chs = await page.$$('.toc-item');
  ok('chapter list opens', chs.length >= 5, chs.length);
  await chs[3].tap();
  await sleep(400);
  const jump = await sp(() => { const R = __stillpoint.R; return { pos: R.pos, want: R.chapterStarts[3], title: document.querySelector('#c-title').textContent, cur: document.querySelector('.w.cur')?.textContent }; });
  ok('chapter jump lands on the chapter', jump.pos === jump.want && jump.title === 'Chapter 3: Part of the River', jump.title);

  // Bookmark and search
  await page.tap('#r-mark');
  await sleep(100);
  await page.tap('#r-toc'); await page.waitForSelector('.tabs');
  await page.tap('[data-t=bookmarks]');
  ok('bookmark appears', (await page.$$('.mark-row')).length === 1);
  await page.tap('[data-t=search]');
  await page.fill('#q', 'pale reflection');
  await page.waitForSelector('.hit');
  await shot('09-search');
  ok('search finds a phrase', (await page.$$('.hit')).length > 5);
  await (await page.$('.hit')).tap();
  await sleep(300);
  ok('search result jumps to the phrase', (await sp(() => __stillpoint.R.words[__stillpoint.R.pos])).startsWith('pale'), await sp(() => __stillpoint.R.words[__stillpoint.R.pos]));

  // Scrubber and far-scroll windowing
  await sp(() => { const s = document.querySelector('#scrub'); s.value = 50; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
  await sleep(500);
  ok('progress bar moves position', (await sp(() => __stillpoint.R.pos)) === 50);
  await page.evaluate(() => { document.querySelector('#flow').scrollTop += 3000; });
  await sleep(200);
  ok('back to my place appears after scrolling away', !(await sp(() => document.querySelector('#back-place').hidden)));
  await page.tap('#back-place'); await sleep(200);
  ok('back to my place returns', await sp(() => document.querySelector('#back-place').hidden));

  // Long press
  const wEl = await page.$('.w.cur');
  const box = await wEl.boundingBox();
  await touch('touchStart', box.x + 4, box.y + 4); await sleep(620); await touch('touchEnd');
  await sleep(100);
  ok('press and hold opens word menu', (await page.textContent('.sheet-head h2').catch(() => '')) === 'This word');
  await page.click('[data-close]').catch(() => {});

  // Settings
  await page.tap('#r-settings'); await page.waitForSelector('#set-body');
  await shot('10-settings');
  const applied = await sp(() => {
    const out = {};
    const set = (id, v) => { const el = document.querySelector(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#s-wordSize', 70); out.size = getComputedStyle(document.documentElement).getPropertyValue('--word-size');
    set('#s-pivotMode', 'middle'); out.mode = __stillpoint.S.pivotMode;
    document.querySelector('[data-theme-pick=paper]').click(); out.bg = getComputedStyle(document.body).backgroundColor;
    return out;
  });
  ok('settings apply live', applied.size === '70px' && applied.mode === 'middle' && applied.bg === 'rgb(247, 248, 245)', JSON.stringify(applied));
  await shot('11-settings-paper');
  await sp(() => { document.querySelector('[data-theme-pick=oled]').click(); const el = document.querySelector('#s-pivotMode'); el.value = 'orp'; el.dispatchEvent(new Event('input', { bubbles: true })); const s = document.querySelector('#s-wordSize'); s.value = 48; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.fill('[data-hex=customHi]', '#00ff88');
  ok('hex colors apply', await sp(() => __stillpoint.S.theme === 'custom' && __stillpoint.S.customHi === '#00ff88'));
  await sp(() => document.querySelector('[data-theme-pick=tide]').click());
  await page.click('[data-close]');
  await sleep(300);

  // Sustained speed, without the ramp
  const speed = await page.evaluate(async () => {
    const s = __stillpoint.S; const R = __stillpoint.R;
    const saved = [s.countdown, s.ramp, R.wpm, R.pos]; s.countdown = 0; s.ramp = 0; R.wpm = 500;
    document.querySelector('#play').click();
    await new Promise(r => setTimeout(r, 400));
    const p0 = R.pos; const t0 = performance.now();
    await new Promise(r => setTimeout(r, 12000));
    const out = (R.pos - p0) / ((performance.now() - t0) / 60000);
    document.querySelector('#stage').dispatchEvent(new Event('noop'));
    return { out, saved };
  });
  ok('sustained speed fits the setting after pauses', speed.out > 330 && speed.out < 500, `${Math.round(speed.out)} actual at 500 WPM`);
  await touch('touchStart', 200, 500); await sleep(40); await touch('touchEnd'); await sleep(800);
  await sp(() => { const s = __stillpoint.S; s.countdown = 3; s.ramp = 5; });

  // Persistence
  const posBefore = await sp(() => __stillpoint.R.pos);
  await page.reload();
  await page.waitForSelector('#reader');
  ok('reopens last book at the same word after restart', (await sp(() => __stillpoint.R.pos)) === posBefore, posBefore);

  // Stats
  await page.click('#r-back'); await page.waitForSelector('.book-row');
  await page.tap('#go-stats'); await page.waitForSelector('.screen-head');
  await sleep(200);
  await shot('12-stats');
  ok('stats recorded a session', /words read/.test(await page.textContent('#app')), (await page.textContent('.tile b').catch(() => '')));
  await page.click('#stats-back');
  await page.waitForSelector('.book-row');

  // Backup roundtrip
  await page.tap('#go-settings'); await page.waitForSelector('#set-body');
  const before = await page.evaluate(async () => { const r = indexedDB.open('stillpoint'); return await new Promise(res => { r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').count(); q.onsuccess = () => res(q.result); }; }); });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-a=backup]')]);
  const backupPath = path.join(process.env.SHOTS || S, 'backup.zip');
  await download.saveAs(backupPath);
  await page.evaluate(() => new Promise(res => { const r = indexedDB.open('stillpoint'); r.onsuccess = () => { const t = r.result.transaction(['books', 'contents'], 'readwrite'); t.objectStore('books').clear(); t.objectStore('contents').clear(); t.oncomplete = res; }; }));
  await page.setInputFiles('#restore', backupPath);
  await page.waitForFunction(() => /Restored/.test(document.querySelector('#toast').textContent));
  await page.waitForSelector('.book-row');
  const after = (await page.$$('.book-row')).length;
  ok('backup restores the whole library', after === before, `${before} books before, ${after} after`);

  // Hold to read and multi-word
  await sp(() => { __stillpoint.S.holdMode = true; __stillpoint.S.wordsPerFlash = 2; });
  await page.click('.book-open >> nth=0');
  await page.waitForSelector('#reader');
  await touch('touchStart', 200, 400); await sleep(700);
  ok('hold to read plays without a countdown', await sp(() => __stillpoint.R.state === 'playing'));
  ok('multiple words per flash work', /\S\s\S|—\S/.test(await sp(() => __stillpoint.R.lastText)), await sp(() => __stillpoint.R.lastText));
  await touch('touchEnd'); await sleep(300);
  ok('lifting pauses hold to read', await sp(() => __stillpoint.R.state === 'paused'));
  await sp(() => { __stillpoint.S.holdMode = false; __stillpoint.S.wordsPerFlash = 1; });

  // Very long word
  await page.click('#r-back'); await page.waitForSelector('.book-row');
  await page.tap('#go-add'); await page.tap('#paste-go');
  await page.fill('#paste-title', 'Edge cases');
  await page.fill('#paste-text', 'Short Pneumonoultramicroscopicsilicovolcanoconiosis https://example.com/a/very/long/path/that-goes-on-for-quite-some-time/index.html end.');
  await page.tap('#paste-save');
  await page.waitForSelector('#reader');
  const edge = await sp(() => __stillpoint.R.words);
  ok('long words and URLs split sensibly', edge.length >= 3, edge.length);
  await page.tap('#play');
  await sleep(320);
  let maxRight = 0; let minLeft = 1e9;
  const tEnd = Date.now() + 6000;
  while (Date.now() < tEnd && (await sp(() => __stillpoint.R.state)) !== 'paused') {
    const m = await sp(() => { const a = document.querySelector('#w-left').getBoundingClientRect(); const c = document.querySelector('#w-right').getBoundingClientRect(); return [a.width ? a.left : 1e9, c.right]; });
    minLeft = Math.min(minLeft, m[0]); maxRight = Math.max(maxRight, m[1]); await sleep(40);
  }
  ok('long words stay on screen', minLeft >= 0 && maxRight <= 393, `left ${Math.round(minLeft)}, right ${Math.round(maxRight)}`);
  await page.click('#r-back').catch(() => {});

  // Offline
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  await page.reload(); await sleep(800);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.book-row', { timeout: 8000 }).catch(() => {});
  ok('works offline after first load', (await page.$$('.book-row')).length > 0);
  await ctx.setOffline(false);

  // Landscape
  await page.setViewportSize({ width: 852, height: 393 });
  await page.click('.book-open >> nth=1');
  await page.waitForSelector('#reader');
  await sleep(200);
  await shot('13-landscape');

  ok('no app errors during the run', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
