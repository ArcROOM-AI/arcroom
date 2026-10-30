// node --test with an explicit file list: Node 20 has no globs, and Node 22 runs a bare folder as a module
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('dist').filter((f) => f.endsWith('.test.js')).map((f) => `dist/${f}`);
if (!files.length) throw new Error('no tests in dist/: run npm run build first');
process.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);
