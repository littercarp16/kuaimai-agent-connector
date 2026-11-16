import{readFile,stat}from'node:fs/promises';import{publishEvent,readRuntime}from'../runtime/publisher.mjs';
import{contract}from'../protocol/protocol.mjs';
import{isAbsolute}from'node:path';
const args=process.argv.slice(2);
let runtimePath;
if(args.includes('--runtime')){
 const index=args.indexOf('--runtime');runtimePath=args[index+1];
 if(typeof runtimePath!=='string'||!isAbsolute(runtimePath)||args.lastIndexOf('--runtime')!==index){console.error('需要唯一的 --runtime <绝对运行文件路径>');process.exit(1);}
 args.splice(index,2);
}
if(!args.length||args.includes('--help')){
 console.log('可选：--runtime <绝对运行文件路径> 指定桌面实例\n快麦Agent标准交互 km-agent/1（只更新已绑定网页，不执行业务操作）\n发布：node publish.mjs --session <ses...> --file <事件.json>\n状态：node publish.mjs status\n机器可读指令映射：node publish.mjs commands\n前端回执：node publish.mjs receipt --session <ses...> --id <事件ID>\n事件格式：{"protocol":"km-agent/1","id":"唯一ID","type":"resource.create","payload":{"id":"report","kind":"page","name":"销售分析","appearance":{"theme":"ink"}}}\n新建resource.create；编辑resource.edit；呼出panel.open；等待work.status；活动activity.updated；成果artifact.updated、page.section.updated、table.rows.append；预览完成artifact.ready。兼容plan.updated、step.updated、artifact.focus、run.note。\n每个事件小于19KB；唯一ID幂等。accepted是连接器接收，applied是浏览器应用；二者都不是平台保存。');
}else if(args[0]==='commands'){console.log(JSON.stringify(contract(),null,2));}else if(args[0]==='receipt'){
 try{const runtime=await readRuntime(runtimePath),sessionId=args[args.indexOf('--session')+1],eventId=args[args.indexOf('--id')+1];if(!args.includes('--session')||!args.includes('--id'))throw Error('receipt需要--session和--id');const response=await fetch(runtime.endpoint+'/v1/local/receipt',{method:'POST',headers:{'Content-Type':'application/json','X-Km-Agent':'1','X-Km-Publisher':runtime.key},body:JSON.stringify({sessionId,eventId}),signal:AbortSignal.timeout(5000)});const result=await response.json();if(!result.ok)throw Error(result.error?.message);console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({ok:false,error:String(error.message).slice(0,180)}));process.exitCode=1;}
}else{
 try{
  if(args[0]==='status'){const state=await readRuntime(runtimePath);console.log(JSON.stringify({ok:true,bindings:state.bindings||[]}));}
  else{
   const known=new Set(['--session','--file']);const options={};for(let i=0;i<args.length;i+=2){if(!known.has(args[i])||!args[i+1])throw Error('参数无效，请使用--help');options[args[i]]=args[i+1];}
   if(!options['--file'])throw Error('请指定事件JSON文件');if((await stat(options['--file'])).size>19000)throw Error('事件文件超过19KB');
   const event=JSON.parse(await readFile(options['--file'],'utf8'));console.log(JSON.stringify(await publishEvent({runtimePath,sessionId:options['--session'],event})));
  }
 }catch(error){console.error(JSON.stringify({ok:false,error:['ENOENT','ECONNREFUSED'].includes(error.code)?'连接器或事件文件不可用，请确认本机服务与前端绑定':String(error.message).slice(0,180)}));process.exitCode=1;}
}
