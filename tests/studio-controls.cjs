const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {chromium}=require('playwright'), JSZip=require('jszip');
const root=path.resolve(__dirname,'..'); let count=0;
function check(label,value){assert.ok(value,label);console.log('PASS '+label);count++;}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try {
  const page=await browser.newPage(); let jobs=[],offline=false,postCount=0; const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname==='/api/status') return offline?route.abort():route.fulfill({json:{ready:true,token:'test',voices:[{id:'af_heart',name:'Heart'},{id:'am_michael',name:'Michael'}],jobs}});
   if(url.pathname==='/api/jobs'&&request.method()==='POST'){
    const data=request.postDataJSON(); jobs=[{id:String(++postCount).padStart(32,'0'),kind:data.kind,title:data.job.book.title,voice:data.voice,status:'running',phase:'downloading'}];
    return route.fulfill({status:201,json:jobs[0]});
   }
   if(url.pathname.endsWith('/cancel')){jobs[0].status='cancelled';jobs[0].phase='cancelled';return route.fulfill({json:jobs[0]});}
   if(url.pathname.endsWith('/pause')){jobs[0].status='paused';return route.fulfill({json:jobs[0]});}
   if(url.origin!=='http://localhost:8765')return route.abort();
   let file=path.resolve(root,`.${url.pathname}`);if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404});
   return route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://localhost:8765/studio/');
  await page.waitForFunction(()=>document.querySelector('#engine-state').textContent==='Local engine ready');
  check('empty Studio explains that a book is required',/Choose an EPUB/.test(await page.textContent('#action-status'))&&await page.isDisabled('#preview-voice')&&await page.isDisabled('#generate'));
  const zip=new JSZip();zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Control test</dc:title></metadata><manifest><item id="b" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/></spine></package>');
  zip.file('body.xhtml','<html><body><h1>Chapter One</h1><p>A short test passage for trying the narrator.</p></body></html>');
  await page.setInputFiles('#epub-file',{name:'test.epub',mimeType:'application/epub+zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
  await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  check('importing a book enables both actions',!await page.isDisabled('#preview-voice')&&!await page.isDisabled('#generate'));
  await page.click('#preview-voice');await page.waitForSelector('#cancel-preview:not([hidden])');
  check('a first-use download explains disabled buttons',/Downloading this voice/.test(await page.textContent('#action-status'))&&await page.isDisabled('#generate'));
  await page.selectOption('#voice','am_michael');await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  check('changing narrator cancels the old preview and keeps the book',jobs[0].status==='cancelled'&&(await page.textContent('#book-title'))==='Control test'&&await page.inputValue('#voice')==='am_michael');
  await page.click('#preview-voice');await page.waitForSelector('#cancel-preview:not([hidden])');await page.click('#cancel-preview');
  await page.waitForFunction(()=>!document.querySelector('#preview-voice').disabled);
  check('cancel preview unlocks both actions',jobs[0].status==='cancelled'&&!await page.isDisabled('#generate'));
  await page.click('#generate');await page.waitForSelector('[data-pause]');await page.waitForFunction(()=>document.querySelector('#voice').disabled);
  check('full generation locks narrator settings and retains pause',await page.isDisabled('#speed')&&await page.locator('[data-pause]').count()===1&&!await page.isVisible('#cancel-preview'));
  await page.click('[data-pause]');await page.waitForFunction(()=>!document.querySelector('#voice').disabled);
  offline=true;await page.waitForFunction(()=>document.querySelector('#engine-state').textContent==='Local engine offline');
  check('disconnect disables actions with a reason',await page.isDisabled('#generate')&&/disconnected/.test(await page.textContent('#action-status')));
  offline=false;await page.waitForFunction(()=>!document.querySelector('#generate').disabled);
  check('reconnecting unlocks controls without reimporting',!await page.isDisabled('#preview-voice')&&(await page.textContent('#book-title'))==='Control test');
  check('no application errors',errors.length===0);console.log(count+' Studio control checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
