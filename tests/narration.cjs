// Word mapping, audio-clock playback, storage, backup and restore. No speech models needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
let passed = 0;
function check(label, condition) { assert.ok(condition, label); console.log(`PASS ${label}`); passed++; }

function tone(seconds) {
  const rate = 8000, samples = Math.ceil(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), 44 + i * 2);
  return wav;
}

async function packageFor(job) {
  const zip = new JSZip();
  const words = job.blocks.flatMap(b => b.tokens.map((_, offset) => ({ sid: b.sid, offset })));
  const half = Math.ceil(words.length / 2);
  const clips = [words.slice(0, half), words.slice(half)].filter(c => c.length).map((group, i) => {
    const file = `audio/clip-${String(i).padStart(5, '0')}.wav`;
    const durationMs = group.length * 180 + 200;
    zip.file(file, tone(durationMs / 1000));
    return { file, durationMs, words: group.map((w, j) => ({ ...w, startMs: j * 180, endMs: (j + 1) * 180, status: 'test-fixture' })) };
  });
  const manifest = { format: 'stillpoint-audiobook', version: 1, tokenizer: job.tokenizer, textHash: job.textHash, clips };
  zip.file('audiobook.json', JSON.stringify(manifest));
  return { manifest, zip, bytes: await zip.generateAsync({ type: 'nodebuffer' }) };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce', acceptDownloads: true });
    await context.addInitScript(() => {
      window.__mediaActions = {};
      window.__audioBlobs = new Map();
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = createObjectURL(blob);
        window.__audioBlobs.set(url, { type: blob.type, size: blob.size });
        return url;
      };
      if (navigator.mediaSession) {
        const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
        navigator.mediaSession.setActionHandler = (action, handler) => { window.__mediaActions[action] = handler; original(action, handler); };
      }
      // This tests lifecycle logic, not a physical iPhone lock or OS suspension.
      window.__testHidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__testHidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.__testHidden ? 'hidden' : 'visible' });
      window.__setHidden = hidden => { window.__testHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    });
    const page = await context.newPage();
    const readFromHere = async index => {
      await page.locator(`#flow-inner [data-i="${index}"]`).dispatchEvent('pointerdown', {
        pointerId: 71, pointerType: 'touch', button: 0, clientX: 120, clientY: 300,
      });
      await page.waitForSelector('[data-a="start"]');
      await page.locator('#reader').dispatchEvent('pointerup', { pointerId: 71, pointerType: 'touch', clientX: 120, clientY: 300 });
      await page.click('[data-a="start"]');
      await page.waitForFunction(i => __stillpoint.R.pos === i && __stillpoint.R.state === 'paused', index);
      await page.waitForTimeout(400);
      return page.evaluate(i => __stillpoint.R.pos === i && __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused, index);
    };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost:8123') return route.abort();
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + path.sep)) return route.fulfill({ status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      await route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto('http://localhost:8123');
    await page.waitForSelector('#empty-add');
    const job = await page.evaluate(async () => {
      const db = await import('/js/db.js');
      const { buildIndex } = await import('/js/engine.js');
      const { createNarrationJob } = await import('/js/narration.js');
      const blocks = [
        { sid: 'epub:0', k: 'p', t: 'The light at the window had changed. Beyond the garden, the river moved quietly between the trees.' },
        { sid: 'epub:1', k: 'p', t: '“We have time,” she said. “The boat will wait until morning.” He set $12 on the table and turned toward the door.' },
      ];
      const book = { id: 'narration-test', title: 'A Morning by the River', author: 'Original test passage', pos: 0,
        wordCount: buildIndex(blocks).words.length, addedAt: Date.now(), chapters: [{ title: 'Chapter One', block: 0 }], bookmarks: [] };
      await db.saveBook(book, { id: book.id, blocks });
      return createNarrationJob(book, { blocks });
    });
    if (process.env.SAMPLE_JOB) fs.writeFileSync(process.env.SAMPLE_JOB, JSON.stringify(job));
    check('job uses the reader’s tokens and passage identities', job.blocks[1].tokens.some(t => t.w === '$12') && job.blocks[0].sid === 'epub:0');
    let { manifest, zip, bytes } = await packageFor(job);
    if (process.env.REAL_AUDIO) {
      bytes = fs.readFileSync(process.env.REAL_AUDIO);
      zip = await JSZip.loadAsync(bytes);
      manifest = JSON.parse(await zip.file('audiobook.json').async('string'));
    }
    const firstFile = manifest.clips[0].file;
    const invalid = await page.evaluate(async ({ job, manifest }) => {
      const { validateManifest } = await import('/js/narration.js');
      const reject = change => { const m = structuredClone(manifest); change(m); try { validateManifest(m, job); return false; } catch { return true; } };
      return [reject(m => m.textHash = 'wrong'), reject(m => m.clips[0].words.pop()),
        reject(m => m.clips[0].words[0].endMs = -1), reject(m => m.clips[0].file = '../bad.wav'),
        reject(m => m.clips[0].words[1].offset = 9), reject(m => m.clips[0].words[0].startMs = null)];
    }, { job, manifest });
    check('import rejects mismatches, missing words, unsafe paths and invalid times', invalid.every(Boolean));
    await page.reload();
    await page.click('.book-title');
    await page.waitForSelector('#reader');
    await page.click('#r-audio');
    const download = page.waitForEvent('download');
    await page.click('#narration-export');
    const exported = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
    check('export button produces the exact narration job', exported.textHash === job.textHash);
    await page.setInputFiles('#narration-import', { name: 'audiobook.zip', mimeType: 'application/zip', buffer: bytes });
    await page.waitForFunction(() => !!window.__stillpoint.R?.narration);
    check('import attaches audio to the existing book', await page.evaluate(() => __stillpoint.R.book.audioMode === 'page'));
    check('imported media has an audio MIME type on its playback URL', await page.evaluate(() => {
      const player = __stillpoint.R.narration;
      const blob = __audioBlobs.get(player.audio.src);
      return blob.type === (player.manifest.clips[0].file.endsWith('.m4a') ? 'audio/mp4' : 'audio/wav');
    }));
    await page.evaluate(() => { __stillpoint.S.tapToPlay = true; __stillpoint.S.holdMode = true; });
    await page.locator('#flow-inner .w.cur').tap();
    await page.waitForTimeout(200);
    check('tapping paused text never starts playback, including with old control settings', await page.evaluate(() =>
      __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    await page.click('#play');
    await page.waitForFunction(() => __stillpoint.R.pos >= 2 && __stillpoint.R.state === 'playing');
    check('audio clock advances and highlights scrolling text', await page.evaluate(() =>
      document.querySelector('.w.cur')?.textContent === __stillpoint.R.words[__stillpoint.R.pos]
      && getComputedStyle(document.querySelector('#flow')).opacity === '1'));
    check('system media controls expose book metadata and playback actions', await page.evaluate(() =>
      navigator.mediaSession.metadata.title === __stillpoint.R.book.title
      && ['play', 'pause', 'seekto', 'seekforward', 'seekbackward'].every(a => typeof __mediaActions[a] === 'function')));
    const hiddenStart = await page.evaluate(() => {
      __setHidden(true);
      return { time: __stillpoint.R.narration.audio.currentTime, word: document.querySelector('.w.cur').dataset.i };
    });
    await page.waitForTimeout(1000);
    check('simulated screen hiding leaves native audio playing without visual updates', await page.evaluate(before =>
      __stillpoint.R.state === 'playing' && !__stillpoint.R.narration.audio.paused
      && __stillpoint.R.narration.background && __stillpoint.R.narration.audio.currentTime > before.time + 0.5
      && document.querySelector('.w.cur').dataset.i === before.word, hiddenStart));
    await page.evaluate(() => __setHidden(false));
    check('returning to the reader resynchronizes the current word', await page.evaluate(() =>
      !__stillpoint.R.narration.background && document.querySelector('.w.cur').textContent === __stillpoint.R.words[__stillpoint.R.pos]));
    await page.evaluate(() => __mediaActions.pause());
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    check('system pause stops narration', await page.evaluate(() => __stillpoint.R.narration.audio.paused && navigator.mediaSession.playbackState === 'paused'));
    const pausedTime = await page.evaluate(() => __stillpoint.R.narration.audio.currentTime);
    await page.evaluate(() => __mediaActions.play());
    await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    check('system play resumes at the paused media position', await page.evaluate(before =>
      __stillpoint.R.narration.audio.currentTime >= before && __stillpoint.R.narration.audio.currentTime < before + 0.5, pausedTime));
    await page.evaluate(() => __stillpoint.R.narration.audio.pause());
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    check('native audio interruption updates reader playback state', await page.evaluate(() => !__stillpoint.R.narration.playing));
    await page.evaluate(() => __mediaActions.seekto({ seekTime: 0.7 }));
    await page.waitForFunction(() => __stillpoint.R.narration.audio.currentTime > 0.1 && __stillpoint.R.narration.audio.currentTime <= 0.7);
    check('system seeking while paused keeps narration paused', await page.evaluate(() => __stillpoint.R.narration.audio.paused && __stillpoint.R.state === 'paused'));
    await page.evaluate(() => __mediaActions.play());
    await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    await page.click('#play');
    const paused = await page.evaluate(() => __stillpoint.R.pos);
    await page.waitForTimeout(450);
    check('pause stops audio and word advancement', await page.evaluate(pos => __stillpoint.R.pos === pos && __stillpoint.R.narration.audio.paused, paused));
    check('Read from here seeks narration and waits for Play', await readFromHere(8));
    check('native text selection and callout are suppressed', await page.evaluate(() => {
      const word = document.querySelector('#flow-inner .w');
      return !word.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))
        && !word.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    }));
    await page.click('#r-audio');
    await page.selectOption('#narration-mode', 'rsvp');
    check('reading mode is the first control in the audiobook menu', await page.evaluate(() =>
      document.querySelector('#narration-mode').closest('.sheet-body').firstElementChild.contains(document.querySelector('#narration-mode'))));
    await page.selectOption('#narration-rate', '1.5');
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'audiobook-controls.png') });
    await page.click('[data-close]');
    await page.locator('#flow-inner .w.cur').tap();
    await page.waitForTimeout(200);
    check('audio RSVP waits for the Play button after a text tap', await page.evaluate(() => __stillpoint.R.state === 'paused' && __stillpoint.R.narration.audio.paused));
    await page.click('#play');
    await page.waitForFunction(() => __stillpoint.R.state === 'playing');
    check('RSVP follows the current audio word at the selected playback rate', await page.evaluate(() =>
      __stillpoint.R.narration.audio.playbackRate === 1.5
      && (document.querySelector('#w-left').textContent + document.querySelector('#w-pivot').textContent + document.querySelector('#w-right').textContent) === __stillpoint.R.words[__stillpoint.R.pos]));
    // Jump with the keyboard while audio is playing. It must seek the media too.
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => __stillpoint.R.narration.audio.currentTime > 0.5);
    check('reading-position jumps seek the audio', await page.evaluate(() => __stillpoint.R.narration.pos === __stillpoint.R.pos));
    if (manifest.clips.length > 1) {
      await page.waitForFunction(() => __stillpoint.R.narration.clipIndex === 1);
      check('legacy playback crosses audio clip boundaries', await page.evaluate(() => __stillpoint.R.pos >= __stillpoint.R.narration.starts[1]));
    } else {
      const source = await page.evaluate(() => __stillpoint.R.narration.audio.src);
      await page.waitForFunction(() => __stillpoint.R.blocks[__stillpoint.R.wordBlock[__stillpoint.R.pos]].sid === 'epub:1');
      check('continuous playback crosses source passages without changing media files', await page.evaluate(src => __stillpoint.R.narration.audio.src === src, source));
    }
    // Pause using the public UI after the hidden RSVP controls return via tapping.
    await page.tap('#stage');
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    await page.click('#r-audio');
    await page.selectOption('#narration-mode', 'off');
    await page.click('[data-close]');
    await page.locator('#flow-inner .w.cur').tap();
    await page.waitForTimeout(200);
    check('independent RSVP waits for the Play button after a text tap', await page.evaluate(() => __stillpoint.R.state === 'paused'));
    await page.click('#play');
    await page.waitForFunction(() => __stillpoint.R.state === 'starting' || __stillpoint.R.state === 'playing');
    check('independent RSVP leaves narration paused', await page.evaluate(() => __stillpoint.R.narration.audio.paused));
    await page.evaluate(() => __setHidden(true));
    await page.waitForFunction(() => __stillpoint.R.state === 'paused');
    check('independent RSVP still pauses when hidden', await page.evaluate(() => __stillpoint.R.state === 'paused'));
    await page.evaluate(() => __setHidden(false));
    check('Read from here also leaves independent RSVP paused', await readFromHere(2));
    check('turning narration off releases system media controls', await page.evaluate(() => navigator.mediaSession.metadata === null && !__mediaActions.play));
    await page.click('#r-back');
    // Audio saved by the first release has an empty type. Reopening must repair it
    // in memory, without changing its bytes or asking the reader to reimport.
    await page.evaluate(async () => {
      const db = await import('/js/db.js');
      for (const record of await db.getAll('narrationdata')) {
        record.data = record.data.slice(0, record.data.size, '');
        await db.put('narrationdata', record);
      }
    });
    await page.click('.book-title');
    await page.waitForSelector('#reader');
    check('saved audio survives reopening', await page.evaluate(() => !!__stillpoint.R.narration));
    check('previously saved untyped audio is repaired without reimport', await page.evaluate(async () => {
      const player = __stillpoint.R.narration;
      const db = await import('/js/db.js');
      const saved = await db.get('narrationdata', `${__stillpoint.R.book.id}:${player.manifest.clips[0].file}`);
      const played = __audioBlobs.get(player.audio.src);
      return saved.data.type === '' && played.type.startsWith('audio/') && saved.data.size === played.size;
    }));
    // Broken replacement must leave all previous audio intact.
    zip.remove(manifest.clips[0].file);
    await page.click('#r-audio');
    await page.setInputFiles('#narration-import', { name: 'broken.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
    await page.waitForFunction(() => document.querySelector('#narration-status').textContent.includes('missing'));
    check('failed replacement preserves saved narration', await page.evaluate(async file => {
      const db = await import('/js/db.js'); return !!(await db.get('narrationdata', `narration-test:${file}`))?.data;
    }, firstFile));
    await page.click('[data-close]');
    // Exercise the normal backup path, including audiobook binary data.
    await page.click('#r-settings');
    await page.click('[data-page="Library and data"]');
    const backupDownload = page.waitForEvent('download');
    await page.click('[data-a="backup"]');
    const backupBytes = fs.readFileSync(await (await backupDownload).path());
    const backup = await JSZip.loadAsync(backupBytes);
    check('backup includes narration metadata and audio', !!backup.file('narrations/narration-test.json') && !!backup.file(`narrations/narration-test/${firstFile}`));
    await page.evaluate(async () => { const db = await import('/js/db.js'); await db.removeNarration('narration-test'); });
    await page.setInputFiles('#restore', { name: 'backup.zip', mimeType: 'application/zip', buffer: backupBytes });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Restored'));
    check('backup restores playable audio blobs', await page.evaluate(async file => { const db = await import('/js/db.js'); return (await db.get('narrationdata', `narration-test:${file}`)).data.size > 44; }, firstFile));
    await page.reload();
    await page.waitForSelector('#reader');
    // Simulate a reviewed-text change. Old audio must not be attached.
    await page.evaluate(async () => {
      const db = await import('/js/db.js'); const content = await db.get('contents', 'narration-test');
      content.blocks[0].t += ' Changed.'; await db.put('contents', content);
    });
    await page.reload();
    await page.waitForSelector('#reader');
    check('text edits disable stale audio alignment', await page.evaluate(() => !__stillpoint.R.narration && !!__stillpoint.R.narrationError));
    await page.click('#r-audio');
    check('text mismatch has a recovery explanation', /Export a new narration job/.test(await page.textContent('#narration-status')));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'audiobook-settings.png') });
    await page.evaluate(async () => { const db = await import('/js/db.js'); await db.deleteBook('narration-test'); });
    check('deleting a book also deletes its narration', await page.evaluate(async () => { const db = await import('/js/db.js'); return !(await db.get('narrations', 'narration-test')) && (await db.getAll('narrationdata')).length === 0; }));
    check('no browser application errors', errors.length === 0);
    console.log(`${passed} audiobook checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
