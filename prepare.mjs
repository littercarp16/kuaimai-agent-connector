#!/usr/bin/env node
// Product CLI compatibility entry; portable implementation belongs to the distributed skill.
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runPrepareCli } from './skills/km-agent-bridge/scripts/prepare.mjs';
export { ensureRuntime } from './skills/km-agent-bridge/scripts/prepare.mjs';
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) await runPrepareCli();
