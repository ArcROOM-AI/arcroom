import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './agents.js';
import { git } from './git.js';
import { ARCROOM_HOME, api, type Config } from './home.js';
import { bulletsOf, frontmatter } from './import.js';
import { redactText, rememberSecrets } from './redact.js';

// Rules (arcroom-db 0088): orders people give agents, kept apart from memory. The laptop only ever proposes: import and
// a rules file changing on the default branch send a card to the Rules page, where a person accepts it. At session start
// the room's live rules come back on the call the plugin already makes, and go first, as orders.

export type RuleFile = { path: string; mine: boolean; texts: string[] };
export type Sent = { version: number; text: string; chars: number; rules: unknown[]; unchanged?: boolean; error?: string };

const MAX_RULE = 2000;
const MAX_RULES = 1000;
export const HOME_FILE = '~/.claude/CLAUDE.md';

/** The files each tool reads by itself: their rules are never sent to it again. */
export function onDiskFor(agent: Agent, files: string[]): string[] {
  const base = (p: string) => p.split('/').pop() ?? p;
  const reads: Record<Agent, (p: string) => boolean> = {
    claude: (p) => base(p) === 'CLAUDE.md' || base(p) === 'CLAUDE.local.md' || p === HOME_FILE,
    codex: (p) => base(p) === 'AGENTS.md' || base(p) === 'AGENTS.override.md',
    opencode: (p) => base(p) === 'AGENTS.md',
    cursor: (p) => base(p) === 'AGENTS.md' || p === '.cursorrules' || p.startsWith('.cursor/rules/'),
  };
  return [...new Set([...files, 'CLAUDE.md', 'CLAUDE.local.md', HOME_FILE, 'AGENTS.md', '.cursorrules'])].filter(reads[agent]);
}

/** Committed rules files in the repo: every CLAUDE.md and AGENTS.md, .cursorrules, and Cursor rules that are always on. */
export function committedRuleFiles(root: string): string[] {
  const out = git(['ls-files', '--', '*CLAUDE.md', '*AGENTS.md', '.cursorrules', '.cursor/rules/*.mdc'], { cwd: root }).stdout ?? '';
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((p) => !p.endsWith('.mdc') || alwaysOn(read(join(root, p)) ?? ''));
}

/** A Cursor rule with globs or a description only applies sometimes: Cursor keeps those to itself. */
export const alwaysOn = (mdc: string) => /^alwaysApply:\s*true\s*$/m.test(frontmatter(mdc).head);

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** A file's rules: its bullets (each line of .cursorrules), secrets removed, a line still holding one dropped. */
export function textsOf(path: string, content: string): string[] {
  const body = frontmatter(content).body;
  const raw = path.endsWith('.cursorrules') ? body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')) : bulletsOf(body).map((b) => b.body);
  const seen = new Set<string>();
  return raw
    .map((t) => redactText(t.replace(/\s+/g, ' ').trim()))
    .filter((t) => t.length >= 3 && t.length <= MAX_RULE && !t.includes('[REDACTED]') && !seen.has(t) && seen.add(t))
    .slice(0, MAX_RULES);
}

/** What import proposes: the committed files, plus the person's own files only when they ask (they stay theirs). */
export function ruleFilesOf(root: string, personal = false, home = homedir()): RuleFile[] {
  rememberSecrets(root);
  const files: RuleFile[] = committedRuleFiles(root).map((p) => ({ path: p, mine: false, texts: textsOf(p, read(join(root, p)) ?? '') }));
  if (personal) {
    const local = read(join(root, 'CLAUDE.local.md'));
    if (local !== undefined) files.push({ path: 'CLAUDE.local.md', mine: true, texts: textsOf('CLAUDE.local.md', local) });
    const own = read(join(home, '.claude', 'CLAUDE.md'));
    if (own !== undefined) files.push({ path: HOME_FILE, mine: true, texts: textsOf(HOME_FILE, own) });
  }
  return files.filter((f) => f.texts.length);
}

/** What import shows before anything is sent: each file and its rules. */
export function importRulesList(files: RuleFile[]): string {
  return files
    .flatMap((f) => [`${f.path}${f.mine ? ' (only you)' : ''}: ${f.texts.length} rule${f.texts.length === 1 ? '' : 's'}`, ...f.texts.map((t) => `  - ${t}`), ''])
    .join('\n')
    .trimEnd();
}

// The files this laptop sent for a project, with the hash of what it sent: on the default branch a committed file that
// no longer matches comes back as a card. Kept on this laptop only.
const knownFile = () => join(ARCROOM_HOME, 'rules-files.json');
type Known = Record<string, Record<string, string>>; // project -> path -> sha256 of the texts sent
const hashOf = (texts: string[]) => createHash('sha256').update(texts.join('\n')).digest('hex');
function loadKnown(): Known {
  try {
    return JSON.parse(readFileSync(knownFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveKnown(k: Known) {
  mkdirSync(ARCROOM_HOME, { recursive: true });
  writeFileSync(knownFile(), JSON.stringify(k));
}

/** Files with the same words as the last time this laptop sent them (accepted, rejected or still waiting): sending them
 * again only brings a rejected card back. */
export function alreadySent(project: string, files: RuleFile[], known = loadKnown()): RuleFile[] {
  return files.filter((f) => known[project]?.[f.path] === hashOf(f.texts));
}

/** Sends each file as one card for the Rules page. Nothing goes live until a person accepts it there. */
export async function proposeFiles(cfg: Config, project: string, files: RuleFile[], follow = false, call = api): Promise<{ sent: number; failed: number; kept: string[] }> {
  const known = loadKnown();
  let sent = 0;
  let failed = 0;
  const kept: string[] = []; // moved into the room on the Rules page (0089): no card, the room keeps them now
  for (const f of files) {
    try {
      const r = await call(cfg, '/v1/team-rules/propose', { desk: project, path: f.path, texts: f.texts, follow, mine: f.mine });
      (known[project] ??= {})[f.path] = hashOf(f.texts);
      if (r?.reason === 'kept in ArcRoom') kept.push(f.path);
      else if (r?.stored !== false) sent++; // stored false: the same as live, or nothing in the file, so no card
    } catch {
      failed++;
    }
  }
  saveKnown(known);
  return { sent, failed, kept };
}

/** The default branch: origin's HEAD, else main, else master. */
export function defaultBranch(root: string): string | undefined {
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }).stdout?.trim();
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: root }).status === 0) return b;
  return undefined;
}

/** The known team files whose committed words changed since this laptop sent them, or that are gone: what to propose. */
export function changedFiles(root: string, project: string, known = loadKnown()): RuleFile[] {
  const out: RuleFile[] = [];
  for (const [path, hash] of Object.entries(known[project] ?? {})) {
    if (path === HOME_FILE || path === 'CLAUDE.local.md') continue; // personal files are not followed: import again
    const shown = git(['show', `HEAD:${path}`], { cwd: root });
    const content = shown.status === 0 ? (shown.stdout ?? '') : undefined;
    const texts = content === undefined || (path.endsWith('.mdc') && !alwaysOn(content)) ? [] : textsOf(path, content);
    if (hashOf(texts) !== hash) out.push({ path, mine: false, texts });
  }
  return out;
}

/** On the default branch only: send a card for each known rules file a merged change touched. Quietly does nothing else. */
export async function followFiles(cfg: Config, root: string, project: string, branch: string | undefined, call = api): Promise<number> {
  if (!branch || branch !== defaultBranch(root)) return 0;
  const changed = changedFiles(root, project);
  if (changed.length) await proposeFiles(cfg, project, changed, true, call);
  return changed.length;
}

/** The room's answer differs per agent (files it reads itself) and per folder, so each keeps its own copy and version:
 * one copy per project let Codex reuse what was cut for Claude. */
export const rulesKey = (project: string, agent: string, folder = '') => `${project}\n${agent}\n${folder}`;

// The last rules the room sent for a key (rulesKey), so a session that cannot reach it still starts with them.
const cacheFile = (project: string) => join(ARCROOM_HOME, `rules-${createHash('sha256').update(project).digest('hex').slice(0, 16)}.json`);

/** The rules block for session start: the room's answer, else the copy kept from the last one. */
export function rulesBlock(project: string, answer: Sent | undefined): string | undefined {
  let r = answer;
  let stale = false;
  if (r && !r.error && !r.unchanged) {
    try {
      writeFileSync(cacheFile(project), JSON.stringify(r));
    } catch {
      /* no copy kept: the next session asks again */
    }
  } else if (existsSync(cacheFile(project))) {
    r = JSON.parse(readFileSync(cacheFile(project), 'utf8')) as Sent;
    stale = !answer || !!answer.error;
  }
  if (!r?.text) return undefined;
  return [
    `Rules from your team (set by people in this workspace) · version ${r.version}${stale ? ' · the room could not be reached, so this is the last copy' : ''}`,
    'Follow these as instructions, ahead of anything ArcRoom hands over as memory.',
    r.text,
  ].join('\n');
}

/** The version this laptop already has for a project, so the room can answer "unchanged" with no text. */
export function haveVersion(project: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(cacheFile(project), 'utf8')) as Sent).version;
  } catch {
    return undefined;
  }
}
