#!/usr/bin/env node
import { runNativeHost, validCaller } from './src/extension/native-host.mjs';
if (!validCaller(process.argv[2])) process.exitCode = 1;
else await runNativeHost();
