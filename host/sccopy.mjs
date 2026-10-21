#!/usr/bin/env node
import { run } from './clipboard.mjs';

process.exitCode = await run({ name: 'sccopy', mode: 'copy' });
