import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { sessionFile } from './loop.js';

// Token meter: reads token usage from the session file: Claude Code's transcript (assistant messages carry message.usage)
// or Codex's (token_count events).
// Reads only what's new since last time, and counts each message id once (a message spans several lines).

export type Usage = { input: number; output: number; cache_read: number; cache_write: number; model?: string };
type State = { offset: number; total: Usage; reported: Usage; ids: string[]; claims: Record<string, number> };

const zero = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
export const tokensOf = (u: Usage) => u.input + u.output + u.cache_read + u.cache_write;
const plus = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write,
  model: b.model ?? a.model,
});
const minus = (a: Usage, b: Usage): Usage => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cache_read: a.cache_read - b.cache_read,
  cache_write: a.cache_write - b.cache_write,
  model: a.model,
});

/** Usage of the assistant messages in complete transcript lines, skipping message ids already counted. */
export function sumUsage(text: string, seen: Set<string>): { usage: Usage; consumed: number } {
  const usage = zero();
  const consumed = text.lastIndexOf('\n') + 1; // a half-written last line waits for next time
  const latest = new Map<string, any>(); // ponytail: a message split across two reads keeps its first counts; fine since usage repeats per line
  for (const line of text.slice(0, consumed).split('\n')) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex's session file: the model in turn_context, and a token_count event after each model call. A repeated event
    // carries the same running total, which is its id here. Its input includes the cached part; reasoning is in output.
    if (e?.type === 'turn_context' && typeof e.payload?.model === 'string') usage.model = e.payload.model;
    const info = e?.type === 'event_msg' && e.payload?.type === 'token_count' ? e.payload.info : undefined;
    const last = info?.last_token_usage;
    const id = `codex:${info?.total_token_usage?.total_tokens}`;
    if (last && !seen.has(id)) {
      seen.add(id);
      const cached = last.cached_input_tokens ?? 0;
      usage.input += Math.max(0, (last.input_tokens ?? 0) - cached);
      usage.cache_read += cached;
      usage.output += last.output_tokens ?? 0;
    }
    const m = e?.type === 'assistant' ? e.message : undefined;
    if (m?.usage && m.id && !seen.has(m.id)) latest.set(m.id, m);
  }
  for (const [id, m] of latest) {
    seen.add(id);
    usage.input += m.usage.input_tokens ?? 0;
    usage.output += m.usage.output_tokens ?? 0;
    usage.cache_read += m.usage.cache_read_input_tokens ?? 0;
    usage.cache_write += m.usage.cache_creation_input_tokens ?? 0;
    usage.model = m.model ?? usage.model;
  }
  return { usage, consumed };
}

const file = (session: string) => sessionFile(session, '.usage');

/** Reads new transcript lines into the session's running total. */
function advance(session: string, transcript: string | undefined): State {
  const f = file(session);
  const st: State = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { offset: 0, total: zero(), reported: zero(), ids: [], claims: {} };
  if (transcript && existsSync(transcript) && statSync(transcript).size > st.offset) {
    const fd = openSync(transcript, 'r');
    const buf = Buffer.alloc(statSync(transcript).size - st.offset);
    readSync(fd, buf, 0, buf.length, st.offset);
    closeSync(fd);
    const text = buf.toString('utf8');
    const seen = new Set(st.ids);
    const { usage, consumed } = sumUsage(text, seen);
    st.offset += Buffer.byteLength(text.slice(0, consumed));
    st.total = plus(st.total, usage);
    st.ids = [...seen].slice(-500);
  }
  return st;
}

const save = (session: string, st: State) => writeFileSync(file(session), JSON.stringify(st));

/** Everything this session has used so far (the status line). */
export function sessionUsage(session: string, transcript: string | undefined): Usage {
  const st = advance(session, transcript);
  save(session, st);
  return st.total;
}

/** Turn end: the tokens used since the last report, or undefined when nothing new. */
export function turnUsage(session: string, transcript: string | undefined): Usage | undefined {
  const st = advance(session, transcript);
  const delta = minus(st.total, st.reported);
  st.reported = st.total;
  save(session, st);
  return tokensOf(delta) > 0 ? delta : undefined;
}

/** claim_task: remember where the token count stood. */
export function markClaim(session: string, transcript: string | undefined, memoId: string): void {
  const st = advance(session, transcript);
  st.claims[memoId] = tokensOf(st.total);
  save(session, st);
}

/** complete_task: tokens spent on this memo since its claim (since session start if it was never claimed here). */
export function costSinceClaim(session: string, transcript: string | undefined, memoId: string): { tokens: number; model?: string } {
  const st = advance(session, transcript);
  const tokens = tokensOf(st.total) - (st.claims[memoId] ?? 0);
  delete st.claims[memoId];
  save(session, st);
  return { tokens: Math.max(tokens, 0), model: st.total.model };
}
