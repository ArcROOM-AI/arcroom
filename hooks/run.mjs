// Claude Code plugin entry (hooks and MCP server). The plugin folder is the git repo, which has no build, so this runs the
// runtime `arcroom init` keeps in ~/.arcroom/runtime, fetching this repo's npm version there first when it is missing or
// another version. Plain JavaScript on purpose: it must run before anything is built or installed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// same rule as homeFrom in src/home.ts: an ARCROOM_HOME inside the folder being worked in is ignored
const custom = process.env.ARCROOM_HOME;
const rel = custom && isAbsolute(custom) ? relative(process.cwd(), custom) : '';
const home = custom && isAbsolute(custom) && (rel.startsWith('..') || isAbsolute(rel)) ? custom : join(homedir(), '.arcroom');
const runtime = join(home, 'runtime');
const entry = join(runtime, 'index.js');

const installed = () => {
  try {
    return JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
};
// ponytail: two hooks starting at once on a first run may both fetch; the copies are the same files, add a lock if that bites
if (installed() !== version) {
  // a fixed command with no user input, so the shell Windows needs for npx.cmd is safe here
  spawnSync('npx', ['-y', `arcroom@${version}`, 'runtime'], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32', windowsHide: true });
}
if (!existsSync(entry)) {
  // a hook must never break a session; the MCP server says why it could not start
  if (process.argv[2] !== 'hook') console.error(`ArcRoom could not fetch arcroom@${version} from npm. Check your connection and start a new session.`);
  process.exit(process.argv[2] === 'hook' ? 0 : 1);
}
process.argv = [process.argv[0], entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
