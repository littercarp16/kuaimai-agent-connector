import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureRuntime, inspectRuntime } from '../../skills/km-agent-bridge/scripts/prepare.mjs';
import { publishEvent } from '../../src/runtime/publisher.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.KM_AGENT_DISABLE_CODEX = '1';
const origin = 'http://127.0.0.1:4173';
async function fixture(t) {
  let hits=0;
  const blocker=createServer((req,res)=>{hits++;res.writeHead(200,{'content-type':'application/json'});res.end('{"foreign":true}');});
  blocker.listen(0,'127.0.0.1');await once(blocker,'listening');
  const port=blocker.address().port,endpoint=`http://127.0.0.1:${port}`,runtime=join(root,`.runtime/connector-${port}.json`);
  const dir=await mkdtemp(join(tmpdir(),'km-port-test-')),configFile=join(dir,'bootstrap.json');
  const args=['--adapter','generic','--session','ses_dynamic_port','--workspace',root,'--trust-origin',origin,'--port',String(port)];
  const config={version:1,allowPortFallback:true,endpoint,origin,launcher:join(root,'start.mjs'),runtimeFile:runtime,mcpEntry:join(root,'mcp-workbuddy.mjs'),launchArgs:args};
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const pids=new Set();
  async function stop(pid,signal='SIGTERM') {
    try{process.kill(pid,signal);}catch{}
    for(let n=0;n<100;n++){try{process.kill(pid,0);}catch{break;}await delay(20);}
  }
  t.after(async()=>{
    try{pids.add(JSON.parse(await readFile(runtime+'.lease','utf8')).pid);}catch{}
    for(const pid of pids)await stop(pid);
    blocker.closeAllConnections();await new Promise(r=>blocker.close(r));
    for(const suffix of ['.json','.json.next','.json.lease','.json.lease.recover','.log'])await unlink(join(root,`.runtime/connector-${port}${suffix}`)).catch(()=>{});
    await rm(dir,{recursive:true,force:true});
  });
  const start=async()=>{const {stdout}=await promisify(execFile)(process.execPath,['start.mjs',...args],{cwd:root,timeout:15000});const result=JSON.parse(stdout);pids.add(result.pid);return result;};
  return {blocker,port,endpoint,runtime,configFile,config,args,start,stop,hits:()=>hits,pids};
}

test('占用首选端口后由系统分配端口，清单/准备器/发布器一致；并发启动复用一实例',{timeout:20000},async t=>{
  const f=await fixture(t);
  const started=await Promise.all([f.start(),f.start(),f.start()]);
  assert.equal(new Set(started.map(x=>x.pid)).size,1);
  assert.equal(new Set(started.map(x=>x.endpoint)).size,1);
  const {endpoint,pid}=started[0];assert.notEqual(endpoint,f.endpoint);assert.equal(f.hits(),0);
  assert.equal((await f.start()).pid,pid);
  const prepared=await ensureRuntime({configFile:f.configFile});assert.equal(prepared.state,'running');assert.equal(prepared.endpoint,endpoint);
  const discovered=await inspectRuntime({configFile:f.configFile});assert.equal(discovered.endpoint,endpoint);assert.deepEqual(Object.keys(discovered).sort(),['endpoint','instanceId']);
  const response=await fetch(endpoint+'/v1/handshake',{method:'POST',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json'},body:'{}'});
  const out=await response.json();assert.equal(out.ok,true);assert.equal(out.data.snapshot.binding.id,'ses_dynamic_port');
  for(let i=0;i<100;i++){if(JSON.parse(await readFile(f.runtime,'utf8')).bindings.length)break;await delay(10);}
  const publication=await publishEvent({runtimePath:f.runtime,sessionId:'ses_dynamic_port',event:{protocol:'km-agent/1',id:'fallback-publish',type:'resource.create',payload:{id:'fallback-page',kind:'page',name:'动态端口验收'}}});assert.equal(publication.accepted,true);
  assert.equal(f.hits(),0,'占用端口的程序不接收探测或凭据');
  await f.stop(pid);assert.equal(await inspectRuntime({configFile:f.configFile}),null);
  await assert.rejects(access(f.runtime),{code:'ENOENT'});
});

test('准备器从未启动状态启动动态端口；进程意外退出后的旧清单可恢复',{timeout:20000},async t=>{
  const f=await fixture(t);
  const result=await ensureRuntime({configFile:f.configFile});assert.equal(result.state,'started');assert.notEqual(result.endpoint,f.endpoint);
  const old=JSON.parse(await readFile(f.runtime+'.lease','utf8'));f.pids.add(old.pid);
  await f.stop(old.pid,'SIGKILL');
  assert.equal(await inspectRuntime({configFile:f.configFile}),null);
  const next=await f.start();assert.notEqual(next.pid,old.pid);assert.notEqual(next.endpoint,f.endpoint);
  assert.equal((await inspectRuntime({configFile:f.configFile})).endpoint,next.endpoint);
  assert.equal(f.hits(),0);
});

test('前台 main 启动同样回退且保留授权范围，冲突配置不创建新实例',{timeout:20000},async t=>{
  const f=await fixture(t),child=spawn(process.execPath,['main.mjs',...f.args],{cwd:root,stdio:'ignore'});f.pids.add(child.pid);
  let connection;for(let i=0;i<100;i++){connection=await inspectRuntime({configFile:f.configFile}).catch(()=>null);if(connection)break;await delay(30);}
  assert.ok(connection);assert.notEqual(connection.endpoint,f.endpoint);
  assert.equal((await f.start()).pid,child.pid);
  await assert.rejects(promisify(execFile)(process.execPath,['start.mjs',...f.args,'--pin-session'],{cwd:root,timeout:2000}),error=>/其他授权范围/.test(error.stderr));
  assert.equal(f.hits(),0);
});
