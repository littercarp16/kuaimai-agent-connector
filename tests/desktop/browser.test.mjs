import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createDesktopHost } from '../../src/desktop/host.mjs';
const modulePath=process.env.PWB_PLAYWRIGHT_MODULE;
const chromium=modulePath?(await import(modulePath)).chromium:null;
const assets=new Map();
for(const name of ['desktop-connect.js','connect-callback.js','connect-callback.html'])assets.set('/agent/'+name,await readFile(new URL('../../web/'+name,import.meta.url),'utf8'));
if(process.env.PWB_AGENT_CLIENT_ROOT)for(const name of ['client.js','model.js'])assets.set('/agent/'+name,await readFile(join(process.env.PWB_AGENT_CLIENT_ROOT,name),'utf8'));
const fixtureScript=`
const accept=async session=>{window.connection=session;sessionStorage.setItem('relay',JSON.stringify({endpoint:session.endpoint,instanceId:session.instanceId,relayId:session.relayId}));if(window.KmAgentClient){window.agentClient=KmAgentClient.create();await agentClient.attachDesktop(session);if(agentClient.state.status!=='ready')throw Error('Client not ready');}document.getElementById('status').textContent='connected';return true;};
const failed=error=>{document.getElementById('status').textContent='failed: '+error.message;return false;};
document.querySelector('button').onclick=()=>{window.result=KmDesktopConnector.connect({launch:window.nativeLaunch,timeoutMs:15000}).then(accept).catch(failed);};
const saved=JSON.parse(sessionStorage.getItem('relay')||'null');if(saved)window.result=KmDesktopConnector.restore({resume:saved}).then(accept).catch(failed);
`;
for(const origin of ['https://app.ltpass.com','https://app1.ltpass.com','http://lt.com:8085','http://local.lt.com:8251'])test('真实浏览器的网页→本机连接窗口→HTTP/SSE：'+origin,{skip:!chromium,timeout:20000},async t=>{
 let stage='initial',now=Date.now(),launches=0;let onEvent;const sent=[],adapter={health:async()=>({ready:true,version:'fixture'}),listSessions:async()=>[{id:'ses_desktop_test',title:'桌面连接验收'}],bindSession:async id=>({id,title:'桌面连接验收'}),readShared:async()=>({status:'idle',messages:[],tools:[]}),watch:(id,event,state)=>{onEvent=event;queueMicrotask(()=>state('connected'));return{ready:Promise.resolve(),close(){}};},installBridge:async()=>{},removeBridge:async()=>{},sendShared:async(id,text,{requestId})=>{sent.push({id,text});return{id:'msg_'+requestId.replaceAll('-','')};},interruptShared:async()=>({interrupted:true})};
 const directory=await mkdtemp(join(tmpdir(),'km-desktop-browser-'));
 const blocker=createServer((req,res)=>res.end('foreign'));blocker.listen(0,'127.0.0.1');await once(blocker,'listening');
 const host=createDesktopHost({directory,reconnect:true,now:()=>now,preferredPort:blocker.address().port,codexEnabled:false,adapterFactory:()=>adapter});
 let browser; t.after(async()=>{await browser?.close();await host.stop();await new Promise(r=>blocker.close(r));await rm(directory,{recursive:true,force:true});});
 const started=await host.start({origins:[origin]});assert.notEqual(Number(new URL(started.endpoint).port),blocker.address().port);
 browser=await chromium.launch({headless:true,executablePath:process.env.PWB_BROWSER_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext(),page=await context.newPage(),errors=[],siteNetwork=[];page.setDefaultTimeout(7000);
 context.on('page',p=>{p.setDefaultTimeout(7000);p.on('pageerror',e=>errors.push(e.message));});
 t.after(async()=>{if(t.passed===false)console.log(JSON.stringify({origin,stage,errors}));});
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().startsWith('http://127.0.0.1:'))siteNetwork.push(request.url());});
 await context.route(origin+'/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const clientScripts=process.env.PWB_AGENT_CLIENT_ROOT?'<script src="/agent/model.js"></script><script src="/agent/client.js"></script>':'';
   const body=assets.get(path)|| (path==='/app.js'?fixtureScript:'<!doctype html><button>接入</button><p id="status"></p><script src="/agent/desktop-connect.js"></script>'+clientScripts+'<script src="/app.js"></script>');
   await route.fulfill({status:200,contentType:path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',headers:{'Cross-Origin-Opener-Policy':'same-origin-allow-popups','Content-Security-Policy':"default-src 'self'; script-src 'self'; connect-src 'self'",'Referrer-Policy':'no-referrer'},body});
 });
 // The native consent boundary is explicitly simulated here; Swift URL dispatch
 // and login registration are verified separately against the built .app.
 await page.exposeFunction('nativeLaunch',async url=>{
   launches++;const pending=host.inspectLink(url),approved=host.authorize(pending.id);
   const callback=await context.newPage();await callback.goto(approved.callbackURL);
 });
 stage='navigation';await page.goto(origin+'/');stage='click';await page.getByRole('button',{name:'接入',exact:true}).click();
 stage='await-connected';await page.waitForFunction(()=>document.getElementById('status').textContent==='connected',null,{timeout:15000});
 assert.equal(await page.evaluate(()=>connection.endpoint),started.endpoint);
 assert.equal(await page.evaluate(async()=>{try{await connection.fetch(connection.endpoint+'/v1/not-allowed');return false;}catch{return true;}}),true);
 stage='bind';const bind=await page.evaluate(async()=>{const res=await connection.fetch(connection.endpoint+'/v1/bind',{method:'POST',body:JSON.stringify({sessionId:'ses_desktop_test',allowControl:true})});return res.json();});assert.equal(bind.ok,true);
 stage='send';const result=await page.evaluate(async()=>{const res=await connection.fetch(connection.endpoint+'/v1/run',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID?crypto.randomUUID():'d345c60b-8a40-49e9-ae65-7918d7c7a3dc',sessionId:'ses_desktop_test',text:'隔离测试 prompt'})});return{status:res.status,body:await res.json()};});
 assert.equal(result.status,202);assert.equal(sent.length,1);
 stage='sse';await page.evaluate(()=>{window.framesSeen=[];window.streamController=new AbortController();window.streamRead=(async()=>{const res=await connection.fetch(connection.endpoint+'/v1/events',{signal:streamController.signal});const reader=res.body.getReader(),decoder=new TextDecoder();try{while(true){const next=await reader.read();if(next.done)break;framesSeen.push(decoder.decode(next.value));}}catch{}})();});
 await page.waitForFunction(()=>framesSeen.length>0);
 onEvent({id:'desktop-event',type:'session.text.delta',data:{sessionID:'ses_desktop_test',assistantMessageID:'reply',ordinal:0,delta:'实时回复已送达'}});
 await page.waitForFunction(()=>framesSeen.join('').includes('实时回复已送达'));
 assert.equal(await page.evaluate(()=>localStorage.length),0,'短期回调记录应清理');
 assert.equal(siteNetwork.length,0,'线上页面不直接跨站访问本机网络');assert.deepEqual(errors,[]);
 const windows=context.pages().length;
 stage='reload';await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent==='connected');
 assert.equal(context.pages().length,windows);assert.equal(launches,1);assert.equal(sent.length,1);
 const restored=await page.evaluate(async()=>(await (await connection.fetch(connection.endpoint+'/v1/snapshot')).json()).data);
 assert.equal(restored.binding,null,'refresh has no inherited session control');
 assert.equal(siteNetwork.length,0,'silent restore does not introduce website-to-loopback requests');
 stage='expired';now+=8*3600e3+1;await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('failed:'));
 assert.equal(context.pages().length,windows);assert.equal(launches,1,'expired grants never automatically launch an app or authorization dialog');
 assert.equal(sent.length,1);assert.deepEqual(errors,[]);
 if(origin==='http://local.lt.com:8251'){
   stage='closed-relay';const relay=context.pages().find(p=>p.url().startsWith(started.endpoint+'/connect'));assert.ok(relay);await relay.close();
   const remaining=context.pages().length;await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('failed:'));
   assert.equal(context.pages().length,remaining);assert.equal(launches,1,'a closed relay produces a hint, never a replacement popup');assert.equal(sent.length,1);
 }

});
