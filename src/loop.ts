import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCROOM_HOME } from './home.js';

export const LOOP_LIMIT = 3; // the 3rd identical call in a row is blocked

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** Same tool + same input (in any key order) = same signature. */
export function signature(tool: string, input: unknown): string {
  return createHash('sha256').update(`${tool}\0${stable(input)}`).digest('hex').slice(0, 16);
}

type Call = { sig: string; at: number };
// Read-only status checks an agent repeats while it waits (CI, a deploy, a container): polling, not a loop, when there
// is a wait between them. Anything else repeated is still blocked on the 3rd identical call in a row.
const POLL = /^(?:sleep \d+\s*(?:&&|;)\s*)?(?:gh (?:run|pr|workflow) (?:view|watch|list|checks|status)|gh pr checks|git (?:status|log|fetch)|kubectl (?:get|describe|rollout status)|docker (?:ps|logs)|curl\b|Start-Sleep\b)/i;
export const POLL_GAP_MS = 10_000;
export const isPoll = (tool: string, input: any) => (tool === 'Bash' || tool === 'PowerShell') && POLL.test(String(input?.command ?? '').trim());

/** True when the last LOOP_LIMIT-1 calls were all this same call, and it is not a status check polled with a wait. */
export function isLoop(recent: (string | Call)[], sig: string, poll = false, now = Date.now()): boolean {
  const last = recent.slice(-(LOOP_LIMIT - 1)).map((c) => (typeof c === 'string' ? { sig: c, at: 0 } : c));
  if (last.length < LOOP_LIMIT - 1 || !last.every((c) => c.sig === sig)) return false;
  return !(poll && now - last[last.length - 1].at >= POLL_GAP_MS);
}

/** Path of a per-session state file under ~/.arcroom/sessions. */
export function sessionFile(session: string, suffix = ''): string {
  const dir = join(ARCROOM_HOME, 'sessions'); // ponytail: tiny files per session, never cleaned up; prune old ones if it matters
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session.replace(/[^\w-]/g, '_')}${suffix}.json`);
}

/** Returns a block reason for a looping call; otherwise records the call and returns undefined. */
export function checkLoop(session: string, tool: string, input: unknown): string | undefined {
  const file = sessionFile(session);
  const recent: (string | Call)[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const sig = signature(tool, input);
  if (isLoop(recent, sig, isPoll(tool, input))) {
    return `ArcRoom loop guard: this exact ${tool} call already ran ${LOOP_LIMIT - 1} times in a row. Don't repeat it; try a different approach.`;
  }
  writeFileSync(file, JSON.stringify([...recent, { sig, at: Date.now() }].slice(-(LOOP_LIMIT - 1))));
  return undefined;
}
