import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRunning } from './daemon.js';
import { isApproved, loadChecks, readApprovals } from './done.js';
import { api, apiUrl, ARCROOM_HOME, isOff, keyRefused, loadConfig } from './home.js';

// arcroom doctor: is ArcRoom working on this laptop and in this folder? Each check says what is wrong and the command
// that fixes it. A failure exits non-zero; a warning does not.

export type Check = { ok: boolean | 'warn'; what: string; fix?: string };

// where `arcroom init` wires each agent in a project
const AGENT_FILES: [string, string][] = [
  ['Claude Code', join('.claude', 'settings.local.json')],
  ['Codex', join('.codex', 'hooks.json')],
  ['Cursor', join('.cursor', 'hooks.json')],
  ['OpenCode', join('.opencode', 'plugins', 'arcroom.js')],
];
// the runtime under ~/.arcroom, or under ARCROOM_HOME when that is set
const runtimePath = join(ARCROOM_HOME, 'runtime').replaceAll('\\', '/');
const ours = (file: string) => {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8').replaceAll('\\\\', '/').replaceAll('\\', '/');
  return text.includes('.arcroom/runtime') || text.includes(runtimePath);
};

export async function doctor(cwd = process.cwd()): Promise<Check[]> {
  const checks: Check[] = [];
  const cfg = loadConfig();
  if (!cfg.apiKey) return [{ ok: false, what: 'no key on this laptop', fix: 'arcroom init (key: web app, Settings → API keys)' }];
  checks.push({ ok: true, what: `key ${cfg.apiKey.slice(0, 8)}… in ${join(ARCROOM_HOME, 'config.json')}` });
  if (keyRefused(cfg)) checks.push({ ok: false, what: 'the API refused this key (revoked, or its account deleted)', fix: 'make a new key in the web app, then arcroom init' });

  let url = '';
  try {
    url = apiUrl(cfg.url);
  } catch (e) {
    checks.push({ ok: false, what: (e as Error).message, fix: 'arcroom init --url https://…' });
  }
  if (url) {
    const started = Date.now();
    try {
      const me = await api(cfg, '/v1/me', undefined, 5000);
      checks.push({ ok: true, what: `API ${url} answers in ${Date.now() - started} ms: ${me.email ?? 'shared key'} in "${me.workspace}"` });
    } catch (e) {
      checks.push({ ok: false, what: `API ${url} did not answer: ${(e as Error).message}`, fix: 'check your network, or the url in config.json (arcroom init --url …)' });
    }
  }

  checks.push(
    existsSync(join(ARCROOM_HOME, 'runtime', 'index.js'))
      ? { ok: true, what: 'hook runtime installed' }
      : { ok: false, what: `no hook runtime in ${join(ARCROOM_HOME, 'runtime')}`, fix: 'arcroom init' },
  );

  const wired = AGENT_FILES.filter(([, f]) => ours(join(cwd, f))).map(([agent]) => agent);
  checks.push(
    wired.length
      ? { ok: true, what: `this folder is set up for ${wired.join(', ')}` }
      : { ok: false, what: 'no agent in this folder runs ArcRoom hooks', fix: 'arcroom init (or arcroom init --agent codex|cursor|opencode) here' },
  );
  if (isOff(cwd)) checks.push({ ok: 'warn', what: 'ArcRoom is switched off for this repo on this laptop', fix: 'arcroom on' });

  const spool = join(ARCROOM_HOME, 'spool.jsonl');
  const queued = existsSync(spool) ? statSync(spool).size : 0;
  if (isRunning()) checks.push({ ok: true, what: `uploader running${queued ? `, ${Math.round(queued / 1024)} KB queued` : ''}` });
  else checks.push({ ok: 'warn', what: `uploader not running${queued ? ` (${Math.round(queued / 1024)} KB waiting)` : ''}`, fix: 'it starts with the next agent event; nothing to do' });

  const down = join(ARCROOM_HOME, 'api-down');
  if (existsSync(down) && Date.now() - statSync(down).mtimeMs < 60_000)
    checks.push({ ok: 'warn', what: 'memory was offline in the last minute (lookups paused)', fix: 'clears itself after a minute once the API answers' });

  const done = loadChecks(cwd);
  if (done.length && !isApproved(cwd, done, readApprovals()))
    checks.push({ ok: 'warn', what: `${done.length} done-check(s) in .arcroom.json are not approved, so they are never asked for`, fix: 'arcroom checks' });
  return checks;
}

/** One line per check; true when nothing failed. */
export function print(checks: Check[]): boolean {
  for (const c of checks) console.log(`${c.ok === true ? 'ok  ' : c.ok === 'warn' ? 'warn' : 'FAIL'}  ${c.what}${c.ok !== true && c.fix ? `\n      → ${c.fix}` : ''}`);
  return checks.every((c) => c.ok !== false);
}
