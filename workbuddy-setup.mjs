import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCli } from './src/adapters/workbuddy/workbuddy-setup.mjs';
import { publicError } from './src/adapters/workbuddy/workbuddy-client.mjs';

export { exportWorkBuddyConfig, setupCli } from './src/adapters/workbuddy/workbuddy-setup.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupCli().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    const safe = publicError(error);
    process.stderr.write(`WorkBuddy配置导出: ${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
