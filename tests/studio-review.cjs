const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}:{})});
 try {
  const page = await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); let request;
  await page.route('**/*', async route => {
   const url = new URL(route.request().url());
   if(url.pathname==='/api/jobs' && route.request().method()==='POST') {
    request=route.request().postDataJSON(); return route.fulfill({status:201,json:{id:'a'.repeat(32)}});
   }
   if(url.pathname==='/api/status') return route.fulfill({json:{ready:true,token:'test',voices:[{id:'af_heart',name:'Heart'}],jobs:[]}});
   if(url.origin!=='http://localhost:8765') return route.abort();
   let file=path.resolve(root,`.${url.pathname}`);
   if(fs.existsSync(file)&&fs.statSync(file).isDirectory()) file=path.join(file,'index.html');
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) return route.fulfill({status:404});
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'});
  });
  const zip = new JSZip();
  zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Studio Review</dc:title></metadata><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>');
  zip.file('body.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><section epub:type="titlepage"><h1>Title Page</h1><p>Front passage.</p></section><section epub:type="chapter"><h1>Chapter One</h1><p>First body passage.</p></section><section epub:type="chapter"><h1>Chapter Two</h1><p>Second body passage.</p></section></body></html>');
  await page.goto('http://localhost:8765/studio/');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=30;return c.toDataURL('image/png').split(',')[1]});
  zip.file('cover.png',Buffer.from(image,'base64'));
  zip.file('book.opf',(await zip.file('book.opf').async('string')).replace('<manifest>','<manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'));
  await page.setInputFiles('#epub-file',{name:'review.epub',mimeType:'application/epub+zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
  await page.waitForSelector('#book-details:not([hidden])');
  await page.click('#review-toggle'); await page.check('[data-role="frontmatter"]');
  await page.click('#generate'); await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  assert.ok(request.readingBook.content.blocks.some(b=>b.t==='Front passage.'));
  console.log('PASS including front matter retains new passages before any explicit chapter selection');
  assert.ok(request.readingBook.book.cover?.startsWith('data:image/jpeg;base64,'));
  console.log('PASS Studio includes EPUB artwork in the combined reading-book package');
  await page.click('#chapters-toggle');
  await page.locator('#chapter-options label').filter({hasText:'Chapter Two'}).locator('input').uncheck();
  request=null; await page.click('#generate'); await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  assert.ok(request.readingBook.content.blocks.some(b=>b.t==='First body passage.'));
  assert.ok(!request.readingBook.content.blocks.some(b=>b.t==='Second body passage.'));
  const rebuilt=await page.evaluate(payload=>import('/js/bookclean.js').then(({cleanBook})=>cleanBook(payload.content.cleanup.source,payload.content.cleanup.options).blocks),request.readingBook);
  assert.deepEqual(rebuilt.map(b=>b.sid),request.readingBook.content.blocks.map(b=>b.sid));
  console.log('PASS chapter choices survive a later reading-text review through saved exclusions');
  assert.deepEqual(errors,[]); console.log('PASS no Studio review errors');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
