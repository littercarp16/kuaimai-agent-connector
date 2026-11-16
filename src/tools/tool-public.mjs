import{homedir}from'node:os';
import{redactText}from'./display-safety.mjs';
const cut=(s,max=500)=>String(s??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
const sensitive=/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.runtime|\.local-session|credentials?|id_rsa|id_ed25519)(?:[/\\]|$)|\.(?:pem|key)$/i;
export function publicPath(value){const path=cut(value,300);return sensitive.test(path)?'[受保护路径]':path.replace(homedir(),'~').replace(/[A-Za-z0-9_-]{40,}/g,'[已隐藏]');}
export function shellTokens(source){
 const tokens=[];let word='',quote='',escape=false,active=false;const flush=()=>{if(active)tokens.push({value:word,operator:false});word='';active=false;};
 for(const ch of String(source||'').slice(0,8000)){if(escape){word+=ch;active=true;escape=false;continue;}if(ch==='\\'&&quote!=="'"){escape=true;active=true;continue;}if(quote){if(ch===quote)quote='';else word+=ch;continue;}if(ch==='"'||ch==="'"){quote=ch;active=true;continue;}if(/\s/.test(ch)){flush();if(ch==='\n')tokens.push({value:';',operator:true});}else if(/[;&|]/.test(ch)){flush();tokens.push({value:ch,operator:true});}else{word+=ch;active=true;}}
 flush();return tokens;
}
const verbs=new Set('status diff log show list info query count get table data schema model connector pivot view scene workflow report service call run test install ci --short .'.split(' '));
const safeFlags=new Set('--profile --app-id --basic-data-id --schema-id --view-id --table-id --limit --offset --version'.split(' '));
const booleanFlags=new Set('--short --stat --name-only --porcelain --envelope --json --help --dry-run --yes'.split(' '));
function publicCommand(command){
 const first=String(command||'').split(/\r?\n/)[0],tokens=shellTokens(first),result=[];let executable=true;
 for(let i=0;i<tokens.length;i++){const token=tokens[i].value;if(tokens[i].operator){result.push(token);executable=true;continue;}if(/^[A-Za-z_][\w]*=/.test(token)){result.push('[环境赋值已隐藏]');continue;}
  if(executable){result.push(/^[\w@./+-]+$/.test(token)?publicPath(token):'[本地程序]');executable=false;continue;}
  if(booleanFlags.has(token)){result.push(token);continue;}
  if(token==='--input-type=module'||token==='--input-type=commonjs'){result.push(token);continue;}
  if(token.startsWith('-')){const[flag,inline]=token.split(/=(.*)/s);result.push(/^-{1,2}[A-Za-z][\w-]{0,50}$/.test(flag)?flag:'[选项已隐藏]');if(inline!==undefined||tokens[i+1]&&!tokens[i+1].value.startsWith('-')&&!tokens[i+1].operator){const value=inline===undefined?tokens[++i].value:inline;result.push(safeFlags.has(flag)&&/^[\w.-]{1,80}$/.test(value)?value:'[已隐藏]');}continue;}
  if(verbs.has(token)||/^[\w@./-]+\.(?:mjs|cjs|js|ts|json|md|vue|html|css)$/.test(token)||/^(?:test|build|start|lint|dev)(?::[\w.-]+)+$/.test(token))result.push(publicPath(token));else result.push('[参数已隐藏]');
 }
 return cut(result.join(' ')+(String(command).includes('\n')?' … [多行脚本不转发]':''));
}
export function publicToolInfo(name,input={}){
 const tool=String(name||'').toLowerCase();
 if(tool==='shell'||tool==='bash')return{summary:publicCommand(input.command||input.cmd||''),detail:'命令已按展示白名单脱敏；环境值、请求体与敏感参数不转发。'};
 if(['read','glob','grep'].includes(tool)){const path=publicPath(input.path||input.filePath||input.pattern&&tool==='glob'&&input.pattern||'当前工作区');return{summary:cut(path+(Number.isSafeInteger(input.offset)?` · 起始${input.offset}行`:'')+(Number.isSafeInteger(input.limit)?` · 最多${input.limit}行`:'')),detail:'显示目标与范围，不转发文件正文或匹配结果。'};}
 if(tool==='patch'){const paths=[...String(input.patchText||'').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].slice(0,5).map(x=>publicPath(x[1]));return{summary:paths.join('、')||'修改工作区文件',detail:'仅列出变更文件；不转发补丁正文。'};}
 if(tool==='webfetch'){try{const u=new URL(input.url);return{summary:['http:','https:'].includes(u.protocol)?publicPath(u.origin+u.pathname):'[非HTTP地址已隐藏]',detail:'URL凭据、查询和片段已移除。'};}catch{return{summary:'网页读取',detail:'地址不可公开展示。'};}}
  if(tool==='skill'){const id=input.id||input.name;return{summary:typeof id==='string'&&/^[\w-]{1,80}$/.test(id)?id:'技能加载',detail:'展开读取技能请求和完整正文。'};}
  if(tool==='subagent'||tool==='task')return{summary:cut([input.agent||input.subagent_type,input.description].filter(x=>typeof x==='string').map(x=>redactText(x,false)).join(' · ')||'子Agent任务'),detail:'展开读取任务请求及公开返回；不展示内部逐字推理。'};
 return{summary:'本地工具操作',detail:'该工具没有公开参数映射，原始请求保留在本地。'};
}
export function publicToolResult(name,{error}={}){
 const text=typeof error==='string'?error:String(error?.message||'');let errorSummary='';
 if(error){const offset=text.match(/offset\s+(\d+).*?out of range.*?\((\d+)\s+lines/i);errorSummary=offset?`起始行${offset[1]}超出文件${offset[2]}行`:/ENOENT|not found/i.test(text)?'目标文件或资源不存在':/EACCES|EPERM|permission|\b40[13]\b/i.test(text)?'权限校验未通过':/timeout|ETIMEDOUT/i.test(text)?'请求超时':/ECONNREFUSED|unreachable/i.test(text)?'目标服务不可达':'本地工具执行失败，原始错误保留在本地';}
  return{errorSummary,detail:errorSummary||'工具已返回结果，可展开读取已脱敏详情。'};
}
