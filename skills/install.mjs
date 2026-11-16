#!/usr/bin/env node
import{readFile,lstat,realpath,readdir,mkdir,writeFile}from'node:fs/promises';
import{resolve,join,dirname,relative}from'node:path';import{fileURLToPath}from'node:url';import{homedir}from'node:os';

const source=fileURLToPath(new URL('./',import.meta.url));
const profiles={opencode:{project:'.opencode/skills',user:()=>join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'opencode/skills')},'claude-code':{project:'.claude/skills',user:()=>join(homedir(),'.claude/skills')},codex:{project:'.agents/skills',user:()=>join(homedir(),'.agents/skills')},cursor:{project:'.cursor/skills',user:()=>join(homedir(),'.cursor/skills')},qoder:{project:'.qoder/skills',user:()=>join(homedir(),'.qoder/skills')}};
class InstallError extends Error{constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new InstallError(code,message);};
async function exists(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){if((await exists(p))?.isSymbolicLink()){const systemAlias=process.platform==='darwin'&&['/var','/tmp','/etc'].includes(p)&&(await realpath(p))==='/private'+p;if(!systemAlias)fail('SYMLINK','安装路径或其祖先含符号链接，请选择实际目录');}if(dirname(p)===p)break;}}
async function inventory(path){const result=[];async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isSymbolicLink())fail('SYMLINK','已有技能包含符号链接，不覆盖');if(entry.isDirectory())await walk(join(dir,entry.name),name+'/');else result.push(name);}}await walk(path);return result.sort();}

export async function install(args){
 if(args.includes('--help')||args.length===0)return{usage:'node install.mjs --agent opencode|claude-code|codex|cursor|qoder --scope project --project <目录> [--dry-run]\nnode install.mjs --agent opencode --scope user [--dry-run]\nnode install.mjs --agent <其他Agent> --target <其实际skills目录> [--dry-run]',notice:'仅安装技能；不启动服务，不安装依赖，不修改Agent配置，不覆盖不同内容。--target指skills父目录。'};
 const options={};for(let i=0;i<args.length;i++){const key=args[i];if(key==='--dry-run'){options.dryRun=true;continue;}if(!['--agent','--scope','--project','--target'].includes(key)||!args[i+1]||options[key]!==undefined)fail('ARGUMENT','安装参数无效或重复');options[key]=args[++i];}
 if(options['--target']&&(options['--scope']||options['--project']))fail('ARGUMENT','--target不能与scope/project混用');
 let parent,base;const agent=options['--agent']||'custom';
 if(options['--target'])parent=base=resolve(options['--target']);
 else{const profile=profiles[agent];if(!profile)fail('TARGET_REQUIRED','该Agent目录未内置核验，请用--target明确其实际skills目录');const scope=options['--scope'];if(!['project','user'].includes(scope))fail('SCOPE_REQUIRED','请明确--scope project或user');if(scope==='project'){if(!options['--project'])fail('PROJECT_REQUIRED','项目级安装需明确--project');base=resolve(options['--project']);parent=join(base,profile.project);}else{if(options['--project'])fail('ARGUMENT','用户级安装不接受--project');parent=profile.user();base=parent;}}
 await noLinks(parent,base);
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 if(manifest.id!=='km-agent-bridge'||!Array.isArray(manifest.files)||!manifest.files.includes('SKILL.md')||new Set(manifest.files).size!==manifest.files.length)fail('MANIFEST','技能清单无效');
 const payload=[];for(const name of manifest.files){if(typeof name!=='string'||!name||/[\\:]/.test(name)||name.split('/').some(x=>!x||x==='..'||x.startsWith('.'))||relative(join(source,manifest.id),resolve(source,manifest.id,name)).startsWith('..'))fail('MANIFEST','清单路径无效');const file=join(source,manifest.id,name);await noLinks(file);const info=await lstat(file);if(!info.isFile()||info.size>256000)fail('MANIFEST','清单文件类型或大小无效');payload.push({name,bytes:await readFile(file)});}
 const target=join(parent,manifest.id),old=await exists(target);let status='installed';
 if(old){if(!old.isDirectory()||old.isSymbolicLink())fail('CONFLICT','目标不是普通技能目录，不覆盖');const names=await inventory(target);const same=JSON.stringify(names)===JSON.stringify([...manifest.files].sort())&&(await Promise.all(payload.map(async f=>(await readFile(join(target,f.name))).equals(f.bytes)))).every(Boolean);if(!same)fail('CONFLICT','已有技能与分发包不同；请先自行备份/迁移，或使用其他目标目录。没有覆盖。');status='unchanged';}
 if(options.dryRun)return{target,agent,version:manifest.version,status:old?'unchanged':'planned',dryRun:true,files:manifest.files.length};
 if(!old){await mkdir(parent,{recursive:true});await noLinks(parent);const canonicalParent=await realpath(parent);await mkdir(target);await noLinks(target);if(await realpath(target)!==join(canonicalParent,manifest.id))fail('SYMLINK','安装目录边界在创建时发生变化，未复制文件');for(const f of payload){await mkdir(dirname(join(target,f.name)),{recursive:true});await writeFile(join(target,f.name),f.bytes,{flag:'wx',mode:0o644});}}
 return{target,agent,version:manifest.version,status,files:manifest.files.length,notice:'文件已安装不等于客户端已识别；请在目标Agent重新发现/加载技能。运行时需另行配置。'};
}
if(process.argv[1]&&(await realpath(process.argv[1]).catch(()=>''))===fileURLToPath(import.meta.url))try{console.log(JSON.stringify({ok:true,data:await install(process.argv.slice(2))}));}catch(e){console.error(JSON.stringify({ok:false,error:{code:e instanceof InstallError?e.code:'INSTALL_FAILED',message:e instanceof InstallError?e.message:'安装未完成；请检查路径和权限，可能存在未完成的目标目录。未覆盖已有文件。'}}));process.exitCode=1;}
