// Standalone browser regressions. No private books or external server required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log(`PASS ${label}`); passed++; };

async function fixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf', `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Cleanup Example</dc:title><dc:creator>Test Author</dc:creator></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>`);
  zip.file('nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="body.xhtml#chapter1">Chapter I</a><ol><li><a href="body.xhtml#subtitle">The Beginning</a></li></ol></li><li><a href="body.xhtml#chapter2">Chapter II</a><ol><li><a href="body.xhtml#detail">A Detail</a></li></ol></li></ol></nav></body></html>`);
  zip.file('body.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Example</title></head><body>
    <header class="pg-boilerplate"><p>DISTRIBUTION NOTICE</p></header>
    <section epub:type="titlepage"><h1>Title Page</h1><p>Publication information</p></section>
    <section epub:type="chapter"><h1 id="chapter1">Chapter I</h1><h2 id="subtitle">The Beginning</h2>
    <p>Alpha reader text <a epub:type="noteref" href="#note1">[1]</a> continues without a marker. A meaningful exponent x<sup>2</sup> remains.</p>
    <figure><a href="missing.jpg"><img src="missing.jpg" alt="A duplicated description that should never appear twice."/></a><figcaption>FIGURE CAPTION</figcaption></figure>
    <div role="figure" aria-labelledby="caption"><span id="caption" class="caption">OLDER FIGURE CAPTION</span></div>
    <table epub:type="list"><tr><td>Meaningful verse line one.</td></tr><tr><td>Meaningful verse line two.</td></tr></table>
    <p hidden="hidden">HIDDEN GARBAGE</p><p style="display:none">MORE HIDDEN GARBAGE</p>
    <aside id="note1" epub:type="footnote"><p>SEMANTIC NOTE</p></aside>
    <div class="footnotes"><div class="footnote"><p>LEGACY NOTE</p></div></div></section>
    <section epub:type="chapter"><h1 id="chapter2">Chapter II</h1><p>Beta reader keeps this exact place after cleanup changes.</p>
    <section epub:type="subchapter"><h2 id="detail">A Detail</h2><p>Detail prose stays readable.</p></section></section>
    <section epub:type="backmatter"><h2>Advertisements</h2><p>OLD ADVERTISEMENT</p></section>
    </body></html>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
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
  await page.waitForSelector('#empty-add');
  const bytes = await fixture();
  const data = await page.evaluate(async base64 => {
    const { importFile } = await import('/js/importers.js');
    const { cleanBook, positionAnchor, anchorPosition } = await import('/js/bookclean.js');
    const { buildIndex } = await import('/js/engine.js');
    const book = await importFile(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'fixture.epub'));
    const source = book.cleanup.source, options = book.cleanup.options;
    const restored = cleanBook(source, { ...options, figure: true, note: true, frontmatter: true, backmatter: true, boilerplate: true });
    const beta = book.blocks.find(b => b.t.startsWith('Beta reader'));
    const pos = buildIndex(book.blocks).blockStart[book.blocks.indexOf(beta)] + 3;
    const anchor = positionAnchor(book.blocks, pos);
    const mapped = anchorPosition(source, restored.blocks, anchor);
    const body = cleanBook(source, { ...options, overrides: { [book.blocks[0].sid]: 'body' } });
    return { book, restored, body, oldWord: buildIndex(book.blocks).words[pos], newWord: buildIndex(restored.blocks).words[mapped] };
  }, bytes.toString('base64'));
  const text = data.book.blocks.map(b => b.t).join(' ');
  check('captions, semantic notes, legacy notes and notices are omitted', !/CAPTION|SEMANTIC NOTE|LEGACY NOTE|DISTRIBUTION NOTICE|ADVERTISEMENT/.test(text));
  check('real content and non-reference superscripts survive', text.includes('Meaningful verse line one.') && text.includes('x2 remains'));
  check('hidden content is excluded', !text.includes('HIDDEN GARBAGE'));
  check('chapter number and subtitle share one navigation entry', data.book.chapters[0].title === 'Chapter I: The Beginning');
  check('subsection is navigable without an announcement', data.book.chapters.some(c => c.title === 'A Detail' && !c.announce));
  check('major chapter is announced', data.book.chapters.some(c => c.title === 'Chapter II' && c.announce));
  check('all omitted categories can be restored', /FIGURE CAPTION/.test(data.restored.blocks.map(b => b.t).join(' ')) && data.restored.blocks.some(b => b.t === 'LEGACY NOTE'));
  check('linked illustrations do not duplicate captions with alt text', !data.restored.blocks.some(b=>b.t.includes('duplicated description')));
  check('cleanup remaps reading position by source block and word', data.oldWord === data.newWord);
  check('body override removes the corresponding chapter entry', !data.body.chapters.some(c => c.title === 'Chapter I'));
  check('cleanup does not mutate the retained source', data.book.cleanup.source.blocks.some(b => b.roles.includes('figure')));

  const pdf = await page.evaluate(async () => {
    const { analyzePages, defaultCleanOptions } = await import('/js/pdfclean.js');
    const { finishPdf } = await import('/js/importers.js');
    const lines = (n) => [
      {text: 'BOOK TITLE', x: 70, y: 760, h: 10},
      {text: n === 1 ? 'Chapter 1' : 'Ordinary paragraph continues', x: 70, y: 700, h: n === 1 ? 20 : 12},
      {text: 'Part of this sentence is normal prose.', x: 70, y: 665, h: 12},
      {text: '• A large bullet point', x: 90, y: 630, h: 18},
      {text: 'its continuation', x: 100, y: 609, h: 18},
      {text: '1.1: Important summary content', x: 70, y: 300, h: 6},
      {text: 'FIGURE 1: An explicit figure caption.', x: 70, y: 260, h: 8},
      {text: 'Caption continuation.', x: 70, y: 250, h: 8},
      {text: 'Body prose after the figure.', x: 70, y: 220, h: 12},
      {text: String(n), x: 300, y: 40, h: 10}];
    const analysis = analyzePages([1,2,3,4].map(n=>({n,height:800,lines:lines(n)})));
    const result = finishPdf({title:'PDF example',author:'',pages:4,outline:[],analysis},defaultCleanOptions());
    const skipped = finishPdf({title:'PDF example',author:'',pages:4,outline:[],analysis},{...defaultCleanOptions(),skip:new Set([2])});
    return { result, skipped, found: analysis.found };
  });
  check('PDF repeated margin headers and page numbers are removed', pdf.found.headers === 4 && !pdf.result.blocks.some(b=>b.t === 'BOOK TITLE' || /^\d+$/.test(b.t)));
  check('PDF prose and bullet continuation do not become headings', !pdf.result.blocks.some(b=>b.k==='h' && /Part of|continuation/.test(b.t)));
  check('PDF captions disappear without removing following prose', !pdf.result.blocks.some(b=>b.t.includes('explicit figure caption')) && pdf.result.blocks.some(b=>b.t.includes('Body prose after')));
  check('small numbered summary remains body content', pdf.result.blocks.some(b=>b.t.includes('Important summary content')) && pdf.found.footnotes === 0);
  check('skipped PDF pages remain available in source', !pdf.skipped.blocks.some(b=>b.page===2) && pdf.skipped.cleanup.source.blocks.some(b=>b.page===2));

  // Actual import/review, cancellation, persistence, and a later edit on a phone viewport.
  await page.click('#empty-add');
  await page.setInputFiles('#file-pick', {name:'fixture.epub',mimeType:'application/epub+zip',buffer:bytes});
  await page.waitForSelector('#book-add');
  check('import opens a review with omitted source text visible', await page.locator('.clean-block.omitted').count() > 0);
  await page.fill('#clean-search', 'FIGURE CAPTION');
  check('review searches the full source text', await page.locator('.clean-block').count() === 2);
  await page.selectOption('#preview-mode', 'reading');
  check('reading preview excludes omitted passages', await page.locator('.clean-block').count() === 0);
  await page.selectOption('#preview-mode', 'source');
  await page.locator('[data-block]').first().selectOption('keep');
  check('an individual caption can override the category exclusion', await page.locator('.clean-block:not(.omitted)').count() === 1);
  await page.locator('[data-block]').first().selectOption('auto');
  await page.fill('#clean-search', '');
  const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth);
  check('review fits a phone viewport', !overflow);
  if (process.env.SHOTS) {
    await page.screenshot({path:path.join(process.env.SHOTS,'epub-cleanup.png')});
    await page.evaluate(()=>{
      const body=document.querySelector('.cleanup-sheet .sheet-body');
      body.scrollTop += document.querySelector('#clean-preview').getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
    await page.screenshot({path:path.join(process.env.SHOTS,'epub-cleanup-passages.png')});
    const header = await page.evaluate(()=>{
      const rect=document.querySelector('.cleanup-sheet .sheet-head').getBoundingClientRect();
      return {top:rect.top,bottom:rect.bottom,height:innerHeight};
    });
    check('review header stays visible while passages scroll', header.top >= 0 && header.bottom <= header.height);
  }
  await page.click('#book-add');
  await page.waitForSelector('#reader');
  const before = await page.evaluate(() => {
    const R = __stillpoint.R;
    const block = R.blocks.findIndex(b => b.t.startsWith('Beta reader'));
    R.pos = R.blockStart[block] + 3;
    R.book.bookmarks.push({ word: R.pos, label: 'My place', addedAt: Date.now() });
    return R.words[R.pos];
  });
  await page.click('#r-toc');
  await page.click('#reader-cleanup');
  await page.waitForSelector('#keep-note');
  await page.check('#keep-note');
  await page.click('[data-close]');
  await page.waitForTimeout(50);
  await page.click('#r-toc');
  await page.click('#reader-cleanup');
  await page.waitForSelector('#keep-note');
  check('cancelling cleanup leaves saved options unchanged', !await page.isChecked('#keep-note'));
  await page.check('#keep-note');
  await page.selectOption('#announcements', 'none');
  await page.click('#book-add');
  // The old reader stays mounted behind the review sheet while saving.
  // Wait for the new content, not merely the already-existing #reader element.
  await page.waitForFunction(() => {
    const R = window.__stillpoint.R;
    return R?.blocks.some(b => b.t === 'LEGACY NOTE') && R.book.chapters.every(c => !c.announce);
  });
  const saved = await page.evaluate(async()=>{
    const db=await import('/js/db.js');
    const books=await db.getAll('books');
    const content=await db.get('contents',books[0].id);
    return {book:books[0],content};
  });
  check('edited cleanup is persisted with retained source', saved.content.cleanup.options.note && saved.content.blocks.some(b=>b.t==='LEGACY NOTE') && saved.content.cleanup.source.blocks.length > saved.content.blocks.length);
  check('none announcement mode retains navigation', saved.book.chapters.length > 0 && saved.book.chapters.every(c=>!c.announce));
  const positions = await page.evaluate(()=>{
    const R = __stillpoint.R;
    return { current: R.words[R.pos], bookmark: R.words[R.book.bookmarks[0].word] };
  });
  check('editing preserves the current word and bookmark', before === positions.current && before === positions.bookmark);
  await page.reload();
  await page.waitForSelector('#reader');
  check('cleaned book survives reopening', await page.locator('#reader').count() === 1);
  check('no browser app errors', errors.length === 0);
  await browser.close();
  console.log(`${passed} cleanup checks passed`);
})().catch(error=>{console.error(error);process.exit(1);});
