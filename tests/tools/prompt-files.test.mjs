import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,symlink,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const api=await import('../../src/tools/prompt-files.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
test('附件转换为原生data URI，拒绝伪类型、错误base64、可执行HTML及超限',()=>{
 assert.equal(typeof api.normalizeUploads,'function');const uploads=api.normalizeUploads([{name:'说明.txt',mime:'text/plain',base64:Buffer.from('测试文件').toString('base64')}]);assert.match(uploads[0].uri,/^data:text\/plain;base64,/);assert.equal(uploads[0].name,'说明.txt');assert.throws(()=>api.normalizeUploads([{name:'x.png',mime:'image/png',base64:Buffer.from('not png').toString('base64')}]));assert.throws(()=>api.normalizeUploads([{name:'x.html',mime:'text/html',base64:'YQ=='}]));assert.throws(()=>api.normalizeUploads(Array.from({length:6},()=>({name:'x.txt',mime:'text/plain',base64:'YQ=='}))));
});
test('工作区引用只读取当前目录普通文件，拒绝越界/凭据/技能资源和外部符号链接',async t=>{
 assert.equal(typeof api.readWorkspaceReference,'function');const root=await mkdtemp(join(tmpdir(),'km-composer-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'safe.md'),'普通文件');await writeFile(join(root,'.env'),'NEVER_READ');await mkdir(join(root,'.agents/skills/a'),{recursive:true});await writeFile(join(root,'.agents/skills/a/SKILL.md'),'INTERNAL_SKILL');await symlink('/etc/hosts',join(root,'external.txt'));
 const f=await api.readWorkspaceReference(root,'safe.md');assert.equal(Buffer.from(f.uri.split(',')[1],'base64').toString(),'普通文件');for(const p of ['../outside.txt','.env','.agents/skills/a/SKILL.md','external.txt','/etc/hosts'])await assert.rejects(()=>api.readWorkspaceReference(root,p));
});
test('普通名称符号链接不能绕过隐藏目录边界',async t=>{
 const root=await mkdtemp(join(tmpdir(),'km-hidden-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'.hidden'));await writeFile(join(root,'.hidden','data.txt'),'PRIVATE_HIDDEN');await symlink(join(root,'.hidden','data.txt'),join(root,'innocent.txt'));await assert.rejects(()=>api.readWorkspaceReference(root,'innocent.txt'));
});
