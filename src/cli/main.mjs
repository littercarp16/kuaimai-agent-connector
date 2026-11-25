import { createHash,randomInt,randomBytes } from 'node:crypto';
import {mkdir,writeFile,rename,readFile,unlink,chmod,realpath,stat,lstat}from'node:fs/promises';
import{fileURLToPath}from'node:url';
import { createConnector } from '../http/server.mjs';
import { createFileLogger } from '../runtime/logger.mjs';
import{createCodexAdapter}from'../adapters/codex/codex.mjs';
import{createProductAdapters}from'../adapters/product-adapters.mjs';
import{createWorkBuddySessionList,workBuddySessionOptions}from'../adapters/workbuddy/session-list.mjs';
import{parseLaunchOptions}from'../runtime/launch-options.mjs';
import { claimService, serviceProfile, listenAvailable } from '../runtime/service-instance.mjs';
import{loadNativeScopes}from'../runtime/native-scope-config.mjs';
import { createCodexDesktopManager } from '../runtime/codex-desktop.mjs';
import { createCodexDockManager } from '../runtime/codex-desktop-dock.mjs';
import { loadBootstrapConfig } from '../../skills/km-agent-bridge/scripts/prepare.mjs';
import{homedir}from'node:os';import{join}from'node:path';

process.title = 'kuaimai-agent-connector';
const pairCode=String(randomInt(100000,1000000));
if(process.argv.includes('--help')){console.log('node main.mjs [--adapter opencode|generic] [--session ses_...] [--trust-origin http://127.0.0.1:4173 | --origin https://your-app.example] [--allow-origin https://another-app.example] [--workspace /绝对工作目录] [--allow-control] [--pin-session]\n无会话受信入口仅观察；新任务默认自动查看，不停止旧任务或继承控制授权。generic只发布UI。');process.exit(0);}
async function launchArguments(args) {
  if (args.length) return args;

  const profile = fileURLToPath(new URL('../../.runtime/kmmdtable-bootstrap.json', import.meta.url));
  try {
    await lstat(profile);
  } catch (error) {
    if (error.code === 'ENOENT') return args;
    throw error;
  }
  const config = await loadBootstrapConfig(profile);
  return config.launchArgs;
}

const config=parseLaunchOptions(await launchArguments(process.argv.slice(2))),origin=config.origin;
const authorizedWorkspace=await realpath(config.workspace||process.cwd());
if(!(await stat(authorizedWorkspace)).isDirectory())throw Error('工作区须为现有目录');
const sessionOptions=workBuddySessionOptions(config.workspace ? authorizedWorkspace : undefined);
delete process.env.KM_AGENT_WORKBUDDY_PASSWORD;
const workBuddyServe=sessionOptions ? createWorkBuddySessionList(sessionOptions) : null;
const publisherKey=randomBytes(32).toString('base64url'),runtimeDir=fileURLToPath(new URL('../../.runtime/',import.meta.url)),runtimePath=runtimeDir+(config.port===17653?'connector.json':`connector-${config.port}.json`);
let endpoint=`http://127.0.0.1:${config.port}`;
const releaseService=await claimService(runtimePath,serviceProfile(config,authorizedWorkspace));
await mkdir(runtimeDir,{recursive:true,mode:0o700});await chmod(runtimeDir,0o700);
const logger=createFileLogger({path:runtimePath.replace(/\.json$/,'.log')});
logger.info('service.starting',{origin,preferredPort:config.port,maxBytes:logger.maxBytes,backups:logger.backups});
process.on('uncaughtExceptionMonitor',error=>logger.error('process.uncaught_exception',{error}));
let bindings=[],writeQueue=Promise.resolve();
function persist(){writeQueue=writeQueue.catch(()=>{}).then(async()=>{await mkdir(runtimeDir,{recursive:true,mode:0o700});await chmod(runtimeDir,0o700);await writeFile(runtimePath+'.next',JSON.stringify({instanceId:connector.instanceId,endpoint,protocol:'km-agent/1',key:publisherKey,bindings}),{mode:0o600});await rename(runtimePath+'.next',runtimePath);});return writeQueue;}
const printCode=code=>console.log(`本地配对码：${code}（10分钟内有效，仅使用一次；仅在已指定来源的快麦本地Agent面板填写）`);
let codexEnabled=process.env.KM_AGENT_DISABLE_CODEX!=='1',codexWorkspace=authorizedWorkspace,qwenEnabled=false;
try{
  const scopes=await loadNativeScopes({configFile:process.env.KM_AGENT_NATIVE_SOURCES_FILE||join(homedir(),'.config/kuaimai-agent/native-sources.json'),endpoint,origin,workspaceRoot:authorizedWorkspace});
  codexWorkspace=scopes.codexWorkspace;
  qwenEnabled=scopes.qwenEnabled===true;
}catch(error){logger.error('agent.config_failed',{error});codexEnabled=false;console.error('本机来源范围配置无效，已禁用依赖该配置的来源。');}
const adapter=createProductAdapters({adapter:config.adapter,sessionId:config.sessionId,workspace:authorizedWorkspace,codexWorkspace,codexEnabled,qwenEnabled,qwenSessionId:process.env.KM_AGENT_QWEN_SESSION,workBuddyServe},{codex:createCodexAdapter});
const connector=createConnector({adapter,logger,manualSessionSelection:!!workBuddyServe,codexDesktop:codexEnabled&&process.platform==='darwin'?createCodexDesktopManager({dock:createCodexDockManager()}):null,enableMultiAgentFollow:true,enableWorkBuddy:true,workBuddyOptions:{workspaceId:'ws_'+createHash('sha256').update(authorizedWorkspace).digest('hex')},allowedOrigins:[origin,...(config.additionalOrigins||[])],autoTrust:config.auto?{origin,sessionId:config.sessionId,allowControl:config.allowControl,followSessions:config.followSessions}:null,pairCode,onPairCode:printCode,publisherKey,onBindings:value=>{bindings=value;void persist().catch(error=>{logger.error('service.persist_failed',{instanceId:connector.instanceId,error});console.error('本地发布状态写入失败；网页会话不受影响，请检查本机目录权限');});}});
async function shutdown(code=0) {
  logger.info('service.stopping',{instanceId:connector.instanceId,endpoint});
  await connector.close(); await writeQueue.catch(()=>{});
  try { if(JSON.parse(await readFile(runtimePath,'utf8')).instanceId===connector.instanceId)await unlink(runtimePath); } catch {}
  await releaseService();logger.info('service.stopped',{instanceId:connector.instanceId,endpoint});logger.close(); process.exit(code);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown());
try {
  const port=await listenAvailable(connector.server,config.port);
  endpoint=`http://127.0.0.1:${port}`;
  await persist();
  logger.info('service.started',{instanceId:connector.instanceId,endpoint,port,preferredPort:config.port});
  console.log('快麦 Agent 连接器 · km-agent/1 标准交互版');
  if(port!==config.port)console.log(`首选端口 ${config.port} 已占用，自动使用 ${port}`);
  console.log(`监听 ${endpoint}，允许来源 ${[origin,...(config.additionalOrigins||[])].join(', ')}`);
  console.log(config.auto?'受信来源自动握手已启用；限定本机会话，保留原工具权限，不自动保存或发布。':'高级手动授权模式；可通过本机启动参数开启受信来源自动握手。');
  if(!config.auto||config.additionalOrigins?.length)printCode(pairCode);
} catch (error) {
  logger.error('service.start_failed',{error});
  console.error('连接器启动失败，请检查本机日志和目录权限');
  await shutdown(1);
}
