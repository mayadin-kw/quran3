import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=new URL('../',import.meta.url);
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="app"></div>');return;}
  try {res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'application/json');
    res.end(await readFile(fileURLToPath(new URL('.'+req.url,root))));}
  catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {
 const context=await browser.newContext({permissions:['microphone']});
 await context.addInitScript(()=>{globalThis.webkitSpeechRecognition=class {start(){} abort(){}};});
 const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(async()=>{
  const cache=await caches.open('recitation-core');
  await cache.put('data/quran-index.json',new Response(JSON.stringify({verses:{}})));
  await cache.put('data/surahs.json',new Response(JSON.stringify({'112':{name:'الإخلاص',verses:4}})));
  await cache.put('data/quran-pronunciation-map.json',new Response(JSON.stringify({words:{}})));
  const {downloadManager}=await import('/js/download-manager.js');
  downloadManager.init=async()=>{downloadManager.state='installed';downloadManager.emit();};
  const {PronunciationProvider}=await import('/js/pronunciation-provider.js');
  PronunciationProvider.prototype.init=async function(){this.ready=true;};
  await import('/js/app.js');
 });
 await page.locator('#go-setup').click();
 await page.locator('#mic-enabled').waitFor();
 assert.equal(await page.locator('#asr-provider').count(),0);
 assert.equal(await page.locator('text=طريقة الاستماع').count(),0);
 assert.equal(await page.locator('#next').isDisabled(),true);
 assert.equal(await page.evaluate(()=>navigator.mediaDevices.enumerateDevices().then(()=>!!document.querySelector('#mic-enabled'))),true);
 await page.locator('#mic-enabled').check();
 await page.waitForFunction(()=>!document.querySelector('#next').disabled);
 assert.equal(await page.locator('#mic-state').textContent(),'الميكروفون مفعّل');
 await page.locator('#mic-enabled').uncheck();
 assert.equal(await page.locator('#next').isDisabled(),true);
 await page.locator('#mic-enabled').check();await page.waitForFunction(()=>!document.querySelector('#next').disabled);
 await page.locator('#next').click();
 await page.getByText('اختبار الميكروفون',{exact:true}).waitFor();
 assert.equal(await page.locator('#asr-provider').count(),0);
 console.log('PASS: original microphone switch gates Next and opens calibration; no provider controls');
} finally {await browser.close();server.close();}
