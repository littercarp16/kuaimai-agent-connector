import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseLaunchOptions} from '../../src/runtime/launch-options.mjs';

const exec=promisify(execFile),origin='http://127.0.0.1:4173';
const unusedPort=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;};

test('trusted origin may start observation-only without session; generic publishing never grants native control',()=>{
  const config=parseLaunchOptions(['--adapter','generic','--trust-origin',origin,'--workspace','/authorized/workspace']);
  assert.equal(config.sessionId,null);assert.equal(config.auto,true);assert.equal(config.allowControl,false);assert.equal(config.workspace,'/authorized/workspace');
  assert.equal(parseLaunchOptions([]).workspace,undefined);
  assert.throws(()=>parseLaunchOptions(['--workspace','relative/path']),/工作区|绝对/);
  assert.throws(()=>parseLaunchOptions(['--workspace','/bad\0path']),/工作区|目录/);
  assert.throws(()=>parseLaunchOptions(['--trust-origin',origin,'--allow-control']),/控制|会话/);
  assert.throws(()=>parseLaunchOptions(['--adapter','generic','--session','ses_a','--allow-control']),/控制/);
  assert.throws(()=>parseLaunchOptions(['--session','ses_a','--allow-control']),/控制/);
});

test('main explicitly enables multi-agent follow, keeps WB publishing independent of native readiness, and passes workspace to adapter',async()=>{
  const main=await readFile(new URL('../../src/cli/main.mjs',import.meta.url),'utf8');
  assert.match(main,/enableMultiAgentFollow\s*:\s*true/);
  assert.match(main,/enableWorkBuddy\s*:\s*true/);
  assert.match(main,/createProductAdapters\(\{[^\n]*workspace:authorizedWorkspace/);
  assert.match(main,/codex:createCodexAdapter/);
});

test('legacy launcher process regression uses only random ports rather than active preview ports',async()=>{
  const source=await readFile(new URL('./launcher-process.test.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/1765[34]/);
});

test('launcher falls back from a non-HTTP socket without sending requests or stopping it',{timeout:10000},async t=>{
  let connections=0;
  const server=createServer(socket=>{connections++;socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const port=server.address().port;
  const {stdout}=await exec(process.execPath,['start.mjs','--adapter','generic','--trust-origin',origin,'--port',String(port)],{cwd:new URL('../../',import.meta.url),env:{...process.env,KM_AGENT_DISABLE_CODEX:'1'},timeout:5000});
  const started=JSON.parse(stdout);
  t.after(async()=>{try{process.kill(started.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,150));for(const suffix of ['log','json','json.next','json.lease'])await unlink(new URL(`../../.runtime/connector-${port}.${suffix}`,import.meta.url)).catch(()=>{});});
  assert.notEqual(started.endpoint,`http://127.0.0.1:${port}`);assert.equal(server.listening,true);assert.equal(connections,0);
});

test('origin-only generic background launcher starts exact random port, receives WB open automatically, and never fabricates native session',{timeout:20000},async t=>{
  const port=await unusedPort(),workspace=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''),args=['--adapter','generic','--trust-origin',origin,'--workspace',workspace,'--port',String(port)];
  const {stdout}=await exec(process.execPath,['start.mjs',...args],{cwd:new URL('../../',import.meta.url),env:{...process.env,KM_AGENT_DISABLE_CODEX:'1'},timeout:15000});const started=JSON.parse(stdout);assert.equal(started.ok,true);
  t.after(async()=>{try{process.kill(started.pid,'SIGTERM');}catch{}for(const suffix of ['log','json','json.next'])await unlink(new URL(`../../.runtime/connector-${port}.${suffix}`,import.meta.url)).catch(()=>{});});
  const base=`http://127.0.0.1:${port}`;assert.equal(started.endpoint,base);assert.equal(started.control,false);
  const web=async(path,body,token)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,...await r.json()};};
  const handshake=await web('/v1/handshake',{});assert.equal(handshake.status,200);const token=handshake.data.token;assert.equal(handshake.data.snapshot.binding,null);
  assert.equal((await web('/v1/run',{requestId:randomUUID(),text:'must not run'},token)).status,403);
  const sources=await web('/v1/sources',null,token);assert.deepEqual(sources.data.sessions,[]);assert.equal(sources.data.sources.find(s=>s.provider==='workbuddy').status,'available');
  const runtime=JSON.parse(await readFile(new URL(`../../.runtime/connector-${port}.json`,import.meta.url),'utf8'));
  const response=await fetch(base+'/v1/local/workbuddy/tasks/open',{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json','X-Km-Publisher':runtime.key},body:JSON.stringify({requestId:randomUUID(),title:'真实独立WB逻辑任务',workspaceId:'ws_'+createHash('sha256').update(decodeURIComponent(workspace)).digest('hex')})});assert.equal(response.status,200);const task=(await response.json()).data;
  let snapshot;const deadline=Date.now()+1000;do{snapshot=(await web('/v1/snapshot',null,token)).data;if(snapshot.sessionId===task.taskId)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);
  assert.equal(snapshot.sessionId,task.taskId);assert.equal(snapshot.provider,'workbuddy');assert.equal(snapshot.binding.canControl,false);assert.equal(snapshot.capabilities.multiAgentFollow,true);
  await assert.rejects(()=>exec(process.execPath,['start.mjs',...args],{cwd:new URL('../../',import.meta.url),timeout:5000}),error=>{assert.match(error.stderr,/其他授权范围/);return true;});
  assert.equal((await web('/v1/health')).data.instanceId,runtime.instanceId,'conflicting launcher never replaces active instance');
});
