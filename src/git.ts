import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';

// Every git call ArcRoom makes runs inside a repo it did not write, often with no one watching (hooks, the daemon).
// Two ways such a repo could run its own code through those calls, both closed here:
//   - Windows starts a git.exe sitting in the working folder before the one on PATH: git is looked up on PATH once,
//     absolute folders only, and always started by its full path
//   - the repo's .git/config can name a core.fsmonitor command that `git status` / `ls-files` run: it is switched off
//     on every call (with the untracked cache that relies on it)

const NAMES = process.platform === 'win32' ? ['git.exe'] : ['git'];
const SAFE = ['-c', 'core.fsmonitor=', '-c', 'core.untrackedCache=false'];
let found: string | null | undefined;

/** The full path of the first of these program names on PATH (absolute folders only, never the working folder). */
export function onPath(names: string[], path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) for (const name of names) if (dir && isAbsolute(dir) && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** git's full path from PATH, or null when git is not installed. */
export function gitPath(path = process.env.PATH ?? ''): string | null {
  if (path !== process.env.PATH) return onPath(NAMES, path);
  if (found === undefined) found = onPath(NAMES, path);
  return found;
}

/** Runs git safely in `cwd`; stdout is undefined when git is missing or fails to start. */
export function git(args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {}) {
  const bin = gitPath();
  if (!bin) return { status: null, stdout: undefined as string | undefined };
  // hooks run with no console of their own: without windowsHide each git call flashes a window on Windows
  const r = spawnSync(bin, [...SAFE, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
  return { status: r.status, stdout: r.stdout as string | undefined };
}

/** Project id shared by everyone on the repo: its git remote without protocol/credentials/.git, else the folder path. */
export function projectOf(cwd: string): string {
  const remote = git(['config', '--get', 'remote.origin.url'], { cwd }).stdout?.trim();
  if (!remote) return cwd.replaceAll('\\', '/').toLowerCase();
  return remote
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, '') // https://user:token@host/... -> host/...
    .replace(/^[^@]+@([^:]+):/, '$1/') // git@host:owner/repo -> host/owner/repo
    .replace(/\.git$/, '')
    .toLowerCase();
}

/** The repo's top folder, or undefined outside a git repo. */
export const gitRoot = (cwd: string) => {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 });
  return r.status === 0 ? r.stdout?.trim() : undefined;
};

/** A path (absolute, or relative to `from`) as a repo path: "src/billing/tax.ts", or undefined outside the repo. */
export function repoPath(root: string, p: string, from = root): string | undefined {
  const rel = relative(root, isAbsolute(p) ? p : join(from, p)).replaceAll('\\', '/');
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel || '.';
}
