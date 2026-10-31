import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type CodeContext, codeContext } from './code.js';
import { ARCROOM_HOME, loadConfig } from './home.js';
import { recall, type Recall } from './recall.js';
import { projectOf } from './session.js';

// Before every prompt the hook needs recall and the code map. A hook is a new process each time: cold module load,
// a new connection to the API, empty caches. The daemon is already running, so the hook asks it instead (127.0.0.1,
// a secret only this user can read); its connection to the API stays open and its caches (lookups for 2 min, the
// first prompt's code map fetched when the session started) are warm. No daemon: the hook does the same lookup itself.

// offline: recall failed or ran out of time, so the prompt went on without memory (the hook says so)
export type Lookup = { recall: Recall; code?: CodeContext; offline?: true };
const PORT_FILE = join(ARCROOM_HOME, 'daemon.port'); // "<port> <secret>"

// A hung API costs the full wait on every prompt. After a failure, prompts skip the lookup for a minute:
// an outage then costs that wait once a minute, not every prompt.
const DOWN = join(ARCROOM_HOME, 'api-down');
const COOL_MS = 60_000;
const OFFLINE: Lookup = { recall: {}, offline: true };
const markDown = () => {
  try {
    writeFileSync(DOWN, new Date().toISOString(), { mode: 0o600 });
  } catch {
    // no cool-down this time: the next prompt waits again
  }
};
const recentlyDown = () => {
  try {
    return Date.now() - statSync(DOWN).mtimeMs < COOL_MS;
  } catch {
    return false;
  }
};

// Inside the hook's 3 s wait (lookupFast): the lookup itself must finish well before it, or its answer arrives after
// the hook gave up and every prompt reads "memory offline" (seen from India to the Ashburn API: 3.1 s each time).
const RECALL_MS = 2200;
const CODE_MS = 1200; // the code map is the extra: it never holds recall up

/** Recall and the code map for one prompt, at the same time; a failure of either is an empty answer, never an error. */
export async function lookup(prompt: string, cwd: string, session: string, given: Set<string>): Promise<Lookup> {
  const [r, code] = await Promise.all([
    recall(prompt, cwd, projectOf(cwd), given, RECALL_MS).catch(() => undefined),
    codeContext(loadConfig(cwd), cwd, session, prompt, CODE_MS).catch(() => undefined),
  ]);
  if (!r) markDown();
  return { recall: r ?? {}, ...(code ? { code } : {}), ...(r ? {} : { offline: true as const }) };
}

/** The warm daemon's lookup; the hook's own when no daemon answers. A daemon that is there but slow is not asked twice. */
export async function lookupFast(prompt: string, cwd: string, session: string, given: Set<string>, timeoutMs = 3000): Promise<Lookup> {
  if (recentlyDown()) return OFFLINE;
  const [port, secret] = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, 'utf8').trim().split(' ') : [];
  if (!port) return lookup(prompt, cwd, session, given);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arcroom': secret },
      body: JSON.stringify({ prompt, cwd, session, given: [...given] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`daemon ${res.status}`);
    // only our daemon knows the secret: an answer without its signature (whatever took the port after the daemon
    // stopped) is never handed to the agent (L8)
    const text = await res.text();
    if (res.headers.get('x-arcroom-proof') !== proof(secret, text)) throw new Error('daemon answer not signed');
    return JSON.parse(text) as Lookup;
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      markDown();
      return OFFLINE; // the time is spent: no hand-over this prompt
    }
    return lookup(prompt, cwd, session, given); // no daemon on that port (it stopped): do it here
  }
}

/** The daemon's side: serves lookups on a free port of 127.0.0.1 and writes the port and a fresh secret. */
export function serveLookups(): void {
  const secret = randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/lookup' || req.headers['x-arcroom'] !== secret) return void res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += chunk;
      const a = JSON.parse(body);
      const out = JSON.stringify(await lookup(String(a.prompt ?? ''), String(a.cwd ?? ''), String(a.session ?? ''), new Set<string>(a.given ?? [])));
      res.writeHead(200, { 'content-type': 'application/json', 'x-arcroom-proof': proof(secret, out) }).end(out);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(PORT_FILE, `${(server.address() as AddressInfo).port} ${secret}`, { mode: 0o600 }));
  process.on('exit', () => rmSync(PORT_FILE, { force: true })); // a stopped daemon leaves no port to take over
}

/** The daemon's signature on an answer: an HMAC with the secret only it and this user can read. */
export const proof = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
