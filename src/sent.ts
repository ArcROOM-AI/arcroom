import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ARCROOM_HOME } from './home.js';

// What left this laptop: every event exactly as the API accepted it (already redacted), one file per day under
// ~/.arcroom/sent, readable only by you, kept 7 days. `arcroom sent` reads it, so anyone can check what was uploaded.
const DIR = join(ARCROOM_HOME, 'sent');
export const KEEP_DAYS = 7;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Called by the uploader after the API accepted these events. */
export function logSent(events: object[], now = new Date()): void {
  if (!events.length) return;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  appendFileSync(join(DIR, `${dayOf(now)}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  prune(now);
}

/** Drops days older than KEEP_DAYS. */
export function prune(now = new Date()): void {
  if (!existsSync(DIR)) return;
  const oldest = dayOf(new Date(now.getTime() - (KEEP_DAYS - 1) * 86_400_000));
  for (const f of readdirSync(DIR)) if (DAY_FILE.test(f) && f.slice(0, 10) < oldest) rmSync(join(DIR, f));
}

/** `arcroom sent [YYYY-MM-DD] [--all]`: that day's summary and latest events (--all: every event, as sent). */
export function sentReport(args: string[], now = new Date()): string {
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? dayOf(now);
  const file = join(DIR, `${day}.jsonl`);
  const days = existsSync(DIR) ? readdirSync(DIR).filter((f) => DAY_FILE.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  if (!existsSync(file)) return `Nothing was sent on ${day}.${days.length ? ` Days kept: ${days.join(', ')}.` : ''}`;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (args.includes('--all')) return lines.join('\n');
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const count = (re: RegExp) => lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0);
  const of = (t: string) => events.filter((e) => e.type === t).length;
  const repos = [...new Set(events.map((e) => e.cwd).filter(Boolean))];
  const line = (e: any) => {
    const d = e.data ?? {};
    const what = e.type === 'prompt' ? `"${String(d.prompt ?? '').slice(0, 70)}"` : e.type === 'tool.start' ? `${d.tool} ${String(d.input?.command ?? d.input?.file_path ?? d.input?.pattern ?? d.input?.url ?? '').slice(0, 70)}` : '';
    return `  ${String(e.at ?? '').slice(11, 19)}  ${e.type}${what ? `  ${what}` : ''}`;
  };
  return [
    `Sent on ${day}: ${events.length} events from ${repos.length} folder${repos.length === 1 ? '' : 's'}`,
    `  ${of('prompt')} prompts, ${of('tool.start')} tool calls (paths and commands only), ${of('turn.end')} turn ends`,
    `  ${count(/\[REDACTED\]/g)} values redacted, ${count(/\[secret file\]/g)} secret-file paths hidden; no file contents`,
    ...(repos.length ? [`  folders: ${repos.slice(0, 5).join(', ')}${repos.length > 5 ? ` (+${repos.length - 5} more)` : ''}`] : []),
    'Latest:',
    ...events.slice(-10).map(line),
    `Every event, exactly as sent: arcroom sent ${day} --all   (kept ${KEEP_DAYS} days in ${DIR})`,
  ].join('\n');
}
