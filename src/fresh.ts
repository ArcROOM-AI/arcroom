import { git } from './git.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

// Is a stored memory still true for this checkout? Steps keep the git blob hash of each file they touched (taken on
// the laptop at the end of the turn; hashes only, no content). Before handing steps over, each file is looked up here:
//   same hash   → as it was
//   other hash  → changed since: kept, flagged so the agent checks before trusting it
//   missing     → renamed if a file here has the saved hash (followed to its new path), or moved and edited if exactly
//                 one file here has its name (followed, flagged as changed); otherwise deleted (dropped)
//                 when the task read it, or created by the task when it only wrote it (still a target)
// More than half the files it read deleted: the steps are stale and nothing is handed over. All local, no network.

/** Git's blob id for a file's bytes (the same id `git hash-object` prints), so it works with or without git. */
export const blobHash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** A text file's bytes with Windows line ends as LF, so a Windows and a Mac checkout of it hash the same; a binary file
 *  (one with a NUL byte) stays as it is. Every hash saved with steps or answers is taken over these bytes. */
export const lf = (bytes: Buffer) => (bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'));

export type Probe = {
  exists: (path: string) => boolean;
  hash?: (path: string) => string | undefined;
  /** a file here with this hash, other than the given paths (for renames) */
  find?: (hash: string, like: string) => string | undefined;
  /** the one file here with this file's name, if exactly one (a move that also edited it) */
  sameName?: (like: string) => string | undefined;
};

const MAX_SCAN = 2000; // files hashed when git's index has no match (no git, untracked files, CRLF committed)
const MAX_READ = 5_000_000;

/**
 * A path from stored memory (anyone with a workspace key can write it) as a file inside `cwd` that may be read, or
 * undefined: absolute, UNC (\\host\share would send this machine's login to that host) and ".." paths, links out of the
 * repo, folders, devices and huge files are never opened (M8, N13).
 */
export function localFile(cwd: string, p: unknown): string | undefined {
  if (!cwd || typeof p !== 'string' || !p || isAbsolute(p) || /^[\\/]{2}|^[a-z]:/i.test(p)) return undefined;
  const full = resolve(cwd, p);
  const rel = relative(resolve(cwd), full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    const real = realpathSync(full);
    const inRepo = relative(realpathSync(cwd), real);
    const s = statSync(real);
    return !inRepo.startsWith('..') && !isAbsolute(inRepo) && s.isFile() && s.size <= MAX_READ ? real : undefined;
  } catch {
    return undefined;
  }
}

/** A probe over a real checkout: file hashes, and a rename search over the repo's files (git ls-files when there is git). */
export function checkout(cwd: string): Probe {
  const hash = (p: string) => {
    const file = localFile(cwd, p);
    try {
      return file ? blobHash(lf(readFileSync(file))) : undefined;
    } catch {
      return undefined;
    }
  };
  // git's index: every tracked file with its blob id, in one call and without opening a file, at any repo size
  let index: Map<string, string> | undefined;
  const tracked = () =>
    (index ??= new Map(
      (git(['ls-files', '-s', '-z'], { cwd, timeout: 5000 }).stdout ?? '').split('\0').flatMap((e) => {
        const m = /^\d+ ([0-9a-f]{40,64}) \d\t([\s\S]+)$/.exec(e);
        return m ? [[m[2], m[1]] as [string, string]] : [];
      }),
    ));
  let files: string[] | undefined;
  const list = () => {
    if (files) return files;
    const r = git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeout: 5000 });
    files = r.status === 0 ? (r.stdout ?? '').split('\n').filter(Boolean).slice(0, MAX_SCAN) : [];
    return files;
  };
  return {
    exists: (p) => !!localFile(cwd, p),
    hash,
    sameName: (like) => {
      const name = basename(like);
      const hits = [...tracked().keys()].filter((p) => basename(p) === name && !!localFile(cwd, p));
      return hits.length === 1 ? hits[0] : undefined;
    },
    find: (want, like) => {
      // a tracked file git already knows by this id, still the same on disk
      for (const [p, id] of tracked()) if (id === want && hash(p) === want) return p;
      // same extension first (a move keeps it), then everything; only files that exist and are not huge
      const ext = extname(like);
      const pool = [...list().filter((f) => extname(f) === ext), ...list().filter((f) => extname(f) !== ext)];
      for (const f of pool) {
        try {
          if (statSync(join(cwd, f)).size > 2_000_000) continue;
        } catch {
          continue;
        }
        if (hash(f) === want) return f;
      }
      return undefined;
    },
  };
}

/** The file a "read x" / "write x" step names. */
const fileOf = (step: string) => step.match(/^(?:read|write) (.+)$/)?.[1];

export type Fresh = { steps: string[]; changed: string[]; renamed: [string, string][]; deleted: string[]; created: string[]; stale: boolean };

/**
 * Steps as they apply here: renamed files followed, deleted ones dropped, changed ones listed. A file the task only
 * wrote (never read) and that is not here was created by it: still a target ("new"), not a deleted file.
 */
export function freshen(steps: string[], saved: Record<string, string> = {}, probe: Probe): Fresh {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const created = new Set<string>();
  const moved = new Map<string, string>();
  const named = new Set(steps.map(fileOf).filter((f): f is string => !!f));
  const read = new Set(steps.filter((s) => s.startsWith('read ')).map(fileOf).filter((f): f is string => !!f));
  for (const f of named) {
    if (probe.exists(f)) {
      const was = saved[f];
      if (was && probe.hash && probe.hash(f) !== was) changed.add(f);
      continue;
    }
    const same = saved[f] && probe.find ? probe.find(saved[f], f) : undefined;
    // ponytail: moved-and-edited is found by its name only; one renamed and edited at once still reads as deleted
    const to = same ?? probe.sameName?.(f);
    if (to && !named.has(to)) {
      moved.set(f, to);
      if (!same) changed.add(to);
    } else if (read.has(f)) deleted.add(f);
    else created.add(f);
  }
  const out = steps.flatMap((s) => {
    const f = fileOf(s);
    if (!f) return [s];
    if (deleted.has(f)) return [];
    return [moved.has(f) ? s.replace(f, moved.get(f)!) : s];
  });
  return {
    steps: out,
    changed: [...changed],
    renamed: [...moved],
    deleted: [...deleted],
    created: [...created],
    // stale: most of the files it worked from are gone (files it created don't count)
    stale: read.size > 0 && deleted.size * 2 > read.size,
  };
}

/** {path: blob hash} for the files a turn touched, relative to the project (paths outside it are skipped). */
export function hashFiles(cwd: string, paths: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const rel = relative(cwd, isAbsolute(p) ? p : join(cwd, p)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..')) continue;
    try {
      out[rel] = blobHash(lf(readFileSync(join(cwd, rel))));
    } catch {
      /* deleted during the turn: nothing to remember */
    }
  }
  return out;
}
