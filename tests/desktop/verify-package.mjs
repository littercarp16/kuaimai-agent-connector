import{spawn,execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,readFile,rm}from'node:fs/promises';import{createInterface}from'node:readline';import{join}from'node:path';import{fileURLToPath}from'node:url';import{once}from'node:events';import assert from'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),directory=await mkdtemp('/private/tmp/km-packaged-');let child;
try{
 const app=join(directory,'Kuaimai Agent Connector.app');
 await promisify(execFile)('/usr/bin/ditto',['-x','-k',join(root,`dist/macos/Kuaimai-Agent-Connector-0.2.2-macOS-${process.arch}.zip`),directory]);
 await promisify(execFile)('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 const resources=join(app,'Contents/Resources'),node=join(resources,'bin/node');
 child=spawn(node,[join(resources,'runtime/desktop/service.mjs')],{cwd:directory,env:{...process.env,PATH:'/usr/bin:/bin',KM_AGENT_APP_DATA_DIR:join(directory,'data'),KM_AGENT_DISABLE_CODEX:'1'},stdio:['pipe','pipe','pipe']});
 const queue=[],waiters=[];let errors='';child.stderr.on('data',b=>errors+=b.toString());
 createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiters.push(r));
 async function command(action,fields={}){const id=action;child.stdin.write(JSON.stringify({id,action,...fields})+'\n');while(true){const msg=await next();if(msg.id===id){assert.equal(msg.ok,true,msg.error);return msg.data;}}}
 const deadline=setTimeout(()=>{child.kill();process.exitCode=1;},15000);deadline.unref();
 assert.equal((await next()).event,'ready');
 const state=await command('start',{config:{origins:['https://app.ltpass.com']}});assert.equal(state.state,'running');
 const health=await fetch(state.endpoint+'/v1/health',{headers:{Origin:'https://app.ltpass.com'}});assert.equal(health.status,200);
 const publish=await promisify(execFile)(node,[join(resources,'runtime/publish.mjs'),'--runtime',join(directory,'data/connector.json'),'status'],{cwd:directory,env:{PATH:'/usr/bin:/bin'}});assert.deepEqual(JSON.parse(publish.stdout),{ok:true,bindings:[]});
 await command('stop');const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);assert.equal(errors,'');clearTimeout(deadline);
 await assert.rejects(readFile(join(directory,'data/connector.json')),{code:'ENOENT'});
 console.log(JSON.stringify({zipExtracted:true,signatureVerified:true,bundledNodeOnly:true,workerStarted:true,healthVerified:true,publisherRuntimeVerified:true,cleanShutdown:true}));
}finally{if(child&&child.exitCode===null)child.kill();await rm(directory,{recursive:true,force:true});}
