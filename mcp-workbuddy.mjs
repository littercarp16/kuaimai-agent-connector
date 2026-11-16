import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStdio } from './src/adapters/workbuddy/mcp-workbuddy.mjs';
import { publicError } from './src/adapters/workbuddy/workbuddy-client.mjs';

export { createWorkBuddyMcpServer, runStdio } from './src/adapters/workbuddy/mcp-workbuddy.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdio().catch(error => {
    const safe = publicError(error);
    process.stderr.write(`WorkBuddy MCP: ${safe.code}: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
