import { git as runGit } from './git.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchKey, type CodeSetup, hashKey, nodeKey, repoKey } from './blind.js';
import { blobHash } from './fresh.js';
import { api, ARCROOM_HOME, type Config } from './home.js';

// The repo's shape for the Room, read from git without opening a file: git names every folder by the hash of what is
// inside it (`git ls-tree -r -t`), so "same hash" means "nothing changed". Uncommitted edits get their own hash and
// their folders a trailing *. The default branch sends its whole tree once, then only what changed; any other branch
// sends only the folders and files that differ from where it left the default branch.

export type Entry = { kind: 'dir' | 'file'; hash: string };
export type Tree = Map<string, Entry>; // repo path ("." for the root) → kind and hash

const MAX_NODES = 20_000; // ponytail: past this only folders are sent; send files per folder on demand if big repos need them

const git = (root: string, args: string[]) => {
  const r = runGit(args, { cwd: root, timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
};
const parentOf = (p: string) => (p === '.' ? undefined : p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/** Parses `git ls-tree -r -t --full-tree HEAD` output: "<mode> <type> <hash>\t<path>". */
export function parseLsTree(out: string, rootHash?: string): Tree {
  const tree: Tree = new Map();
  if (rootHash) tree.set('.', { kind: 'dir', hash: rootHash });
  for (const line of out.split('\n')) {
    const m = /^\d+ (tree|blob) ([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (m) tree.set(m[3], { kind: m[1] === 'tree' ? 'dir' : 'file', hash: m[2] });
  }
  return tree;
}

/** Applies uncommitted changes: edited files get their working hash, deleted ones go, their folders get a trailing *. */
export function withDirty(tree: Tree, changes: { path: string; hash?: string }[]): Tree {
  const out = new Map(tree);
  for (const c of changes) {
    if (c.hash) out.set(c.path, { kind: 'file', hash: c.hash });
    else out.delete(c.path);
    for (let d = parentOf(c.path); d; d = parentOf(d)) {
      const cur = out.get(d) ?? { kind: 'dir' as const, hash: 'new' };
      if (!cur.hash.endsWith('*')) out.set(d, { kind: 'dir', hash: `${cur.hash}*` });
      if (d === '.') break;
    }
  }
  return out;
}

/** This checkout's tree: HEAD from git, plus what is edited but not committed. */
export function readTree(root: string): Tree {
  const head = git(root, ['rev-parse', 'HEAD^{tree}'])?.trim();
  const tree = head ? parseLsTree(git(root, ['ls-tree', '-r', '-t', '--full-tree', 'HEAD']) ?? '', head) : new Map<string, Entry>([['.', { kind: 'dir', hash: 'empty' }]]);
  const changes = (git(root, ['status', '--porcelain', '-uall']) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
    .map((path) => {
      const file = join(root, path);
      return { path, hash: existsSync(file) ? safeBlob(file) : undefined };
    });
  return withDirty(tree, changes);
}
const safeBlob = (file: string) => {
  try {
    return blobHash(readFileSync(file));
  } catch {
    return undefined;
  }
};

export type Branches = { branch: string; def: string; ahead: number; all: string[]; merged: string[] };
const short = (refs: string | undefined) =>
  [...new Set((refs ?? '').split('\n').map((r) => r.trim().replace(/^origin\//, '')).filter((r) => r && r !== 'HEAD' && r !== 'origin'))];

/** The branch this checkout is on, the team's default branch, and which branches exist and are merged into it. */
export function branches(root: string): Branches {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'main';
  const remoteHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '');
  const has = (b: string) => git(root, ['rev-parse', '--verify', '--quiet', b]) !== undefined;
  const def = remoteHead || (has('main') ? 'main' : has('master') ? 'master' : branch);
  const ahead = branch === def ? 0 : Number(git(root, ['rev-list', '--count', `${def}..HEAD`])?.trim() ?? 0) || 0;
  const fmt = ['--format=%(refname:short)', 'refs/heads', 'refs/remotes'];
  return { branch, def, ahead, all: short(git(root, ['for-each-ref', ...fmt])), merged: has(def) ? short(git(root, ['for-each-ref', '--merged', def, ...fmt])) : [] };
}

/** The paths a branch changed since it left the default branch (plus uncommitted ones), with every folder above. */
export function branchPaths(root: string, def: string, tree: Tree): Set<string> {
  const base = git(root, ['merge-base', 'HEAD', def])?.trim();
  const changed = base ? (git(root, ['diff', '--name-only', base, 'HEAD']) ?? '').split('\n').filter(Boolean) : [];
  const out = new Set<string>();
  const add = (p: string) => {
    for (let d: string | undefined = p; d && !out.has(d); d = parentOf(d)) out.add(d);
  };
  for (const p of changed) if (tree.has(p)) add(p);
  // uncommitted: their folders carry a *, and the files in those folders go along
  for (const [p, e] of tree) if (e.hash.endsWith('*') || (e.kind === 'file' && tree.get(parentOf(p)!)?.hash.endsWith('*'))) add(p);
  return out;
}

export type SyncBody = Record<string, unknown> & { nodes: { k: string; p?: string; kind: string; h: string }[]; deleted: string[] };

/** What to send: on the default branch only what changed since the last sync (all of it the first time). */
export function syncBody(s: CodeSetup, tree: Tree, b: Branches, last: Record<string, string> | undefined, reset = false): { body: SyncBody; sent: Record<string, string> } {
  const onDefault = b.branch === b.def;
  const paths = onDefault ? [...tree.keys()] : [...branchPaths(s.root, b.def, tree)];
  const keep = paths.length > MAX_NODES ? paths.filter((p) => tree.get(p)?.kind === 'dir') : paths;
  const sent: Record<string, string> = {};
  const nodes: SyncBody['nodes'] = [];
  for (const p of keep) {
    const e = tree.get(p);
    if (!e) continue;
    const k = nodeKey(s, p);
    const h = hashKey(s, e.hash);
    sent[k] = h;
    if (onDefault && last && !reset && last[k] === h) continue;
    const parent = parentOf(p);
    nodes.push({ k, ...(parent ? { p: nodeKey(s, parent) } : {}), kind: e.kind, h });
  }
  const full = !onDefault || !last || reset;
  const deleted = full ? [] : Object.keys(last!).filter((k) => !(k in sent));
  return {
    sent,
    body: {
      repo: repoKey(s),
      mode: s.mode,
      ...(s.mode === 'blind' ? { fingerprint: s.keys!.fp } : {}),
      branch: branchKey(s, b.branch),
      default_branch: branchKey(s, b.def),
      ahead: b.ahead,
      branches: b.all.map((x) => branchKey(s, x)),
      merged: b.merged.map((x) => branchKey(s, x)),
      full,
      ...(reset ? { reset: true } : {}),
      nodes,
      deleted,
    },
  };
}

const cacheFile = (s: CodeSetup, branch: string) =>
  join(ARCROOM_HOME, 'tree', `${createHash('sha1').update(`${s.root}|${s.mode}|${s.fp ?? ''}|${branch}`).digest('hex').slice(0, 16)}.json`);

/** Sends this checkout's tree to the Room. Off, or Blind without the key: nothing is sent. */
export async function syncTree(cfg: Config, s: CodeSetup, reset = false): Promise<any> {
  if (s.mode === 'off' || (s.mode === 'blind' && !s.keys)) return undefined;
  const tree = readTree(s.root);
  const b = branches(s.root);
  const file = cacheFile(s, b.branch);
  const last = existsSync(file) && !reset ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  const { body, sent } = syncBody(s, tree, b, last, reset);
  const r = await api(cfg, '/v1/code/sync', body, 30_000);
  mkdirSync(join(ARCROOM_HOME, 'tree'), { recursive: true });
  writeFileSync(file, JSON.stringify(sent));
  return r;
}
