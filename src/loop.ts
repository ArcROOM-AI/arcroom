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

/** True when the last LOOP_LIMIT-1 calls were all this same call. */
export function isLoop(recent: string[], sig: string): boolean {
  return recent.length >= LOOP_LIMIT - 1 && recent.slice(-(LOOP_LIMIT - 1)).every((s) => s === sig);
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
  const recent: string[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const sig = signature(tool, input);
  if (isLoop(recent, sig)) {
    return `ArcRoom loop guard: this exact ${tool} call already ran ${LOOP_LIMIT - 1} times in a row. Don't repeat it; try a different approach.`;
  }
  writeFileSync(file, JSON.stringify([...recent, sig].slice(-(LOOP_LIMIT - 1))));
  return undefined;
}
