// Native WebKit media regression: ZIP-extracted M4A Blobs must have an audio type.
// Run: npx playwright install webkit && node tests/audio-webkit.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'demo/audiobook.zip')));
  const manifest = JSON.parse(await zip.file('audiobook.json').async('string'));
  const clip = manifest.clips[0];
  const bytes = await zip.file(clip.file).async('base64');
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost:8123/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/media-test.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Audio regression</title>' });
      const file = path.resolve(root, `.${url.pathname}`);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(file) });
    });
    await page.goto('http://localhost:8123/media-test.html');
    const result = await page.evaluate(async ({ bytes, file }) => {
      const { playableAudioBlob } = await import('/js/narration.js');
      const raw = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))]);
      const corrected = playableAudioBlob(raw, file);
      const decode = blob => new Promise(resolve => {
        const audio = new Audio(), url = URL.createObjectURL(blob);
        let timer;
        const done = result => {
          clearTimeout(timer); audio.onerror = null; audio.onloadedmetadata = null;
          audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); resolve(result);
        };
        audio.onloadedmetadata = () => done({ success: true, duration: audio.duration });
        audio.onerror = () => done({ success: false, code: audio.error?.code });
        timer = setTimeout(() => done({ success: false, timeout: true }), 8000);
        audio.src = url; audio.load();
      });
      return { originalType: raw.type, type: corrected.type, sameSize: raw.size === corrected.size,
        before: await decode(raw), after: await decode(corrected) };
    }, { bytes, file: clip.file });
    assert.equal(result.originalType, '');
    assert.equal(result.type, 'audio/mp4');
    assert.ok(result.sameSize);
    assert.ok(result.after.success && result.after.duration > 10, JSON.stringify(result));
    console.log('PASS WebKit decodes correctly typed audiobook audio without changing its bytes');
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
