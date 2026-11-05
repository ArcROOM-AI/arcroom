import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCROOM_HOME } from './home.js';
import type { Cut } from './pack.js';
import { prune } from './sent.js';

// What came IN: every hand-over ArcRoom gave an agent (at session start and before each prompt), and what it found but
// cut for room. `arcroom sent` shows what left the laptop; `arcroom handed` reads this. Titles and sizes only, never the
// text handed over; one file per day under ~/.arcroom/handed, readable only by you, kept 7 days like sent.
export const HANDED_DIR = join(ARCROOM_HOME, 'handed');

export type Item = { kind: string; title?: string; chars: number };
export type Handover = { at: string; session: string; cwd?: string; when: 'start' | 'compact' | 'prompt'; handed: Item[]; cut: Cut[] };

const clip = (s?: string) => (s && s.length > 120 ? `${s.slice(0, 119)}…` : s);

export function logHanded(h: Omit<Handover, 'at'>, now = new Date()): void {
  if (!h.handed.length && !h.cut.length) return;
  const entry: Handover = {
    at: now.toISOString(),
    ...h,
    handed: h.handed.map((i) => ({ ...i, title: clip(i.title) })),
    cut: h.cut.map((c) => ({ ...c, title: clip(c.title) })),
  };
  mkdirSync(HANDED_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(join(HANDED_DIR, `${entry.at.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
  prune(now, HANDED_DIR);
}

const WHEN = { start: 'at session start', compact: 'after a compaction', prompt: 'before a prompt' } as const;
const row = (i: { kind: string; title?: string; chars: number }, why = '') =>
  `  ${i.kind.padEnd(10)} ${String(i.chars).padStart(5)} chars  ${i.title ?? ''}${why ? ` · ${why}` : ''}`;

/** `arcroom handed [--last N]`: the latest hand-overs (newest first), what each gave the agent and what it cut. */
export function handedReport(args: string[], dir = HANDED_DIR): string {
  const n = Math.min(Math.max(Number(args[args.indexOf('--last') + 1]) || 1, 1), 20);
  const days = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse() : [];
  const entries: Handover[] = [];
  for (const d of days) {
    const lines = readFileSync(join(dir, d), 'utf8').split('\n').filter(Boolean).reverse();
    for (const l of lines) {
      try {
        entries.push(JSON.parse(l));
      } catch {} // a half-written line from a crash is skipped
      if (entries.length >= n) break;
    }
    if (entries.length >= n) break;
  }
  if (!entries.length) return `Nothing was handed over yet. Hand-overs are kept 7 days in ${dir}.`;
  const one = (h: Handover) => {
    const total = h.handed.reduce((s, i) => s + i.chars, 0);
    return [
      `${h.at.slice(0, 16).replace('T', ' ')} UTC · ${WHEN[h.when] ?? h.when}${h.cwd ? ` · ${h.cwd}` : ''}`,
      h.handed.length ? `Handed over (${h.handed.length}, ${total} chars):` : 'Handed over: nothing',
      ...h.handed.map((i) => row(i)),
      ...(h.cut.length ? [`Left out (${h.cut.length}):`, ...h.cut.map((c) => row(c, c.reason))] : []),
    ].join('\n');
  };
  return [...entries.map(one), `What left this laptop: arcroom sent · hand-overs are kept 7 days in ${dir}`].join('\n\n');
}
