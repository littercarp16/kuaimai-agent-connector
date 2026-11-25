import{test}from'node:test';import assert from'node:assert/strict';
import{readFile,mkdtemp,mkdir,writeFile,stat,access,cp,rm,symlink}from'node:fs/promises';
import{fileURLToPath}from'node:url';import{join,resolve,dirname}from'node:path';import{tmpdir}from'node:os';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{contract}from'../../src/protocol/protocol.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../skills/',import.meta.url));
async function sandbox(t){const p=await mkdtemp(join(tmpdir(),'km-portable-skill-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
async function run(args,options={}){try{const{stdout}=await exec(process.execPath,args,{timeout:15000,...options});return{exit:0,...JSON.parse(stdout)};}catch(e){if(e.code==='ENOENT')throw e;let data;try{data=JSON.parse(e.stdout||e.stderr);}catch{data={stderr:e.stderr};}return{exit:typeof e.code==='number'?e.code:1,...data};}}
test('技能分发目录存在，并且命令目录与当前协议全部15项一致',async()=>{
 const entry=await readFile(join(root,'km-agent-bridge/SKILL.md'),'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));assert.match(entry,/^---\nname: km-agent-bridge\ndescription: Use when/m);assert.doesNotMatch(entry,/prototypes\/|\/Users\/|\.\.\/\.\.\//);const result=await run([join(root,'km-agent-bridge/scripts/bridge.mjs'),'commands']);assert.equal(result.exit,0);assert.deepEqual(Object.keys(result.data.commands).sort(),Object.keys(contract().commands).sort());
});
test('安装器dry-run不写目标，项目级与用户级目录明确，未知端须自定义目标',async t=>{
 const p=await sandbox(t),target=join(p,'project');const dry=await run([join(root,'install.mjs'),'--agent','codex','--scope','project','--project',target,'--dry-run']);assert.equal(dry.exit,0);assert.match(dry.data.target,/\.agents\/skills\/km-agent-bridge$/);await assert.rejects(()=>access(target));
 const user=await run([join(root,'install.mjs'),'--agent','claude-code','--scope','user','--dry-run'],{env:{...process.env,HOME:p,XDG_CONFIG_HOME:join(p,'config')}});assert.equal(user.exit,0);assert.equal(user.data.target,join(p,'.claude/skills/km-agent-bridge'));const unknown=await run([join(root,'install.mjs'),'--agent','workbuddy','--scope','project','--project',target,'--dry-run']);assert.notEqual(unknown.exit,0);assert.equal(unknown.error.code,'TARGET_REQUIRED');
});
test('完整分发目录搬离仓库后可安装，已安装技能离线运行不依赖源码',async t=>{
 const p=await sandbox(t),bundle=join(p,'bundle'),project=join(p,'app');await cp(root,bundle,{recursive:true});const install=await run([join(bundle,'install.mjs'),'--agent','cursor','--scope','project','--project',project],{cwd:p});assert.equal(install.exit,0,JSON.stringify(install));assert.equal(install.data.status,'installed');const installed=join(project,'.cursor/skills/km-agent-bridge');await rm(bundle,{recursive:true});const result=await run([join(installed,'scripts/bridge.mjs'),'commands'],{cwd:p,env:{...process.env,KM_AGENT_BRIDGE_CONFIG:''}});assert.equal(result.exit,0,JSON.stringify(result));assert.equal(Object.keys(result.data.commands).length,15);const again=await run([join(root,'install.mjs'),'--target',join(project,'.cursor/skills')]);assert.equal(again.exit,0);assert.equal(again.data.status,'unchanged');
});
test('已有不同技能和符号链接不可被覆盖，安装不包含凭据/运行时/依赖',async t=>{
 const p=await sandbox(t),target=join(p,'skills'),dest=join(target,'km-agent-bridge');await mkdir(dest,{recursive:true});await writeFile(join(dest,'SKILL.md'),'USER_WORK');const conflict=await run([join(root,'install.mjs'),'--target',target]);assert.notEqual(conflict.exit,0);assert.equal(await readFile(join(dest,'SKILL.md'),'utf8'),'USER_WORK');const symlinkTarget=join(p,'alias');await symlink(target,symlinkTarget);const link=await run([join(root,'install.mjs'),'--target',symlinkTarget]);assert.notEqual(link.exit,0);const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));assert.ok(manifest.files.length>5);for(const path of manifest.files)assert.doesNotMatch(path,/node_modules|\.runtime|connector\.json|^\.\.|auth\.json/);
});
test('安装不偷偷写入未指定Agent目录或启动配置',async t=>{
 const p=await sandbox(t),project=join(p,'app');const installed=await run([join(root,'install.mjs'),'--agent','codex','--scope','project','--project',project]);assert.equal(installed.exit,0);await access(join(project,'.agents/skills/km-agent-bridge/SKILL.md'));for(const extra of ['.claude','.cursor','.opencode','opencode.json','AGENTS.md'])await assert.rejects(()=>access(join(project,extra)));
});
test('分发payload的文档链接全部在技能内，不残留开发者目录',async()=>{
 const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),base=join(root,manifest.id);for(const file of manifest.files){const path=join(base,file),text=await readFile(path,'utf8');assert.doesNotMatch(text,/\/Users\/|prototypes\/kmMDTable|\.\.\/\.\.\/\.\./);if(file.endsWith('.md'))for(const match of text.matchAll(/\]\(([^)]+)\)/g)){if(/^(https?:|#)/.test(match[1]))continue;const linked=resolve(dirname(path),match[1]);assert.ok(linked.startsWith(base+'/'));await access(linked);}}
});
test('自定义目标和项目根的祖先链接也必须拒绝，不向链接外目录安装',async t=>{
 const p=await sandbox(t),outside=join(p,'outside'),alias=join(p,'alias');await mkdir(outside);await symlink(outside,alias);for(const args of [['--target',join(alias,'skills')],['--agent','codex','--scope','project','--project',join(alias,'app')]]){const result=await run([join(root,'install.mjs'),...args]);assert.notEqual(result.exit,0);assert.equal(result.error.code,'SYMLINK');}await assert.rejects(()=>access(join(outside,'skills')));await assert.rejects(()=>access(join(outside,'app')));
});
