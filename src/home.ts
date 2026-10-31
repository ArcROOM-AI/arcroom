import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { projectOf } from './git.js';
import { redact } from './redact.js';

/**
 * ArcRoom's folder: ~/.arcroom, or ARCROOM_HOME (tests, a second setup). A repo can set environment variables for the
 * hooks (.claude/settings.json "env"), so a relative ARCROOM_HOME, or one inside the folder being worked in, is ignored:
 * otherwise a cloned repo could ship its own config.json and send that repo's traces to its own server (M10).
 */
export function homeFrom(custom: string | undefined, cwd: string): string {
  const rel = custom && isAbsolute(custom) ? relative(cwd, custom) : '';
  return custom && isAbsolute(custom) && (rel.startsWith('..') || isAbsolute(rel)) ? custom : join(homedir(), '.arcroom');
}
export const ARCROOM_HOME = homeFrom(process.env.ARCROOM_HOME, process.cwd());

// Repos where this person switched ArcRoom off (arcroom off): no tracing, no lookups, nothing leaves the laptop (I6).
// Kept on this laptop, not in the repo, so a commit can neither switch it off nor back on for someone.
const OFF_FILE = join(ARCROOM_HOME, 'off-repos.json');
export const offRepos = (file = OFF_FILE): string[] => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};
/** Whether `cwd` is inside a repo switched off here. */
export const isOff = (cwd: unknown, repos = offRepos()) =>
  typeof cwd === 'string' && !!cwd && repos.some((r) => {
    const rel = relative(r, cwd);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
export function setOff(root: string, off: boolean, file = OFF_FILE): void {
  const next = offRepos(file).filter((r) => r !== root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(off ? [...next, root] : next, null, 2) + '\n', { mode: 0o600 });
}

// ArcRoom API (the Oracle server behind Caddy). A local API: arcroom init --url http://localhost:8787
export const DEFAULT_URL = 'https://api.arcroomai.com';

/** workspace: its name when init last checked the key, shown when a session starts. repos: a repo's own key (by its git
 *  remote, else its folder) when it sends to another workspace than the laptop's default, e.g. another client's. */
export type RepoKey = { apiKey: string; workspace?: string };
/** setUp: the repos `arcroom init` ran in (git remote, else folder); laptop-wide hooks act only in these. */
export type Config = { apiKey: string; url: string; workspace?: string; repos?: Record<string, RepoKey>; setUp?: string[] };

/** ~/.arcroom/config.json written by `arcroom init`; with `cwd`, the key of the repo it is in (its own, else the default). */
export function loadConfig(cwd?: string): Config {
  const file = join(ARCROOM_HOME, 'config.json');
  const saved: Config = { url: DEFAULT_URL, apiKey: '', ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };
  if (!cwd || !saved.repos || !Object.keys(saved.repos).length) return saved; // no git call unless some repo has its own key
  const own = saved.repos[projectOf(cwd)];
  return own ? { ...saved, apiKey: own.apiKey, workspace: own.workspace } : saved;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Whether `url` points at this machine (a developer's local API). */
export const isLocalUrl = (url: string): boolean => {
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
};
/** The API URL, refused unless it is https:// or this machine: the key and the traces never cross a network in clear text. */
export function apiUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL.has(u.hostname))) return u.origin + u.pathname.replace(/\/+$/, '');
  throw new Error(`the ArcRoom API URL must start with https:// (got ${u.protocol}//${u.host}); plain http is only for this machine`);
}

/**
 * POST/GET to the ArcRoom API with the saved key; throws with the API's error message. Every body is redacted here,
 * so what an agent stores through the tools (answers, steps, facts, notes) or a prompt sent for lookup never carries a
 * secret to the team.
 */
export async function api(cfg: Config, path: string, body?: object, timeoutMs = 10_000): Promise<any> {
  const base = apiUrl(cfg.url);
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(redact(body)) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: Error) => {
    // a timeout stays as it is (lookup and the MCP tools check for TimeoutError); a refused or unknown host reads as one line
    const cause = e.cause as { code?: string; message?: string; errors?: { code?: string }[] } | undefined;
    const why = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message ?? e.message;
    throw e.name === 'TypeError' ? new Error(`could not reach ${base} (${why})`) : e;
  });
  const json = (await res.json()) as { error?: string };
  // the key was revoked, its person removed or its account deleted: ArcRoom stops on this machine until a new key
  if (res.status === 401 && json.error === 'invalid api key') stopForKey(cfg.apiKey);
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

// Off because the API refused this machine's key: hooks, the daemon and the tools do nothing until `arcroom init` saves a
// key that works. The file names the refused key's start, so a new key in config.json switches ArcRoom on again.
const STOPPED = join(ARCROOM_HOME, 'key-refused');
export function stopForKey(key: string): void {
  try {
    mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(STOPPED, key.slice(0, 8), { mode: 0o600 });
  } catch {
    // nothing to do: the next call is refused again and tries again
  }
}
/** True while the saved key is the one the API refused. */
export function keyRefused(cfg = loadConfig()): boolean {
  try {
    return readFileSync(STOPPED, 'utf8') === cfg.apiKey.slice(0, 8);
  } catch {
    return false;
  }
}
