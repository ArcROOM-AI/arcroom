import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { api, ARCROOM_HOME, loadConfig } from './home.js';

// An agent's save (complete_task, remember, code_note) that could not reach the API waits here, on this laptop, and the
// uploader sends it once the API answers again, instead of it being lost. Only "could not reach": a timeout may have
// arrived, and sending it twice could store it twice.
// ponytail: a complete_task sent after its 10-minute claim ran out is refused and dropped (logged)
const FILE = join(ARCROOM_HOME, 'pending-writes.jsonl');
const SENDING = `${FILE}.sending`;
export const WRITES = new Set(['/v1/tasks/complete', '/v1/memory/remember', '/v1/code/note']);
export const unreachable = (err: unknown) => /^could not reach /.test((err as Error)?.message ?? '');

export function keepForLater(path: string, body: object, cwd: string): void {
  mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
  appendFileSync(FILE, JSON.stringify({ path, body, cwd, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

type Send = (cwd: string, path: string, body: object) => Promise<unknown>;

/** Sends the saves kept for later: one the API still can't be reached for stays; one it refuses is dropped and returned. */
export async function sendLater(send: Send = (cwd, path, body) => api(loadConfig(cwd), path, body)): Promise<{ sent: number; dropped: string[] }> {
  if (!existsSync(SENDING)) {
    if (!existsSync(FILE)) return { sent: 0, dropped: [] };
    renameSync(FILE, SENDING); // saves made meanwhile go to a fresh file
  }
  const lines = readFileSync(SENDING, 'utf8').split('\n').filter(Boolean);
  rmSync(SENDING);
  let sent = 0;
  const dropped: string[] = [];
  for (const line of lines) {
    let w: { path: string; body: object; cwd: string };
    try {
      w = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      await send(w.cwd, w.path, w.body);
      sent++;
    } catch (err) {
      if (unreachable(err)) appendFileSync(FILE, line + '\n', { mode: 0o600 });
      else dropped.push(`${w.path}: ${(err as Error).message}`);
    }
  }
  return { sent, dropped };
}
