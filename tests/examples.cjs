// Optional regressions against the user's local examples; books are never copied into the repo.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const examples = path.resolve(process.argv[2] || path.join(root, '..'));
let checks = 0;
const check = (message, value) => { assert.ok(value, message); console.log(`PASS ${message}`); checks++; };
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://stillpoint.test') return route.abort();
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) return route.fulfill({ status: 403, body: '' });
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ body: fs.readFileSync(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto('http://stillpoint.test/');
  for (const dir of ['example epubs', 'example pdfs']) {
    const folder = path.join(examples, dir);
    assert.ok(fs.existsSync(folder), `Missing ${folder}`);
    for (const name of fs.readdirSync(folder).filter(n => /\.(epub|pdf)$/i.test(n))) {
      const result = await page.evaluate(async ({ name, bytes }) => {
        const { importFile, finishPdf } = await import('/js/importers.js');
        const { defaultCleanOptions } = await import('/js/pdfclean.js');
        const { cleanBook } = await import('/js/bookclean.js');
        const input = await importFile(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], name));
        const book = input.review ? finishPdf(input.review, defaultCleanOptions()) : input;
        const source = book.cleanup.source;
        const restored = cleanBook(source, { ...book.cleanup.options, figure: true });
        const full = book.blocks.map(b => b.t).join(' ');
        const at = n => book.blocks.filter(b => b.page === n);
        return {
          title: book.title, count: book.chapters.length, announcements: book.chapters.filter(c=>c.announce).length,
          words: full.split(/\s+/).length, sourceCount: source.blocks.length,
          hasBoilerplate: book.blocks.some(b=>b.roles.includes('boilerplate')),
          hasNotes: book.blocks.some(b=>b.roles.includes('note')),
          hasFigures: book.blocks.some(b=>b.roles.includes('figure')),
          captions: book.blocks.filter(b=>/^FIGURE\s+\d+:/i.test(b.t)).length,
          restoredCaptions: restored.blocks.filter(b=>/^FIGURE\s+\d+:/i.test(b.t)).length,
          p28ProseHeading: at(28).some(b=>b.k==='h'&&/WHY IS IT/.test(b.t)),
          p82Summary: at(82).some(b=>b.t.includes('1.1:')),
          introPage: book.blocks[book.chapters.find(c=>c.title==='Introduction: My Story')?.block]?.page,
          richChapterPage: book.blocks[book.chapters.find(c=>c.title==='CHAPTER ONE')?.block]?.page,
          p16BulletHeadings: at(16).some(b=>b.k==='h'&&/Princeton|entrepreneurship|World Record|Olympic/.test(b.t)),
          marginRemains: [149,150].some(n=>at(n).some(b=>b.roles.includes('header'))),
          verseTogether: at(150).some(b=>b.t.includes('I had an errand')&&b.t.includes('green leaves')),
          meaningfulTables: source.blocks.filter(b=>/Meaningful/.test(b.t)).length,
          gatsbyContent: /Dumbbell exercise/.test(full),
          firstTitle: book.chapters[0]?.title,
        };
      }, { name, bytes: fs.readFileSync(path.join(folder, name)).toString('base64') });
      check(`${result.title}: imports with retained source and readable text`, result.words > 1000 && result.sourceCount > 0);
      if (name.endsWith('.epub')) check(`${result.title}: notices, notes and figures stay outside RSVP by default`, !result.hasBoilerplate && !result.hasNotes && !result.hasFigures);
      if (name.startsWith('pg16448')) check('Jewel: exactly 18 major chapter announcements with combined subtitles', result.announcements === 18 && result.firstTitle.includes('OVER THE'));
      if (name.startsWith('pg2522')) check('Gaskell: 16 narrative chapters without a license chapter', result.count === 16);
      if (name.startsWith('dostoyevsky')) check('Dostoyevsky: story title and all navigation entries survive', result.count === 34 && result.firstTitle === 'White Nights' && result.announcements < result.count);
      if (name.startsWith('fitzgerald')) check('Gatsby: meaningful table content survives', result.gatsbyContent);
      if (name.startsWith('Atomic')) {
        check('Atomic Habits: all 16 numbered captions can be excluded and restored', result.captions === 0 && result.restoredCaptions === 16);
        check('Atomic Habits: opening prose and numbered summary survive correctly', !result.p28ProseHeading && result.p82Summary);
        check('Atomic Habits: introduction bookmark is repaired', result.introPage === 8);
      }
      if (name.startsWith('Timothy')) check('Ferriss: major announcements use chapter/part evidence, not bullets', result.announcements >= 16 && result.announcements <= 24 && !result.p16BulletHeadings);
      if (name.startsWith('Tolkien')) check('Tolkien: alternating headers are removed and verse is grouped', !result.marginRemains && result.verseTogether);
      if (name.startsWith('epdf')) check('Rich Dad: chapter bookmark reaches the actual chapter', result.richChapterPage === 15);
      console.log(`  ${result.count} navigation entries, ${result.announcements} announcements`);
    }
  }
  await browser.close();
  console.log(`${checks} example-book checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
