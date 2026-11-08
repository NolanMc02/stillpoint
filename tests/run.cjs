const { chromium, devices } = require('playwright');
const path = require('path');
const S = path.join(__dirname, 'samples');
const SHOTS = process.env.SHOTS;
const results = [];
const ok = (name, cond, info = '') => { results.push([!!cond, name, info]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info !== '' ? '  [' + info + ']' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
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
    if (file.endsWith('.epub')) { await page.waitForSelector('#book-add'); await page.click('#book-add'); }
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
  await page.waitForSelector('#book-add');
  await page.click('#book-add');
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
  // Explicitly choose RSVP before testing its default countdown.
  await page.click('#r-mode'); await page.click('[data-mode="rsvp"]'); await page.click('[data-close]');
  const start = await sp(() => __stillpoint.R.pos);
  await page.tap('#flow-inner p');
  await sleep(150);
  ok('tapping paused text does not start RSVP', await sp(() => __stillpoint.R.state === 'paused'));
  await page.tap('#play');
  ok('Play starts the RSVP countdown', await sp(() => document.querySelector('#reader').classList.contains('starting')));
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
  const mid = xs[0];
  ok('highlighted letter is centered on screen', Math.abs(mid - 393 / 2) < 1, `${mid.toFixed(1)} of 393`);
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
  const dragScrub = v => page.evaluate(n => { const s = document.querySelector('#scrub'); s.value = n; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); }, v);
  const spot = await sp(() => __stillpoint.R.pos);
  await dragScrub(50);
  await sleep(300);
  ok('progress bar asks before moving', (await sp(() => __stillpoint.R.pos)) === spot && !(await sp(() => document.querySelector('#jump-bar').hidden)));
  await page.tap('#jump-back'); await sleep(200);
  ok('back to my spot keeps your place', (await sp(() => __stillpoint.R.pos)) === spot && (await sp(() => __stillpoint.R.book.pos)) === spot && await sp(() => document.querySelector('#jump-bar').hidden));
  await dragScrub(50);
  await sleep(200);
  await page.tap('#jump-go'); await sleep(500);
  ok('jump here moves position', (await sp(() => __stillpoint.R.pos)) === 50);
  await page.evaluate(() => { document.querySelector('#flow').scrollTop += 3000; });
  await sleep(200);
  ok('back to my place appears after scrolling away', !(await sp(() => document.querySelector('#back-place').hidden)));
  await page.tap('#back-place'); await sleep(200);
  ok('back to my place returns', await sp(() => document.querySelector('#back-place').hidden));

  // Focus mark distance
  const tickGap = () => sp(() => { const r = document.querySelector('#rail').getBoundingClientRect(); return r.top - document.querySelector('#tick-a').getBoundingClientRect().top; });
  const gapNormal = await tickGap();
  await sp(() => document.documentElement.style.setProperty('--guide-dist', 2));
  const gapWide = await tickGap();
  await sp(() => document.documentElement.style.setProperty('--guide-dist', 1));
  ok('focus marks can sit twice as far away', Math.abs(gapWide / gapNormal - 2) < 0.1, `${Math.round(gapNormal)} px to ${Math.round(gapWide)} px`);

  // Custom audio tracks
  const wav = Buffer.alloc(44 + 22050 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(22050 * 2, 40);
  for (let i = 0; i < 22050; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 9000), 44 + i * 2);
  await page.tap('#r-settings'); await page.waitForSelector('.set-nav');
  await page.tap('[data-page="Audio"]'); await page.waitForSelector('#add-track', { state: 'attached' });
  await page.setInputFiles('#add-track', [{ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav }, { name: 'bad.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(3000) }]);
  await page.waitForSelector('[data-pick^="c:"]', { timeout: 8000 });
  ok('an audio file can be added, and a broken one is refused', (await page.$$('[data-pick^="c:"]')).length === 1 && /could not be read/.test(await page.textContent('#toast')));
  await page.tap('[data-pick^="c:"]'); await sleep(500);
  ok('your track can be chosen', (await sp(() => __stillpoint.S.sound.startsWith('c:'))) && !!(await page.$('#track-level')));
  await page.tap('[data-ask="rain"]'); await sleep(200);
  ok('a built-in track can be removed', !(await page.$('[data-pick=rain]')));
  await page.tap('[data-a=restore-sounds]'); await sleep(200);
  ok('restore brings back built-ins and keeps yours', !!(await page.$('[data-pick=rain]')) && !!(await page.$('[data-pick^="c:"]')));
  await page.tap('[data-ask^="c:"]'); await page.tap('[data-remove]'); await sleep(500);
  ok('your track can be removed', !(await page.$('[data-pick^="c:"]')) && (await sp(() => __stillpoint.S.sound)) === 'off');
  await page.click('[data-close]').catch(() => {});
  await sleep(300);

  // Long press
  const wEl = await page.$('.w.cur');
  const box = await wEl.boundingBox();
  await touch('touchStart', box.x + 4, box.y + 4); await sleep(620); await touch('touchEnd');
  await sleep(100);
  ok('press and hold opens word menu', (await page.textContent('.sheet-head h2').catch(() => '')) === 'This word');
  await page.click('[data-close]').catch(() => {});


  // Speed slider
  await page.tap('#wpm-box'); await sleep(350);
  await shot('14-slider');
  ok('tapping the speed opens the slider', await sp(() => document.querySelector('#wpm-pop').classList.contains('open') && getComputedStyle(document.querySelector('#wpm-pop')).opacity === '1'));
  await sp(() => { const r = document.querySelector('#wpm-slider'); r.value = 640; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  ok('slider sets an exact speed', (await sp(() => __stillpoint.R.wpm)) === 640 && (await page.textContent('#wpm-v')) === '640');
  await page.tap('#flow-inner p'); await sleep(350);
  ok('tapping outside closes the slider without playing', await sp(() => !document.querySelector('#wpm-pop').classList.contains('open') && __stillpoint.R.state === 'paused'));
  await sleep(300);
  await sp(() => { __stillpoint.R.wpm = 300; });

  // Sheet motion
  await page.tap('#r-toc'); await sleep(60);
  const moving = await sp(() => document.querySelector('.sheet').getAnimations().length > 0);
  ok('sheets animate in', moving);
  await sleep(450);
  await page.click('[data-close]'); await sleep(60);
  ok('sheets animate out', await sp(() => !!document.querySelector('.scrim.leaving')));
  await sleep(450);
  ok('closed sheets are removed', await sp(() => !document.querySelector('.scrim')));
  await page.tap('#r-toc'); await sleep(450);
  const hb = await (await page.$('.sheet-head h2')).boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + 10); await page.mouse.down(); await page.mouse.move(hb.x + 40, hb.y + 220, { steps: 6 }); await page.mouse.up();
  await sleep(450);
  ok('dragging a sheet down dismisses it', await sp(() => !document.querySelector('.scrim')));

  // Settings
  const setPage = async name => { await page.tap(`[data-page="${name}"]`); await sleep(320); };
  const setBack = async () => { await page.tap('#set-back'); await sleep(320); };
  await page.tap('#r-settings'); await page.waitForSelector('.set-nav'); await sleep(450);
  await shot('10-settings');
  ok('settings opens to a short list of sections', (await page.$$('.set-nav')).length === 5, (await page.$$('.set-nav')).length);
  ok('main settings page has no back button', await sp(() => getComputedStyle(document.querySelector('#set-back')).display === 'none'));
  ok('settings list has no floating preview', !(await page.$('.preview')));
  const setInput = (id, v) => sp2(id, v);
  const sp2 = (id, v) => page.evaluate(([i, val]) => { const el = document.querySelector(i); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
  await setPage('RSVP');
  await shot('11-settings-word');
  ok('section page shows a preview', !!(await page.$('.preview .pv-rail')));
  const noOverlap = await sp(() => { const p = document.querySelector('.preview').getBoundingClientRect(); const b = document.querySelector('#set-body').getBoundingClientRect(); return b.top >= p.bottom; });
  ok('preview stays above the scrolling list', noOverlap);
  await setInput('#s-wordSize', 70);
  await setInput('#s-pivotMode', 'middle');
  const applied = await sp(() => ({ size: getComputedStyle(document.documentElement).getPropertyValue('--word-size'), mode: __stillpoint.S.pivotMode }));
  await setInput('#s-wordSize', 48);
  await setInput('#s-pivotMode', 'orp');
  await setBack();
  ok('back returns to the section list', (await page.$$('.set-nav')).length === 5);
  ok('section summary reflects choices', /WPM/.test(await page.textContent('[data-page="RSVP"]')));
  await setPage('Appearance');
  await page.tap('[data-theme-pick=paper]'); await sleep(450);
  applied.bg = await sp(() => getComputedStyle(document.body).backgroundColor);
  ok('settings apply live', applied.size === '70px' && applied.mode === 'middle' && applied.bg === 'rgb(247, 248, 245)', JSON.stringify(applied));
  ok('custom color rows stay hidden until chosen', await sp(() => document.querySelector('.custom-rows').hidden));
  await page.tap('[data-theme-pick=custom]'); await sleep(450);
  await shot('12-settings-colors');
  await page.fill('[data-hex=customHi]', '#00ff88');
  ok('hex colors apply', await sp(() => __stillpoint.S.theme === 'custom' && __stillpoint.S.customHi === '#00ff88'));
  await page.tap('[data-theme-pick=tide]'); await sleep(450);
  await setBack();
  for (const [name, id] of [['Appearance', '#s-textFont'], ['RSVP', '#s-wpm'], ['Audio', '.track-list'], ['Reading goal', '#s-dailyGoal'], ['Library and data', '[data-a=backup]']]) {
    await setPage(name);
    ok(`${name} page opens`, !!(await page.$(id)));
    await setBack();
  }
  await page.click('[data-close]');
  await sleep(450);

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

  // Streak logic
  const logic = await page.evaluate(async () => {
    const { computeStreaks, monthGrid } = await import('/js/streaks.js');
    const m = o => new Map(Object.entries(o));
    const min = n => n * 60000;
    const base = { goalMs: min(10), weekGoalDays: 1, weekStart: 0, today: '2026-11-04' };
    return {
      alive: computeStreaks({ ...base, dayMs: m({ '2026-11-03': min(10), '2026-11-02': min(12), '2026-11-01': min(30) }) }),
      withToday: computeStreaks({ ...base, dayMs: m({ '2026-11-04': min(11), '2026-11-03': min(10) }) }),
      broken: computeStreaks({ ...base, dayMs: m({ '2026-11-02': min(10), '2026-11-01': min(10) }) }),
      short: computeStreaks({ ...base, dayMs: m({ '2026-11-03': min(9) }) }),
      weeks: computeStreaks({ ...base, dayMs: m({ '2026-11-01': min(10), '2026-10-27': min(10), '2026-10-20': min(10), '2026-10-05': min(10) }) }),
      weeksStrict: computeStreaks({ ...base, weekGoalDays: 2, dayMs: m({ '2026-11-01': min(10), '2026-10-27': min(10), '2026-10-28': min(10), '2026-10-20': min(10), '2026-10-21': min(10) }) }),
      dst: computeStreaks({ ...base, today: '2026-03-09', dayMs: m({ '2026-03-07': min(10), '2026-03-08': min(10), '2026-03-09': min(10) }) }),
      grid: monthGrid(2026, 10, 0).slice(0, 2), gridMon: monthGrid(2026, 10, 1).slice(0, 8).filter(x => !x).length,
    };
  });
  ok('day streak survives until today is over', logic.alive.days === 3, logic.alive.days);
  ok('today counts once the goal is met', logic.withToday.days === 2);
  ok('a missed full day breaks the streak', logic.broken.days === 0 && logic.broken.bestDays === 2);
  ok('reading under the minimum does not count', logic.short.days === 0);
  ok('weeks in a row and best weeks', logic.weeks.weeks === 3 && logic.weeks.bestWeeks === 3, JSON.stringify([logic.weeks.weeks, logic.weeks.bestWeeks]));
  ok('a stricter week goal holds an open week', logic.weeksStrict.weeks === 2, logic.weeksStrict.weeks);
  ok('streaks work across daylight saving change', logic.dst.days === 3);
  ok('calendar starts on the right weekday', logic.grid[0] === '2026-11-01' && logic.gridMon === 6, logic.gridMon);

  // Seeded calendar
  await page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('stillpoint');
    r.onsuccess = () => {
      const tx = r.result.transaction('sessions', 'readwrite');
      const st = tx.objectStore('sessions');
      const key = back => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      [[0, 4], [1, 15], [2, 11], [3, 22], [5, 3]].forEach(([b, m]) => st.put({ bookId: 'x', title: 'Seed', day: key(b), at: Date.now() - b * 86400000, ms: m * 60000, words: m * 280 }));
      tx.oncomplete = res;
    };
  }));
  await page.click('#stats-back'); await page.waitForSelector('.book-row'); await sleep(350);
  await page.tap('#go-stats'); await page.waitForSelector('#streak-days'); await sleep(400);
  await shot('15-streaks');
  ok('stats show days in a row', (await page.textContent('#streak-days')) === '3', await page.textContent('#streak-days'));
  ok('calendar marks goal days and read days', await sp(() => document.querySelectorAll('.cal-day.hit').length >= 1 && document.querySelector('.cal-day.today.read') !== null));
  await page.tap('.cal-day.today'); await sleep(100);
  ok('tapping a day shows its details', /Under your 10 min goal/.test(await page.textContent('#cal-detail')), await page.textContent('#cal-detail'));
  await page.tap('#goal-edit'); await page.waitForSelector('#g-dailyGoal'); await sleep(450);
  await shot('16-goal');
  await sp(() => { const r = document.querySelector('#g-dailyGoal'); r.value = 3; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(100);
  ok('changing the minimum updates the streak', (await page.textContent('#streak-days')) === '4', await page.textContent('#streak-days'));
  await page.click('[data-close]'); await sleep(450);
  await page.tap('#cal-prev'); await sleep(150);
  ok('calendar moves between months', !!(await page.textContent('#cal-title')));
  await page.tap('#cal-next'); await sleep(150);
  await sp(() => { __stillpoint.S.dailyGoal = 10; });

  await page.click('#stats-back');
  await page.waitForSelector('.book-row');

  // Backup roundtrip
  await page.tap('#go-settings'); await page.waitForSelector('.set-nav'); await sleep(400);
  await page.tap('[data-page="Library and data"]'); await page.waitForSelector('[data-a=backup]'); await sleep(320);
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

  // Obsolete saved hold settings cannot start playback; Play supports multi-word RSVP.
  await sp(() => { __stillpoint.S.holdMode = true; __stillpoint.S.wordsPerFlash = 2; __stillpoint.S.countdown = 0; });
  await page.click('.book-open >> nth=0');
  await page.waitForSelector('#reader');
  await sleep(450);
  await touch('touchStart', 200, 400); await sleep(700);
  ok('holding text does not start RSVP', await sp(() => __stillpoint.R.state === 'paused'));
  await touch('touchEnd'); await sleep(300);
  if (await page.$('[data-close]')) await page.click('[data-close]');
  await page.tap('#play'); await sleep(300);
  ok('Play starts multi-word RSVP', await sp(() => __stillpoint.R.state === 'playing'));
  ok('multiple words per flash work', /\S\s\S|—\S/.test(await sp(() => __stillpoint.R.lastText)), await sp(() => __stillpoint.R.lastText));
  await page.tap('#stage'); await sleep(300);
  ok('tapping active RSVP pauses it', await sp(() => __stillpoint.R.state === 'paused'));
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

  ok('edge strips can be found by iOS', await sp(() => { document.documentElement.style.setProperty('--safe-t', '59px'); const out = [4, 63].every(y => document.elementFromPoint(innerWidth / 2, y)?.classList.contains('edge-top')); const r = document.querySelector('.edge-top').getBoundingClientRect(); const c = getComputedStyle(document.querySelector('.edge-top')); document.documentElement.style.removeProperty('--safe-t'); return out && r.height > 10 && r.width >= innerWidth * .9 && c.position === 'fixed' && !/rgba|transparent/.test(c.backgroundColor) && c.pointerEvents !== 'none'; }));
  ok('bar buttons are not covered by the edge strips', await sp(() => { const r = document.querySelector('#r-back').getBoundingClientRect(); const a = document.elementFromPoint(r.x + 22, r.y + 3); const p = document.querySelector('#play').getBoundingClientRect(); const b = document.elementFromPoint(p.x + 30, p.bottom - 3); return !!a.closest('#r-back') && !!b.closest('#play'); }));
  ok('reader bars are opaque', await sp(() => { const c = getComputedStyle(document.querySelector('#top-bar')); return !/rgba|transparent/.test(c.backgroundColor) && (c.backdropFilter === 'none' || !c.backdropFilter); }));
  ok('no app errors during the run', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
