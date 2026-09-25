// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/renderer.browser.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=new URL('../',import.meta.url);
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<link rel="stylesheet" href="/css/app.css"><div id="mushaf" class="mushaf-page"></div>');return;}
  try {const path=new URL('.'+req.url,root);res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(fileURLToPath(path)));}
  catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const {MushafRenderer,mushafPageUrl}=await import('/js/mushaf-renderer.js');
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><g id="md-page"><g id="md-page-inner"><g id="md-line-1"><g id="md-word-a" data-type="text" data-surah="112" data-aya="1" data-word-index-in-ayah="1"><path d="M 100 100 h 20 v 15 h -20 Z"/></g><g id="md-word-b" data-type="text" data-surah="112" data-aya="1" data-word-index-in-ayah="2"><path d="M 130 100 h 20 v 15 h -20 Z"/></g></g></g></g></svg>';
  const cache=await caches.open('recitation-core');await cache.put(mushafPageUrl(1),new Response(svg));
  const words=[1,2].map(i=>({key:`112:1:${i}`,page:1,revealed:false,state:'hidden'}));
  const r=new MushafRenderer(document.querySelector('#mushaf'));await r.show(1,words);
  const original=document.querySelector('svg');const first=r.nodes.get(words[0].key), second=r.nodes.get(words[1].key);
  const hiddenInitially=getComputedStyle(first).visibility==='hidden';
  words[0].revealed=true;words[0].state='correct';r.update(words[0],true);
  words[1].state='incorrect-placeholder';r.update(words[0],false);r.update(words[1]);
  const errorHidden=getComputedStyle(second).visibility==='hidden'&&document.querySelectorAll('.error').length===1;
  words[1].revealed=true;words[1].revealedByErrorLimit=true;r.update(words[1],true);
  await r.show(1,words);
  return {hiddenInitially,errorHidden,sameSvg:original===document.querySelector('svg'),
   visible:getComputedStyle(first).visibility==='visible'&&getComputedStyle(second).visibility==='visible',
   active:document.querySelectorAll('.active').length,permanent:document.querySelectorAll('.revealed-error').length,
   cachedBoxes:r.boxes.size};
 });
 assert.deepEqual(result,{hiddenInitially:true,errorHidden:true,sameSvg:true,visible:true,active:1,permanent:1,cachedBoxes:2});
 console.log('PASS: real Chromium SVG visibility, error concealment, cached geometry, active and permanent overlays, no page rebuild');
} finally {await browser.close();server.close();}
