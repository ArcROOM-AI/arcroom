import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blindEvent, type CodeSetup, codeSetup, repoKey, repoPath } from './blind.js';
import { prefetchCode } from './code.js';
import { EDIT_TOOLS } from './done.js';
import { api, ARCROOM_HOME, keyRefused, loadConfig, type Config } from './home.js';
import { serveLookups } from './lookup.js';
import { redact, rememberSecrets } from './redact.js';
import { branches, syncTree } from './tree.js';

const SPOOL = join(ARCROOM_HOME, 'spool.jsonl');
const SENDING = join(ARCROOM_HOME, 'spool.sending.jsonl');
const STATE = join(ARCROOM_HOME, 'daemon-state.json');
const PID = join(ARCROOM_HOME, 'daemon.pid');
const BEAT = join(ARCROOM_HOME, 'daemon.beat');
const LOG = join(ARCROOM_HOME, 'daemon.log');
const BATCH = 200; // events per upload
const READ_MAX = 4 * 1024 * 1024; // bytes read per tick
const IDLE_MS = 3000;

export type State = { offset: number; seq: Record<string, number> }; // ponytail: seq map grows per session forever; prune ended sessions if it gets big

/** Takes complete lines from the queue text: assigns each session's next seq and redacts secrets. */
export function toBatch(text: string, seq: Record<string, number>, max = BATCH, shape: (e: Record<string, any>) => Record<string, any> = (e) => e) {
  const next = { ...seq };
  const events: Record<string, unknown>[] = [];
  let consumed = 0;
  while (events.length < max) {
    const nl = text.indexOf('\n', consumed);
    if (nl < 0) break; // last line may still be being written
    const line = text.slice(consumed, nl);
    consumed = nl + 1;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.v !== 1) continue; // raw lines from the first hook version
    const n = next[e.session] ?? 0;
    next[e.session] = n + 1;
    rememberSecrets(e.cwd); // the second pass knows each project's .env values too
    events.push(redact(shape({ ...e, seq: n })));
  }
  return { events, consumed, seq: next };
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const log = (msg: string) => appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);

/**
 * The queue does not grow forever: once everything in it was sent it is moved aside (hooks then start a new one), and
 * the moved file is deleted after anything a hook appended in that moment has been sent too. Offsets are into the
 * file being read: the moved one while it exists, else the queue.
 */
export function rotate(state: State, spool = SPOOL, sending = SENDING): State {
  if (existsSync(sending)) {
    if (statSync(sending).size > state.offset) return state;
    rmSync(sending, { force: true });
    return { ...state, offset: 0 };
  }
  if (state.offset > 0 && existsSync(spool) && statSync(spool).size === state.offset) {
    try {
      renameSync(spool, sending);
    } catch {
      // a hook is writing to it right now (Windows): the next tick moves it
    }
  }
  return state;
}

/** Sends the next batch from the queue. The offset only moves after the server accepted it. */
async function drainOnce(cfg: Config): Promise<number> {
  const saved = readJson<State>(STATE, { offset: 0, seq: {} });
  const state = rotate(saved);
  if (state !== saved) writeFileSync(STATE, JSON.stringify(state));
  const file = existsSync(SENDING) ? SENDING : SPOOL;
  if (!existsSync(file) || statSync(file).size <= state.offset) return 0;

  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(READ_MAX, statSync(file).size - state.offset));
  readSync(fd, buf, 0, buf.length, state.offset);
  closeSync(fd);

  const text = buf.toString('utf8');
  const { events, consumed, seq } = toBatch(text, state.seq, BATCH, withCode);
  if (consumed === 0) return 0;
  if (events.length) {
    const result: { stored: number; rejected: number } = await api(cfg, '/v1/ingest', { events }, 30_000);
    if (result.rejected) log(`server rejected ${result.rejected} of ${events.length} events`);
  }
  writeFileSync(STATE, JSON.stringify({ offset: state.offset + Buffer.byteLength(text.slice(0, consumed)), seq }));
  // a turn ended or a session started in a repo: send what changed in its tree (after the events, so claims land first)
  for (const cwd of new Set(events.filter((e: any) => e.type === 'turn.end' || e.type === 'run.start').map((e: any) => e.cwd).filter(Boolean)))
    await syncRepo(cfg, String(cwd)).catch((err) => log(`tree sync: ${err}`));
  // a session started: its first prompt's code map, fetched now (not awaited: the queue keeps moving)
  for (const e of events as any[]) if (e.type === 'run.start' && e.cwd) prefetchCode(cfg, String(e.cwd), String(e.session)).catch((err) => log(`prefetch: ${err}`));
  return events.length;
}

// Code wing (Standard): which repo, branch and folder an edit is in, cached per folder for a minute.
const setups = new Map<string, { s: CodeSetup | undefined; branch: string; at: number }>();
function setupFor(cwd: string) {
  const hit = setups.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const s = codeSetup(cwd);
  const next = { s, branch: s ? branches(s.root).branch : '', at: Date.now() };
  setups.set(cwd, next);
  return next;
}

/** An edit names its repo, branch, file and folder, so the Room can tell other agents who is changing what. */
export function codeTag(e: Record<string, any>, s: CodeSetup | undefined, branch: string): Record<string, any> {
  const file = e.data?.input?.file_path ?? e.data?.input?.notebook_path;
  if (e.type !== 'tool.start' || !s || s.mode !== 'standard' || !EDIT_TOOLS.has(e.data?.tool) || typeof file !== 'string') return e;
  const node = repoPath(s.root, file, e.cwd ?? s.root);
  if (!node || node === '.') return e;
  const dir = node.includes('/') ? node.slice(0, node.lastIndexOf('/')) : '.';
  return { ...e, data: { ...e.data, code: { repo: repoKey(s), branch, node, dir, agent: e.data.agent ?? 'claude' } } };
}
/** Each event as it may leave this laptop: a Blind repo's with paths scrambled and contents dropped, an edit tagged. */
export function withCode(e: Record<string, any>, setup: (cwd: string) => { s: CodeSetup | undefined; branch: string } = setupFor) {
  if (typeof e.cwd !== 'string') return e;
  const { s, branch } = setup(e.cwd);
  if (s?.mode === 'blind') return blindEvent(e, s);
  return e.type === 'tool.start' ? codeTag(e, s, branch) : e;
}

const lastSync = new Map<string, number>();
async function syncRepo(cfg: Config, cwd: string) {
  const s = setupFor(cwd).s;
  if (!s || s.mode !== 'standard' || Date.now() - (lastSync.get(s.root) ?? 0) < 15_000) return;
  lastSync.set(s.root, Date.now());
  const r = await syncTree(cfg, s);
  if (r) log(`tree sync ${s.root}: ${r.nodes} nodes`);
}

export async function daemon(): Promise<void> {
  if (isRunning()) return; // another daemon already owns the queue
  writeFileSync(PID, String(process.pid));
  writeFileSync(BEAT, String(process.pid));
  const cfg = loadConfig();
  serveLookups();
  log(`daemon started (pid ${process.pid})`);
  for (;;) {
    writeFileSync(BEAT, String(process.pid)); // proof of life: a PID alone may belong to another program by now (N20)
    let sent = 0;
    try {
      if (!cfg.apiKey) throw new Error('missing apiKey in config.json; run arcroom init');
      // the key was refused (revoked, removed, account deleted): the daemon ends instead of retrying forever
      if (keyRefused(cfg)) {
        log('key refused by ArcRoom: daemon stopped until arcroom init saves a new key');
        process.exit(0); // the lookup server would keep it alive
      }
      sent = await drainOnce(cfg);
      if (sent) log(`sent ${sent} events`);
    } catch (err) {
      log(String(err)); // offline or server down: events stay queued, retried next tick
    }
    if (sent < BATCH) await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

/**
 * Our daemon runs when the PID in daemon.pid is alive AND that same PID wrote daemon.beat lately (each loop, at most
 * ~35 s apart). After a reboot the PID may belong to another program: then nothing is stopped and a new daemon starts.
 */
export function isRunning(pidFile = PID, beatFile = BEAT, now = Date.now()): boolean {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid === process.pid) return false;
    if (readFileSync(beatFile, 'utf8') !== String(pid) || now - statSync(beatFile).mtimeMs > 120_000) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Called from the hook: starts the daemon in the background if it is not running. */
export function ensureDaemon(entry: string): void {
  if (isRunning()) return;
  spawn(process.execPath, [entry, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Called from init: stops a running daemon so the next hook starts the updated one. */
export function stopDaemon(): void {
  if (!isRunning()) return; // a stale PID may be someone else's program now: never killed
  try {
    process.kill(Number(readFileSync(PID, 'utf8')));
  } catch {
    // not running
  }
}
