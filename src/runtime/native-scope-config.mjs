import{lstat,realpath,stat}from'node:fs/promises';
import{isAbsolute,normalize}from'node:path';
import{readConfigFile,validLoopbackOrigin}from'../../skills/km-agent-bridge/scripts/prepare.mjs';
import{validWebOrigin}from'./web-origin.mjs';
const invalid=()=>{throw Object.assign(Error('原生来源范围配置无效；未扩大工作区授权'),{code:'NATIVE_SCOPE_CONFIG_INVALID'});};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const shape=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const absolute=v=>typeof v==='string'&&v.length<=4096&&isAbsolute(v)&&normalize(v)===v&&!v.includes('\0');
export async function loadNativeScopes({configFile,endpoint,origin,workspaceRoot}={}){
 try{
  if(!absolute(configFile)||!absolute(workspaceRoot)||!validLoopbackOrigin(endpoint,true)||!validWebOrigin(origin))invalid();
  const root=await realpath(workspaceRoot);if(!(await stat(root)).isDirectory())invalid();
  const fallback={configured:false,codexWorkspace:root};
  try{const info=await lstat(configFile);if(!info.isFile()||info.isSymbolicLink())invalid();}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
  const config=await readConfigFile(configFile,{runtime:true,limit:16384});
  if(!shape(config,['version','profiles'])||config.version!==1||!Array.isArray(config.profiles)||config.profiles.length>16)invalid();
  const seen=new Set();let chosen=null;
  for(const profile of config.profiles){
   const keys=['endpoint','origin','workspaceRoot','codexWorkspace'];
   if(object(profile)&&Object.hasOwn(profile,'qwenEnabled'))keys.push('qwenEnabled');
   if(!shape(profile,keys)||!validLoopbackOrigin(profile.endpoint,true)||!validWebOrigin(profile.origin)||!absolute(profile.workspaceRoot)||!absolute(profile.codexWorkspace)||keys.includes('qwenEnabled')&&typeof profile.qwenEnabled!=='boolean')invalid();
   const key=JSON.stringify([profile.endpoint,profile.origin,profile.workspaceRoot]);if(seen.has(key))invalid();seen.add(key);
   if(profile.endpoint===endpoint&&profile.origin===origin&&profile.workspaceRoot===root)chosen=profile;
  }
  if(!chosen)return fallback;
  const codexWorkspace=await realpath(chosen.codexWorkspace);if(!(await stat(codexWorkspace)).isDirectory())invalid();
  return{configured:true,codexWorkspace,...(chosen.qwenEnabled===true?{qwenEnabled:true}:{})};
 }catch{invalid();}
}
