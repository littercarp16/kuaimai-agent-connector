#!/usr/bin/env node
import { runService, ensureService, instanceDirectory, connectService, control, openCallback } from './src/headless/service.mjs';
try {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22) throw Error('代码版目前支持 macOS 和 Node.js 22+');
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--request','--origin','--directory','--port'].includes(args[i]) || !args[i+1] || options[args[i].slice(2)] !== undefined) throw Error('启动参数无效'); options[args[i].slice(2)] = args[i+1]; }
  if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535)) throw Error('首选端口无效');
  if (options.port) options.port = Number(options.port);
  if (options.origin) options.directory ||= instanceDirectory(options.origin);
  if (action === 'serve') await runService(options);
  else {
    let result;
    if (action === 'connect') { result = await connectService(options.request, options); if (result.transport !== 'direct') await openCallback(result); }
    else if (action === 'start') result = await ensureService(options);
    else if (['status','stop'].includes(action)) result = await control(options.directory, { action });
    else throw Error('用法：node headless.mjs connect --request <网页生成的请求>；status/stop --origin <网页来源>');
    const { callbackURL, browser, ...publicResult } = result;
    console.log(JSON.stringify({ ok: true, ...publicResult }));
  }
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
