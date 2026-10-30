import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sessionFile } from './loop.js';

// What the user sees of ArcRoom: one short line per action (hook systemMessage) and a live status line.

// Plain name, no glyph: hooks and the status line are text only, and a text-drawn logo did not read as the logo.
export const MARK = 'ArcRoom';
export type Stats = { reused: number; replayed: number; saved: number; blocked: number; evicted: number; tokens_saved: number };
const EMPTY: Stats = { reused: 0, replayed: 0, saved: 0, blocked: 0, evicted: 0, tokens_saved: 0 };
const COUNTS = ['reused', 'replayed', 'saved', 'blocked', 'evicted'] as const;
/** 48213 -> "48.2k" */
export const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const short = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The JSON an ArcRoom MCP tool returned, from Claude Code's tool_response (content blocks or text); an error string otherwise. */
export function toolResult(response: unknown): any {
  const texts: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') typeof v.text === 'string' ? texts.push(v.text) : walk(v.content);
  };
  walk(response);
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch {
      if (t.startsWith('ArcRoom error')) return { error: t.replace(/^ArcRoom error:\s*/, '') };
    }
  }
  return undefined;
}

/** The line to show after an ArcRoom tool call, and which counter it bumps. */
export function signFor(tool: string, input: any, r: any): { message: string; stat?: keyof Stats } | undefined {
  if (!r) return undefined;
  if (r.error) return { message: `${MARK} · ${short(r.error, 90)}` };
  const intent = short(r.intent ?? input?.intent);
  switch (tool) {
    case 'find_task': {
      const changed = r.evicted_stale?.length ? `file changed (${r.evicted_stale.join(', ')}), old answer dropped · ` : '';
      if (r.match === 'reuse')
        return { message: `${MARK} · ${changed}reused a team answer${r.version?.verified ? ' (verified)' : ''}: ${intent}`, stat: 'reused' };
      if (r.match === 'replay') return { message: `${MARK} · ${changed}replaying stored steps: ${intent}`, stat: 'replayed' };
      if (r.match === 'in_flight') return { message: `${MARK} · a teammate is on it (${r.claimed_by ?? 'another session'}): ${intent}` };
      if (r.broken_procedure) return { message: `${MARK} · ${changed}stored steps broke last time, re-planning: ${intent}` };
      if (r.candidates?.length) return { message: `${MARK} · ${changed}no exact match, ${r.candidates.length} similar to check` };
      return { message: `${MARK} · ${changed}new task, nothing stored yet: ${intent}` };
    }
    case 'split_task': {
      const c = r.counts ?? {};
      const done = [c.reuse && `${c.reuse} already done`, c.replay && `${c.replay} to replay`, c.in_flight && `${c.in_flight} in progress elsewhere`, c.none && `${c.none} new`];
      return { message: `${MARK} · split into ${r.parts?.length ?? 0} parts: ${done.filter(Boolean).join(', ')}` };
    }
    case 'claim_task':
      return { message: r.claimed ? `${MARK} · claimed: ${intent}` : `${MARK} · already taken by ${r.claimed_by ?? 'someone else'}` };
    case 'complete_task':
      return { message: `${MARK} · saved to team memory (v${r.version})`, stat: 'saved' };
    case 'evict_task':
      return { message: `${MARK} · threw away ${r.evicted} answer(s)${r.cascaded ? ` + ${r.cascaded} built on them` : ''}`, stat: 'evicted' };
    case 'fail_task':
      return { message: `${MARK} · marked the stored steps broken (v${r.procedure_version})` };
    case 'rollback_task':
      return { message: `${MARK} · back to stored steps v${r.procedure_version}` };
    case 'pin_task':
      return { message: `${MARK} · pinned v${r.version} for ${r.for}` };
    case 'unpin_task':
      return { message: `${MARK} · ${r.unpinned ? 'unpinned' : 'nothing was pinned'}` };
  }
  return undefined;
}

/** The status line: ArcRoom is live, the tokens this session used and saved, then what it did. */
export function statusText(s: Stats, used = 0): string {
  const tokens = [used && `${compact(used)} tokens used`, s.tokens_saved && `${compact(s.tokens_saved)} saved`].filter(Boolean) as string[];
  const parts = COUNTS.filter((k) => s[k]).map((k) => `${s[k]} ${k}`);
  return [`${MARK} · live`, ...tokens, ...parts].join(' · ');
}

const statsFile = (session: string) => sessionFile(session, '.signs');

export function readStats(session: string): Stats {
  const file = statsFile(session);
  return existsSync(file) ? { ...EMPTY, ...JSON.parse(readFileSync(file, 'utf8')) } : { ...EMPTY };
}

export function bump(session: string, stat: keyof Stats, by = 1): void {
  const s = readStats(session);
  s[stat] += by;
  writeFileSync(statsFile(session), JSON.stringify(s));
}
