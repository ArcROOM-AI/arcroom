import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { hashFiles } from './fresh.js';
import { projectOf } from './git.js';
import { api, type Config } from './home.js';
import { redactText, rememberSecrets } from './redact.js';
import { logSent } from './sent.js';

// `arcroom import`: once per repo, run by a person, never by a hook. It READS the rules people already wrote for their
// agents and saves each as a team fact, after showing the whole list and getting a yes. It never writes these files.
// By default it reads only what teammates' agents do not load already:
//   CLAUDE.local.md, this repo's Claude Code memory notes, .cursor/rules/*.mdc, .cursorrules
// --all adds the committed CLAUDE.md, .claude/CLAUDE.md and AGENTS.md (Claude Code and Codex load those every session).

export type Source = { path: string; label: string; type: 'bullets' | 'note' | 'lines' };
export type Item = { text: string; why?: string; files: string[]; source: string };

const MAX_FILE = 200_000;
const MAX_TEXT = 500;
const MAX_FILES = 20;

/** Claude Code keeps a project's memory notes under ~/.claude/projects/<the path with every other character as "-">. */
export const notesDir = (root: string, home = homedir()) => join(home, '.claude', 'projects', resolve(root).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

/** The files import reads in this repo, in the order shown. */
export function sourcesOf(root: string, all = false, home = homedir()): Source[] {
  const out: Source[] = [];
  const add = (path: string, label: string, type: Source['type']) => {
    try {
      // a real file inside its folder: no symlink out of the repo, nothing huge
      if (!lstatSync(path).isSymbolicLink() && statSync(path).isFile() && statSync(path).size <= MAX_FILE) out.push({ path, label, type });
    } catch {
      /* not there */
    }
  };
  if (all) for (const f of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'AGENTS.md']) add(join(root, f), f.replaceAll('\\', '/'), 'bullets');
  add(join(root, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'bullets');
  const notes = notesDir(root, home);
  if (existsSync(notes)) for (const f of readdirSync(notes).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort()) add(join(notes, f), `memory note ${f.replace(/\.md$/, '')}`, 'note');
  const rules = join(root, '.cursor', 'rules');
  if (existsSync(rules)) for (const f of readdirSync(rules).filter((f) => f.endsWith('.mdc')).sort()) add(join(rules, f), `.cursor/rules/${f}`, 'bullets');
  add(join(root, '.cursorrules'), '.cursorrules', 'lines');
  return out;
}

/** Top-level bullets with their indented lines; code, tables, headings, paragraphs and tool-written blocks are skipped. */
export function bulletsOf(text: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  let cur: { line: number; body: string } | undefined;
  let fence = false;
  let generated = false;
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) (fence = !fence), (cur = undefined);
    else if (/<!--\s*BEGIN/i.test(l)) (generated = true), (cur = undefined);
    else if (/<!--\s*END/i.test(l)) generated = false;
    else if (fence || generated) cur = undefined;
    else if (/^([-*+]|\d+[.)])\s+\S/.test(l)) out.push((cur = { line: i + 1, body: l.replace(/^([-*+]|\d+[.)])\s+/, '').trim() }));
    else if (cur && /^\s+\S/.test(l) && !/^\s+([-*+]|\d+[.)])\s/.test(l)) cur.body += ` ${l.trim()}`;
    else cur = undefined;
  });
  return out;
}

const frontmatter = (text: string) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { head: m[1], body: m[2] } : { head: '', body: text };
};

/** Whole text when it fits; a longer one keeps the sentences that fit, the rest becomes the why. */
const fit = (body: string, why?: string): { text: string; why?: string } => {
  if (body.length <= MAX_TEXT) return { text: body, ...(why ? { why: why.slice(0, MAX_TEXT) } : {}) };
  let text = '';
  for (const s of body.split(/(?<=[.!?])\s+/)) if ((text ? `${text} ${s}` : s).length <= MAX_TEXT) text = text ? `${text} ${s}` : s;
  else break;
  if (!text) text = `${body.slice(0, MAX_TEXT - 1)}…`;
  const rest = [body.slice(text.length).trim(), why].filter(Boolean).join(' ');
  return { text, ...(rest ? { why: rest.slice(0, MAX_TEXT) } : {}) };
};

/** Repo files an item names (they exist here), so the fact reaches the requests about them. */
const filesNamed = (body: string, root: string) =>
  [...new Set((body.match(/[\w@.\-/]*\w\.[a-z0-9]{1,6}\b|[\w@.\-]+\/[\w@.\-/]*\w/gi) ?? []).map((p) => p.replace(/^\.\//, '')))]
    .filter((p) => {
      const rel = relative(root, resolve(root, p));
      return !rel.startsWith('..') && existsSync(join(root, rel));
    })
    .slice(0, MAX_FILES);

/** Every item import would save from this repo: secrets stripped (an item still holding one is dropped), no repeats. */
export function itemsOf(root: string, all = false, home = homedir()): Item[] {
  rememberSecrets(root); // this repo's .env values are redacted too
  const seen = new Set<string>();
  const out: Item[] = [];
  const push = (raw: string, source: string, why?: string) => {
    const body = redactText(raw.replace(/\s+/g, ' ').trim());
    const w = why ? redactText(why.replace(/\s+/g, ' ').trim()) : undefined;
    if (body.length < 3 || body.includes('[REDACTED]') || w?.includes('[REDACTED]')) return;
    const key = body.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...fit(body, w), files: filesNamed(body, root), source });
  };
  for (const s of sourcesOf(root, all, home)) {
    const text = readFileSync(s.path, 'utf8');
    if (s.type === 'note') {
      // a memory note: its description says the thing; its "Why:" line, when there is one, says why
      const { head, body } = frontmatter(text);
      const description = head.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '');
      const why = body.match(/\*\*Why:\*\*\s*(.+)/)?.[1];
      if (description) push(description, s.label, why);
    } else if (s.type === 'lines') {
      text.split(/\r?\n/).forEach((l, i) => l.trim() && !/^#/.test(l.trim()) && push(l, `${s.label}:${i + 1}`));
    } else {
      // line numbers point at the file itself, past any frontmatter (.mdc rules have one)
      const { body } = frontmatter(text);
      const skip = text.slice(0, text.length - body.length).split(/\r?\n/).length - 1;
      for (const b of bulletsOf(body)) push(b.body, `${s.label}:${b.line + skip}`);
    }
  }
  return out;
}

/** The numbered list shown before anything is sent. */
export function importList(items: Item[], sources: Source[]): string {
  if (!items.length) return 'Nothing to import: no rules found in this repo (CLAUDE.local.md, memory notes, Cursor rules; --all adds CLAUDE.md and AGENTS.md).';
  const width = String(items.length).length;
  return [
    `From ${sources.map((s) => s.label).join(', ')}: ${items.length} item${items.length > 1 ? 's' : ''}`,
    '',
    ...items.flatMap((it, i) => [
      `${String(i + 1).padStart(width)}. ${it.text}`,
      ...(it.why ? [`${' '.repeat(width + 2)}why: ${it.why}`] : []),
      `${' '.repeat(width + 2)}(${it.source}${it.files.length ? `; files: ${it.files.join(', ')}` : ''})`,
    ]),
  ].join('\n');
}

/** "y" → all; "skip 3,5" → all but those; anything else → none. */
export function chosen(answer: string, count: number): number[] {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return Array.from({ length: count }, (_, i) => i);
  const skip = a.match(/^skip\s+([\d,\s]+)$/);
  if (!skip) return [];
  const drop = new Set(skip[1].split(/[,\s]+/).filter(Boolean).map((n) => Number(n) - 1));
  return Array.from({ length: count }, (_, i) => i).filter((i) => !drop.has(i));
}

/** Sends the chosen items through remember, one at a time; each is logged in `arcroom sent`. */
export async function sendItems(cfg: Config, root: string, items: Item[], call = api): Promise<{ saved: number; already: number; failed: number }> {
  const project = projectOf(root);
  let saved = 0;
  let already = 0;
  let failed = 0;
  for (const it of items) {
    const hashes = hashFiles(root, it.files);
    const body = { kind: 'fact', text: it.text, ...(it.why ? { why: it.why } : {}), files: it.files, project, ...(Object.keys(hashes).length ? { hashes } : {}) };
    try {
      const r = await call(cfg, '/v1/memory/remember', body);
      if (r?.saved) saved++;
      else already++;
      logSent([{ v: 1, at: new Date().toISOString(), cwd: root, type: 'import', data: { ...body, source: it.source } }]);
    } catch {
      failed++;
    }
  }
  return { saved, already, failed };
}
