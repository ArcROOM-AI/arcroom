import { git } from './git.js';
import { api, loadConfig } from './home.js';

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

const ago = (from: string, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

/** The note a new session starts with: what the last run in this project asked, did, and left open. */
export function lastRunContext(run: any, now = new Date()): string {
  const r = run.report ?? {};
  const edited: string[] = (r.files ?? []).filter((f: any) => f.edited).map((f: any) => f.path.split(/[\\/]/).pop());
  const memory = r.memory ?? {};
  const lines = [
    `ArcRoom: the last session in this project (${ago(run.started_at, now)}, on ${run.machine ?? 'another machine'}) ` +
      `ended ${run.status === 'partial' ? 'PARTIAL: its done-checks were still failing' : run.status}.`,
    `Asked: "${String(r.first_prompt ?? run.prompt ?? '').slice(0, 200)}"`,
    edited.length ? `Edited: ${edited.slice(0, 10).join(', ')}${edited.length > 10 ? ` (+${edited.length - 10} more)` : ''}` : '',
    `${r.tool_calls ?? 0} tool calls` +
      (r.blocked ? `, ${r.blocked} blocked by the loop guard` : '') +
      (memory.find ? `, memory: ${memory.find} lookups, ${memory.complete ?? 0} stored` : ''),
    'Use this to pick up where it left off if the user continues that work; ignore it otherwise.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Fetches the last run of this project (skipping the current session); undefined when there is none or the API is slow. */
export async function lastRunNote(session: string, project: string): Promise<string | undefined> {
  const cfg = loadConfig();
  if (!cfg.apiKey) return undefined;
  const qs = new URLSearchParams({ project, exclude: session });
  const run = await api(cfg, `/v1/runs/last?${qs}`, undefined, 1500); // never hold up session start for long
  return run ? lastRunContext(run) : undefined;
}
