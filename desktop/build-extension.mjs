#!/usr/bin/env node
import { readFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'browser-extension/manifest.json')));
const directory = join(root, 'dist'), output = join(directory, `kuaimai-agent-extension-${manifest.version}.zip`);
await mkdir(directory, { recursive: true }); await rm(output, { force: true });
await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(root, 'browser-extension'), output]);
console.log(output);
