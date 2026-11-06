import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Agent } from './agents.js';
import { RULES_HIDDEN } from './flags.js';
import { projectOf } from './git.js';
export { projectOf };
import { api, loadConfig } from './home.js';
import { sessionFile } from './loop.js';
import { committedRuleFiles, followFiles, haveVersion, onDiskFor, rulesBlock, rulesKey } from './rules.js';
import { readSetup } from './tree.js';

const folderOf = (root: string, cwd?: string) => (cwd ? relative(root, cwd).replaceAll('\\', '/') : '');

/** The rules part of the session-start call: none while rules are hidden or outside a repo. */
export function rulesQuery(project: string, agent: Agent, root?: string, cwd?: string): Record<string, string> {
  if (!root) return {};
  const folder = folderOf(root, cwd);
  const have = haveVersion(rulesKey(project, agent, folder));
  return {
    rules: '1',
    mine: '1',
    on_disk: onDiskFor(agent, committedRuleFiles(root)).join(','),
    folder,
    ...(have !== undefined ? { have: String(have) } : {}),
  };
}

// This session's own story, kept on the laptop so a compaction can hand it back: its first and latest ask and the
// files it edited. Claude Code's summary may drop them; nothing else keeps them per session (.done resets every turn).
const MAX_ASK = 300;
const MAX_FILES = 20;
type Story = { first?: string; last?: string; files?: string[] };
const readStory = (session: string): Story => {
  try {
    return JSON.parse(readFileSync(sessionFile(session, '.story'), 'utf8'));
  } catch {
    return {};
  }
};

/** Adds a prompt, or files the agent is about to edit, to this session's story. */
export function noteStory(session: string, add: { ask?: string; files?: string[] }, root?: string): void {
  const s = readStory(session);
  const ask = add.ask?.trim().slice(0, MAX_ASK);
  if (ask) {
    s.first ??= ask;
    s.last = ask;
  }
  for (const f of add.files ?? []) {
    const p = repoPath(f, root);
    s.files = [...(s.files ?? []).filter((x) => x !== p), p].slice(-MAX_FILES); // newest last
  }
  if (ask || add.files?.length) writeFileSync(sessionFile(session, '.story'), JSON.stringify(s));
}

/** The note handed back after a compaction (at most 5 lines), or undefined when the session noted nothing yet. */
export function storyNote(s: Story): string | undefined {
  if (!s.first && !s.files?.length) return undefined;
  const files = s.files ?? [];
  return [
    'ArcRoom: this session so far (handed back after compaction):',
    s.first ? `First ask: "${s.first}"` : '',
    s.last && s.last !== s.first ? `Latest ask: "${s.last}"` : '',
    files.length ? `Files edited: ${files.slice(-8).join(', ')}${files.length > 8 ? ` (+${files.length - 8} more)` : ''}` : '',
    'The team facts and code map you were given come back with your next prompt.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** On a compaction start: forget what was handed so far (so facts and the full code map come again) and return the note. */
export function compactReset(session: string): string | undefined {
  for (const suffix of ['.recalled', '.codelook']) rmSync(sessionFile(session, suffix), { force: true });
  return storyNote(readStory(session));
}


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
  // a session that was opened and closed with nothing asked and nothing edited has nothing to hand over
  if (!first.trim() && !last.trim() && !edited.length) return '';
  const whose = run.mine === true ? 'your last session' : run.mine === false ? "a teammate's last session" : 'the last session';
  const ended =
    run.status === 'running'
      ? 'never closed (it stopped mid-way): treat its work as unfinished'
      : `ended ${run.status === 'partial' ? 'PARTIAL: its done-checks were still failing' : run.status}`;
  const lines = [
    `ArcRoom: ${whose} in this project (${ago(run.started_at, now)}, on ${run.machine ?? 'another machine'}${run.branch ? `, branch ${run.branch}` : ''}) ${ended}.`,
    // the whole ask as captured (at most 1,000 characters): a cut ask loses its last steps, the ones left to do
    `Asked: "${first.slice(0, 1000)}"`,
    last && last !== first ? `Last asked: "${last.slice(0, 1000)}"` : '',
    run.failing_check ? `Still failing: \`${String(run.failing_check).slice(0, 200)}\`` : '',
    edited.length ? `Edited: ${edited.slice(0, 10).join(', ')}${edited.length > 10 ? ` (+${edited.length - 10} more)` : ''}` : '',
    // a run that never closed has no report: no count rather than a wrong "0 tool calls"
    r.tool_calls == null
      ? ''
      : `${r.tool_calls} tool calls` +
        (r.blocked ? `, ${r.blocked} blocked by the loop guard` : '') +
        (memory.find ? `, memory: ${memory.find} lookups, ${memory.complete ?? 0} stored` : ''),
    'Use this to pick up where it left off if the user continues that work; ignore it otherwise.',
  ];
  return lines.filter(Boolean).join('\n');
}

// "Open now from teammates": other people's sessions open on this repo and the tasks they claimed but did not finish
// (GET /v1/runs/open, arcroom-db 0070). At most 5 + 3 lines; nothing open = no block at all.
export type OpenNow = { open?: any[]; unfinished?: any[] };
const MAX_OPEN = 5;
const MAX_UNFINISHED = 3;
const agoMin = (m: number) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`);
/** Who a teammate is: the name they signed up with, else their machine (never an email). */
const who = (r: any) => r?.name || r?.machine || 'a teammate';
const STATE: Record<string, string> = { working: 'working', your_turn: 'waiting for its person', needs_you: 'waiting for a permission' };

/** The open-now block, leaving out the run the last-run note already shows; undefined when nothing is open. */
export function openNowContext(o: OpenNow | undefined, skipRun?: string, branch?: string): string | undefined {
  const open = (o?.open ?? []).filter((r) => r.run_id !== skipRun).slice(0, MAX_OPEN);
  const unfinished = (o?.unfinished ?? []).slice(0, MAX_UNFINISHED);
  if (!open.length && !unfinished.length) return undefined;
  const where = (r: any) => (r.branch && branch && r.branch !== branch ? ` (branch ${r.branch})` : '');
  return [
    'ArcRoom: open now from teammates on this repo (their sessions as of this session start):',
    ...open.map(
      (r) => `- ${who(r)} · "${r.ask}"${r.files?.length ? ` · ${r.files.join(', ')}` : ''} · ${STATE[r.state] ?? r.state}, ${agoMin(r.minutes)}${where(r)}`,
    ),
    ...(unfinished.length ? ['Unfinished work they claimed:'] : []),
    ...unfinished.map(
      (u) => `- "${u.task}" · ${who(u)} · ${u.state === 'in_progress' ? 'in progress' : 'claim lapsed, safe to take'} (claimed ${agoMin(u.minutes)})`,
    ),
  ].join('\n');
}

// The clash check: on the first prompt, does the ask match work a teammate has open here (from the list kept at session
// start, so no API call)? Same file: a file the ask names is one they are editing (by its path ending). Same task: at
// least 2 meaningful words in common, covering 60% or more of the shorter ask.
// ponytail: a word-overlap rule, tuned on the two-person test day (T26); meaning-based matching if this misses too much
const STOP = new Set(
  'the and for with this that from into now then please can you our all fix add make also too just some new use get set run let any are was were has have had not but its out see why how what when where which who will would should could there here them they their your'.split(' '),
);
const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const filesOf = (s: string) => (s.match(/[\w@.\-/\\]*\w\.[a-z0-9]{1,5}\b/gi) ?? []).map((f) => f.replaceAll('\\', '/').toLowerCase());

export function sameTask(a: string, b: string): boolean {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.6;
}
const sameFile = (asked: string[], theirs: string[] = []) =>
  theirs.find((f) => asked.some((a) => a === f.toLowerCase() || a.endsWith(`/${f.toLowerCase()}`) || f.toLowerCase().endsWith(`/${a}`)));

/** One line when the ask overlaps a teammate's open session or claimed task; undefined when it does not. */
export function clashLine(prompt: string, o?: OpenNow): string | undefined {
  const asked = filesOf(prompt);
  for (const r of o?.open ?? []) {
    const file = sameFile(asked, r.files);
    if (file || sameTask(prompt, r.ask ?? ''))
      return `ArcRoom: ${r.name || `a teammate on ${r.machine ?? 'another machine'}`} is already on this: "${r.ask}"${file ? ` (editing ${file})` : ''}, ${STATE[r.state] ?? r.state} ${agoMin(r.minutes)}. Check with them before you start.`;
  }
  for (const u of o?.unfinished ?? []) {
    if (!sameTask(prompt, u.task ?? '')) continue;
    return u.state === 'in_progress'
      ? `ArcRoom: ${u.name || `a teammate on ${u.machine ?? 'another machine'}`} claimed this ${agoMin(u.minutes)} and is still on it: "${u.task}". Check with them before you start.`
      : `ArcRoom: "${u.task}" was claimed by ${who(u)} ${agoMin(u.minutes)} and left unfinished (the claim lapsed): you may take it over.`;
  }
  return undefined;
}

/** The open list kept at session start, read once: only the first prompt is checked for a clash. */
export function takeOpen(session: string): OpenNow | undefined {
  const f = sessionFile(session, '.open');
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  } finally {
    rmSync(f, { force: true });
  }
}

/**
 * What a session starts with from the API: the last run here (skipping this session) and teammates' open work, asked
 * side by side so both fit the 1.5 s session start allows. A slow or offline API leaves that part out, never the start.
 * The open list is also kept for this session (.open), so the first prompt can say "a teammate is already on this".
 */
export async function startNotes(
  session: string,
  project: string,
  branch?: string,
  root?: string,
  agent: Agent = 'claude',
  cwd?: string,
): Promise<{ lastRun?: string; open?: string; rules?: string; teammates: number }> {
  const cfg = loadConfig(root);
  if (!cfg.apiKey) return { teammates: 0 };
  const qs = new URLSearchParams({ project, exclude: session, ...(branch && branch !== 'HEAD' ? { branch } : {}) });
  // `arcroom open off` (the repo's committed .arcroom.json, so the whole team gets it): no open-now list, no clash line
  const openOff = !!root && readSetup(root).open === 'off';
  // rules (0088) ride on the open-now call; the files this tool reads itself are named, so their rules are not sent again
  const rulesAt = !RULES_HIDDEN && root ? root : undefined;
  const [run, answer] = await Promise.all([
    api(cfg, `/v1/runs/last?${qs}`, undefined, 1500).catch(() => undefined),
    openOff && !rulesAt ? undefined : api(cfg, `/v1/runs/open?${new URLSearchParams({ project, ...rulesQuery(project, agent, rulesAt, cwd) })}`, undefined, 1500).catch(() => undefined),
    rulesAt ? followFiles(cfg, rulesAt, project, branch).catch(() => 0) : undefined,
  ]);
  const now: OpenNow | undefined = openOff ? undefined : rulesAt ? answer?.open : answer;
  const rules = rulesAt ? rulesBlock(rulesKey(project, agent, folderOf(rulesAt, cwd)), answer?.rules) : undefined;
  if (now) writeFileSync(sessionFile(session, '.open'), JSON.stringify(now));
  const open = openNowContext(now, run?.id, branch);
  return {
    lastRun: (run && lastRunContext(run, new Date(), root)) || undefined,
    open,
    rules,
    teammates: new Set((now?.open ?? []).map((r) => r.run_id)).size,
  };
}
