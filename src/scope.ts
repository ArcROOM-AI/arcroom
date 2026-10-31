import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectOf } from './git.js';
import { ARCROOM_HOME, loadConfig } from './home.js';

// Laptop-wide setup (`arcroom init --everywhere`): Claude Code's user settings run ArcRoom's hook in every folder, so every
// clone and worktree of a repo you set up is covered. It acts only in repos set up with `arcroom init` (no repo is traced
// without that), and steps aside where the project's own ArcRoom hooks already run, so nothing is recorded twice.

export const RUNTIME_MARK = '.arcroom/runtime';
/** Claude Code's user settings file. */
export const userSettings = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');

/** True when this folder or one above it holds ArcRoom's own project hooks (init ran there). */
export function projectHooksAbove(cwd: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      if (readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8').replaceAll('\\\\', '/').includes(RUNTIME_MARK)) return true;
    } catch {
      // no project settings here
    }
    if (dirname(dir) === dir) return false;
  }
}

/** True when this folder is in a repo set up with `arcroom init` on this laptop. */
export const setUpHere = (cwd: string) => !!cwd && (loadConfig().setUp ?? []).includes(projectOf(cwd));

/** The laptop-wide hook acts here: a set-up repo, and no project hooks of ArcRoom's already run for this folder. */
export const laptopHookActs = (cwd: string) => setUpHere(cwd) && !projectHooksAbove(cwd);

// where `arcroom init` wires each agent in a project
export const AGENT_FILES: [string, string][] = [
  ['Claude Code', join('.claude', 'settings.local.json')],
  ['Codex', join('.codex', 'hooks.json')],
  ['Cursor', join('.cursor', 'hooks.json')],
  ['OpenCode', join('.opencode', 'plugins', 'arcroom.js')],
];
// the runtime under ~/.arcroom, or under ARCROOM_HOME when that is set
const runtimePath = join(ARCROOM_HOME, 'runtime').replaceAll('\\', '/');
/** This file runs ArcRoom's hook runtime. */
export const ours = (file: string) => {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8').replaceAll('\\\\', '/').replaceAll('\\', '/');
  return text.includes(RUNTIME_MARK) || text.includes(runtimePath);
};

/** Claude Code's user settings run ArcRoom's hook (init --everywhere) and this repo was set up on this laptop. */
export const laptopWide = (cwd: string) => setUpHere(cwd) && ours(userSettings());

/** Some agent's hooks record sessions in this folder (a hook-less MCP client's do not). */
export const hooksHere = (cwd: string) => AGENT_FILES.some(([, f]) => ours(join(cwd, f))) || laptopWide(cwd);
