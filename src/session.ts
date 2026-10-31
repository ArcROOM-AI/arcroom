import { projectOf } from './git.js';
export { projectOf };
import { api, loadConfig } from './home.js';


const ago = (from: string, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

/** A path from that run as a path in this repo: under this checkout it loses the root; another laptop's absolute path
 *  keeps its last three parts, enough to find the file without that laptop's folders. */
const repoPath = (p: string, root?: string) => {
  const n = String(p).replaceAll('\\', '/');
  const r = root?.replaceAll('\\', '/').replace(/\/$/, '');
  if (r && n.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return n.slice(r.length + 1);
  return /^([a-z]:)?\//i.test(n) ? n.split('/').slice(-3).join('/') : n;
};

/** The note a new session starts with: what the last run in this project asked, did, and left open. */
export function lastRunContext(run: any, now = new Date(), root?: string): string {
  const r = run.report ?? {};
  // a run that never closed has no report yet: the API sends the files it edited instead
  const paths: string[] = r.files ? r.files.filter((f: any) => f.edited).map((f: any) => f.path) : Array.isArray(run.edited) ? run.edited : [];
  const edited = [...new Set(paths.filter(Boolean).map((p) => repoPath(p, root)))];
  const memory = r.memory ?? {};
  const first = String(r.first_prompt ?? run.prompt ?? '');
  const last = String(run.last_prompt ?? '');
  const whose = run.mine === true ? 'your last session' : run.mine === false ? "a teammate's last session" : 'the last session';
  const ended =
    run.status === 'running'
      ? 'never closed (it stopped mid-way): treat its work as unfinished'
      : `ended ${run.status === 'partial' ? 'PARTIAL: its done-checks were still failing' : run.status}`;
  const lines = [
    `ArcRoom: ${whose} in this project (${ago(run.started_at, now)}, on ${run.machine ?? 'another machine'}${run.branch ? `, branch ${run.branch}` : ''}) ${ended}.`,
    `Asked: "${first.slice(0, 200)}"`,
    last && last !== first ? `Last asked: "${last.slice(0, 200)}"` : '',
    run.failing_check ? `Still failing: \`${String(run.failing_check).slice(0, 200)}\`` : '',
    edited.length ? `Edited: ${edited.slice(0, 10).join(', ')}${edited.length > 10 ? ` (+${edited.length - 10} more)` : ''}` : '',
    `${r.tool_calls ?? 0} tool calls` +
      (r.blocked ? `, ${r.blocked} blocked by the loop guard` : '') +
      (memory.find ? `, memory: ${memory.find} lookups, ${memory.complete ?? 0} stored` : ''),
    'Use this to pick up where it left off if the user continues that work; ignore it otherwise.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Fetches the last run of this project (skipping the current session); undefined when there is none or the API is slow. */
export async function lastRunNote(session: string, project: string, branch?: string, root?: string): Promise<string | undefined> {
  const cfg = loadConfig(root);
  if (!cfg.apiKey) return undefined;
  const qs = new URLSearchParams({ project, exclude: session, ...(branch && branch !== 'HEAD' ? { branch } : {}) });
  const run = await api(cfg, `/v1/runs/last?${qs}`, undefined, 1500); // never hold up session start for long
  return run ? lastRunContext(run, new Date(), root) : undefined;
}
