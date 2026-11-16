import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createDesktopHost } from '../../src/desktop/host.mjs';
const modulePath=process.env.PWB_PLAYWRIGHT_MODULE;
const chromium=modulePath?(await import(modulePath)).chromium:null;
const assets=new Map(await Promise.all(['desktop-connect.js','code-connect.js'].map(async name=>['/'+name,await readFile(new URL('../../web/'+name,import.meta.url),'utf8')])));
for(const origin of ['https://app.ltpass.com','https://app1.ltpass.com'])test('HTTPS 原页面直连、真实 HTTP/SSE、刷新及断开：'+origin,{skip:!chromium,timeout:30000},async t=>{
 let callback;const sent=[],directory=await mkdtemp('/private/tmp/km-direct-browser-');
 const adapter={health:async()=>({ready:true,version:'fixture'}),listSessions:async()=>[{id:'ses_direct_test',title:'Direct test'}],bindSession:async id=>({id,title:'Direct test'}),readShared:async()=>({status:'idle',messages:[],tools:[]}),watch:(id,event,state)=>{callback=event;queueMicrotask(()=>state('connected'));return{ready:Promise.resolve(),close(){}};},sendShared:async(id,text)=>{sent.push(text);return{id:'sent'}},close:async()=>{}};
 const host=createDesktopHost({directory,direct:true,codexEnabled:false,adapterFactory:()=>adapter});
 const started=await host.start({origins:[origin]});
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 t.after(async()=>{await browser.close();await host.stop();await rm(directory,{recursive:true,force:true});});
 const context=await browser.newContext();
 // Model the browser's normal user permission, never disable web security/LNA.
 await context.grantPermissions(['local-network-access'],{origin});
 const page=await context.newPage();
 await context.route(origin+'/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const body=assets.get(path)||`<!doctype html><button id="prepare">准备</button><button id="connect">连接</button><p id="status"></p><script src="/desktop-connect.js"></script><script src="/code-connect.js"></script><script>
  window.connector=KmCodeConnector.create();window.open=()=>{throw Error('Unexpected popup')};
  const accept=s=>{window.session=s;document.querySelector('#status').textContent='connected';};const fail=e=>{document.querySelector('#status').textContent='failed: '+e.message;};
  document.querySelector('#prepare').onclick=()=>{const result=connector.prepare({onRequest:r=>window.copied=r});window.ready=result.connection.then(accept).catch(fail);};
  document.querySelector('#connect').onclick=()=>{window.ready=connector.connect().then(accept).catch(fail);};
  if(connector.hasSaved())window.ready=connector.connect({passive:true}).then(accept).catch(fail);
  </script>`;
  await route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*"},body});
 });
 await page.goto(origin+'/');await page.click('#prepare');
 const copied=JSON.parse(Buffer.from(await page.evaluate(()=>copied),'base64url'));
 assert.equal(host.authorize(host.inspectLink(copied.url).id).transport,'direct');
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='connected');
 assert.equal(context.pages().length,1);assert.equal(await page.evaluate(()=>session.endpoint),started.endpoint);
 assert.equal(await page.evaluate(()=>document.querySelectorAll('iframe').length),0);
 await page.evaluate(async()=>{await session.fetch(session.endpoint+'/v1/bind',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'ses_direct_test',allowControl:true})});const result=await session.fetch(session.endpoint+'/v1/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'ses_direct_test',requestId:crypto.randomUUID(),text:'direct browser probe'})});if(result.status!==202)throw Error('send failed');});
 assert.deepEqual(sent,['direct browser probe']);
 await page.evaluate(()=>{window.frames=[];window.streaming=(async()=>{const res=await session.fetch(session.endpoint+'/v1/events');const reader=res.body.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)break;frames.push(new TextDecoder().decode(chunk.value));}}catch{}})();});
 await page.waitForFunction(()=>frames.length>0);
 callback({id:'native-external',type:'session.text.delta',data:{sessionID:'ses_direct_test',assistantMessageID:'reply',ordinal:0,delta:'原生侧事件到达'}});
 await page.waitForFunction(()=>frames.join('').includes('原生侧事件到达'));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent==='connected');
 assert.equal(context.pages().length,1);assert.equal(sent.length,1);
 const snapshot=await page.evaluate(async()=>(await(await session.fetch(session.endpoint+'/v1/snapshot')).json()).data);
 assert.equal(snapshot.binding,null);
 await page.evaluate(()=>connector.close({forget:true}));await page.reload();
 assert.equal(await page.evaluate(()=>connector.hasSaved()),false);assert.equal(context.pages().length,1);
});
