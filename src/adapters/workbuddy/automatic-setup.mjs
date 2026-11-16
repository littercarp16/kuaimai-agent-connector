import{mkdir,open,readFile,readdir,lstat,realpath}from'node:fs/promises';import{join,dirname,resolve,relative,isAbsolute}from'node:path';
import{safePath,WorkBuddyError}from'./workbuddy-client.mjs';
import{validVersion}from'../../../skills/km-agent-bridge/scripts/prepare.mjs';
const fail=code=>{throw new WorkBuddyError(code);},json=value=>JSON.stringify(value,null,2)+'\n';
const inside=(child,parent)=>{const r=relative(parent,child);return r===''||!r.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&r!=='..'&&!isAbsolute(r);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function loopback(value){try{const u=new URL(value);return u.origin===value&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>=1024;}catch{return false;}}
export async function exportAutomaticConfig({out,origin,endpoint='http://127.0.0.1:17653',workspace,runtimeRoot,skillDirectory,release,dryRun=false}={}){
 if(!out||!workspace||!runtimeRoot||!skillDirectory||!loopback(origin)||!loopback(endpoint)||typeof dryRun!=='boolean'||Number(process.versions.node.split('.')[0])<22)fail('INVALID_CONFIG');
 const directory=await safePath(resolve(out),{allowMissing:true}),root=await safePath(resolve(runtimeRoot),{allowMissing:true}),skill=await safePath(resolve(skillDirectory)),work=await safePath(resolve(workspace));
 if(inside(directory,root)||inside(skill,root)||!(await lstat(skill)).isDirectory()||!(await lstat(work)).isDirectory())fail('INVALID_CONFIG');
 const gateway=join(skill,'scripts/mcp-entry.mjs'),seed=join(skill,'scripts/prepare.mjs');
 for(const file of[gateway,seed,join(skill,'SKILL.md')]){await safePath(file);const info=await lstat(file);if(!info.isFile()||process.getuid&&info.uid!==process.getuid()||info.mode&0o022)fail('UNSAFE_PATH');}
 const bootstrap={version:1,allowPortFallback:true,endpoint,origin,launcher:join(root,'start.mjs'),runtimeFile:join(root,'.runtime/connector.json'),mcpEntry:join(root,'mcp-workbuddy.mjs'),launchArgs:['--adapter','opencode','--trust-origin',origin,'--port',new URL(endpoint).port,'--workspace',work]};
 if(new URL(endpoint).port!=='17653')bootstrap.runtimeFile=join(root,`.runtime/connector-${new URL(endpoint).port}.json`);
 if(release!==undefined){
  if(!plain(release)||Object.keys(release).sort().join()!=='installRoot,sha256,url,version'||!/^[a-f\d]{64}$/i.test(release.sha256||'')||!validVersion(release.version))fail('INVALID_CONFIG');
  let u;try{u=new URL(release.url);}catch{fail('INVALID_CONFIG');}if(u.protocol!=='https:'||u.username||u.password||u.hash||release.url.length>2048||!isAbsolute(release.installRoot))fail('INVALID_CONFIG');
  const installRoot=await safePath(release.installRoot,{allowMissing:true});if(join(installRoot,release.version)!==root)fail('INVALID_CONFIG');bootstrap.release={...release,installRoot};
 }
 const files=new Map([
  ['bootstrap.json',json(bootstrap)],
  ['connection.json',json({version:1,bootstrapFile:join(directory,'bootstrap.json'),origin,workspaceRoot:work})],
  ['mcp.json',json({mcpServers:{'kuaimai-workbuddy':{command:await realpath(process.execPath),args:[gateway,'--config',join(directory,'connection.json')]}}})],
  ['host-pointer.json',json({version:1,bootstrapFile:join(directory,'bootstrap.json'),seedFile:seed})]
 ]);
 let exists=false;try{
  const info=await lstat(directory);if(!info.isDirectory())fail('EXPORT_CONFLICT');exists=true;const names=await readdir(directory);
  if([...files.keys()].some(name=>!names.includes(name))||names.some(name=>!files.has(name)&&!/^\.km-effective-[0-9a-f-]{36}\.json$/i.test(name)))fail('EXPORT_CONFLICT');
  for(const[name,content]of files){const file=join(directory,name);await safePath(file);if(!(await lstat(file)).isFile()||await readFile(file,'utf8')!==content)fail('EXPORT_CONFLICT');}
 }catch(error){if(error instanceof WorkBuddyError)throw error;if(error.code!=='ENOENT')fail('EXPORT_CONFLICT');if(exists)fail('EXPORT_CONFLICT');}
 if(!exists){await safePath(dirname(directory));if(!dryRun){await mkdir(directory,{mode:0o700});await safePath(directory);for(const[name,content]of files){const h=await open(join(directory,name),'wx',0o600);try{await h.writeFile(content);}finally{await h.close();}}}}
 return{exported:!dryRun,dryRun,unchanged:exists,files:[...files.keys()].map(name=>join(directory,name)),automatic:true,downloadConfigured:Boolean(release),notice:'仅导出独立产品配置；MCP/本机宿主由准备器复用、安装或启动。未改厂商配置，未运行模型或业务。'};
}
