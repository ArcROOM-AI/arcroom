import { git as runGit } from './git.js';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { ARCROOM_HOME } from './home.js';
import { projectOf } from './session.js';

// Blind mode: the team key never leaves the team's laptops. Every path, git hash, branch and repo name is scrambled
// with it (HMAC: same input, same output, irreversible without the key) before anything is sent, and folder summaries
// and notes are encrypted (AES-256-GCM). Laptops with the key turn ids back into paths locally.
// A repo's mode lives in its committed .arcroom.json ({ "code": "blind", "key": "<fingerprint>" }), so every
// teammate's plugin knows before it sends anything; the key itself sits in ~/.arcroom/keys/<fingerprint>.key.
// ponytail: key file with owner-only permissions; move it into the OS keychain (Keychain, Credential Manager) later

export type Mode = 'off' | 'standard' | 'blind';
export type Keys = { root: Buffer; fp: string; path: Buffer; hash: Buffer; enc: Buffer };
export type CodeSetup = { root: string; mode: Mode; fp?: string; keys?: Keys };

const mac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest('hex');

/** The three working keys and the fingerprint, all derived from the 32-byte team key. */
export function keysFrom(root: Buffer): Keys {
  const sub = (info: string) => Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), info, 32));
  return { root, fp: mac(root, 'arcroom fingerprint').slice(0, 16), path: sub('arcroom paths'), hash: sub('arcroom hashes'), enc: sub('arcroom notes') };
}
export const newKeys = () => keysFrom(randomBytes(32));

/** src/billing → k_7f3a…; the repo root stays "." (it says nothing). */
export const scramblePath = (k: Keys, rel: string) => (rel === '' || rel === '.' ? '.' : `k_${mac(k.path, rel).slice(0, 24)}`);
/** A git hash → c_…; the trailing * (uncommitted edits) is kept so "dirty" stays visible. */
export const scrambleHash = (k: Keys, h: string) => (h.endsWith('*') ? `c_${mac(k.hash, h.slice(0, -1)).slice(0, 24)}*` : `c_${mac(k.hash, h).slice(0, 24)}`);
/** A branch (b_) or repo (r_) name. */
export const scrambleName = (k: Keys, kind: 'b' | 'r', name: string) => `${kind}_${mac(k.path, `${kind}:${name}`).slice(0, 20)}`;

export function encrypt(k: Keys, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}
/** The text, or undefined when it was sealed with another key. Plain text passes through. */
export function decrypt(k: Keys, sealed: string): string | undefined {
  if (!sealed.startsWith('enc:v1:')) return sealed;
  try {
    const b = Buffer.from(sealed.slice(7), 'base64');
    const d = createDecipheriv('aes-256-gcm', k.enc, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The key as a code to pass to a teammate, or to keep as the recovery code. */
export const keyCode = (k: Keys) => `arck1_${k.root.toString('base64url')}`;
export function fromCode(code: string): Keys {
  const m = /^arck1_([A-Za-z0-9_-]{43})$/.exec(code.trim());
  if (!m) throw new Error('that is not an ArcRoom key code (it starts with arck1_)');
  return keysFrom(Buffer.from(m[1], 'base64url'));
}

const keyFile = (fp: string) => join(ARCROOM_HOME, 'keys', `${fp}.key`);
export function saveKey(k: Keys): string {
  mkdirSync(join(ARCROOM_HOME, 'keys'), { recursive: true });
  writeFileSync(keyFile(k.fp), keyCode(k), { mode: 0o600 });
  return keyFile(k.fp);
}
export function loadKey(fp: string): Keys | undefined {
  try {
    const k = fromCode(readFileSync(keyFile(fp), 'utf8'));
    return k.fp === fp ? k : undefined;
  } catch {
    return undefined;
  }
}

const git = (cwd: string, args: string[]) => {
  const r = runGit(args, { cwd, timeout: 3000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
};
export const gitRoot = (cwd: string) => git(cwd, ['rev-parse', '--show-toplevel'])?.trim();

/** The repo's Code wing setup: its mode from .arcroom.json, and in Blind mode the key when this laptop has it. */
export function codeSetup(cwd: string): CodeSetup | undefined {
  const root = cwd ? gitRoot(cwd) : undefined;
  if (!root) return undefined;
  const cfg = readSetup(root);
  const mode: Mode = cfg.code === 'blind' || cfg.code === 'off' ? cfg.code : 'standard';
  // N12: a repo seen in Blind mode on this laptop stays Blind even if a commit takes it out of .arcroom.json;
  // only the person here lowers it (arcroom code on|off)
  const known = blindRepos()[root];
  if (mode !== 'blind' && known) return { root, mode: 'blind', fp: known, keys: loadKey(known) };
  if (mode === 'blind' && typeof cfg.key === 'string' && known !== cfg.key) rememberBlind(root, cfg.key);
  return mode === 'blind' ? { root, mode, fp: cfg.key, keys: typeof cfg.key === 'string' ? loadKey(cfg.key) : undefined } : { root, mode };
}

/** Repos this laptop has seen in Blind mode: git root -> key fingerprint. */
const BLIND_REPOS = join(ARCROOM_HOME, 'blind-repos.json');
const blindRepos = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(BLIND_REPOS, 'utf8'));
  } catch {
    return {};
  }
};
const saveBlindRepos = (repos: Record<string, string>) => {
  mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(BLIND_REPOS, JSON.stringify(repos, null, 2) + '\n', { mode: 0o600 });
};
const rememberBlind = (root: string, fp: string) => saveBlindRepos({ ...blindRepos(), [root]: fp });
/** The person chose another mode for this repo (arcroom code on|off): it is no longer kept Blind. */
export function forgetBlind(root: string): void {
  const { [root]: _gone, ...rest } = blindRepos();
  saveBlindRepos(rest);
}
export function readSetup(root: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(root, '.arcroom.json'), 'utf8'));
  } catch {
    return {};
  }
}
export function writeSetup(root: string, patch: Record<string, unknown>): void {
  const next = { ...readSetup(root), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writeFileSync(join(root, '.arcroom.json'), JSON.stringify(next, null, 2) + '\n');
}

/** The repo id as the Room knows it: the git remote, scrambled in Blind mode. */
export const repoKey = (s: CodeSetup) => (s.mode === 'blind' && s.keys ? scrambleName(s.keys, 'r', projectOf(s.root)) : projectOf(s.root));
export const branchKey = (s: CodeSetup, branch: string) => (s.mode === 'blind' && s.keys ? scrambleName(s.keys, 'b', branch) : branch);
export const nodeKey = (s: CodeSetup, rel: string) => (s.mode === 'blind' && s.keys ? scramblePath(s.keys, rel) : rel || '.');
export const hashKey = (s: CodeSetup, h: string) => (s.mode === 'blind' && s.keys ? scrambleHash(s.keys, h) : h);

/** A path (absolute, or relative to `from`) as a repo path: "src/billing/tax.ts", or undefined outside the repo. */
export function repoPath(root: string, p: string, from = root): string | undefined {
  const rel = relative(root, isAbsolute(p) ? p : join(from, p)).replaceAll('\\', '/');
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel || '.';
}

/** Every scrambled id in this checkout → its path (files git knows about and their folders). */
export function pathMap(s: CodeSetup): Map<string, string> {
  const map = new Map<string, string>();
  if (s.mode !== 'blind' || !s.keys) return map;
  const files = (git(s.root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
  for (const f of files) {
    map.set(scramblePath(s.keys, f), f);
    for (let d = f.lastIndexOf('/'); d > 0; d = f.lastIndexOf('/', d - 1)) map.set(scramblePath(s.keys, f.slice(0, d)), f.slice(0, d));
  }
  return map;
}
/** Text with every k_… id this checkout knows turned back into its path. */
export const unscramble = (text: string, map: Map<string, string>) => (map.size ? text.replace(/k_[0-9a-f]{24}/g, (m) => map.get(m) ?? m) : text);

/** Paths inside a shell command: the repo folder becomes ".", files and folders that exist are scrambled. */
export function scrambleCommand(cmd: string, s: CodeSetup, cwd: string): string {
  const rootFwd = s.root.replaceAll('\\', '/');
  let out = cmd.split(s.root).join('.').split(rootFwd).join('.');
  out = out.replace(/[\w@.\-/\\]+/g, (tok) => {
    if (tok.length < 2 || !/[/\\.]/.test(tok) || /^\.+$/.test(tok)) return tok;
    const rel = repoPath(s.root, tok, cwd);
    if (!rel || rel === '.' || !existsSync(join(s.root, rel))) return tok;
    return scramblePath(s.keys!, rel);
  });
  return out;
}

const CONTENT = ['content', 'old_string', 'new_string', 'edits', 'new_source'];

/**
 * One event as it may leave a Blind laptop: paths scrambled, file contents and tool output dropped, the folder the
 * agent runs in replaced by ".". Without the key nothing path-like is sent at all.
 */
export function blindEvent(e: Record<string, any>, s: CodeSetup): Record<string, any> {
  const k = s.keys;
  const cwd = typeof e.cwd === 'string' ? e.cwd : s.root;
  const path = (p: unknown) => {
    if (typeof p !== 'string') return p;
    const rel = repoPath(s.root, p, cwd);
    return !k ? 'hidden' : rel ? scramblePath(k, rel) : 'outside';
  };
  const d: Record<string, any> = { ...(e.data ?? {}) };
  switch (e.type) {
    case 'run.start':
      d.project = k ? scrambleName(k, 'r', projectOf(s.root)) : undefined;
      d.cwd = '.';
      if (typeof d.branch === 'string') d.branch = k ? scrambleName(k, 'b', d.branch) : undefined;
      delete d.transcript;
      break;
    case 'tool.start': {
      const i: Record<string, any> = { ...(typeof d.input === 'object' && d.input ? d.input : {}) };
      for (const f of ['file_path', 'notebook_path', 'path']) if (i[f] !== undefined) i[f] = path(i[f]);
      if (typeof i.command === 'string') i.command = k ? scrambleCommand(i.command, s, cwd) : 'hidden';
      for (const f of CONTENT) delete i[f];
      d.input = i;
      break;
    }
    case 'tool.end':
      delete d.output; // file contents and command output never leave a Blind laptop
      break;
    case 'turn.end':
      if (d.files && typeof d.files === 'object')
        d.files = k
          ? Object.fromEntries(Object.entries(d.files).flatMap(([p, h]) => {
              const rel = repoPath(s.root, p, cwd);
              return rel ? [[scramblePath(k, rel), scrambleHash(k, String(h))]] : [];
            }))
          : undefined;
      break;
    case 'context':
      delete d.text; // what ArcRoom handed over, already unscrambled on this laptop
      break;
    default:
      if (String(e.type).startsWith('other.')) return { ...e, cwd: undefined, data: {} };
  }
  for (const [key, v] of Object.entries(d)) if (v === undefined) delete d[key];
  return { ...e, cwd: undefined, data: d };
}
