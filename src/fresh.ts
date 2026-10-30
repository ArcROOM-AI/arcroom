import { git } from './git.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

// Is a stored memory still true for this checkout? Steps keep the git blob hash of each file they touched (taken on
// the laptop at the end of the turn; hashes only, no content). Before handing steps over, each file is looked up here:
//   same hash   → as it was
//   other hash  → changed since: kept, flagged so the agent checks before trusting it
//   missing     → renamed if a file here has the saved hash (followed to its new path); otherwise deleted (dropped)
//                 when the task read it, or created by the task when it only wrote it (still a target)
// More than half the files it read deleted: the steps are stale and nothing is handed over. All local, no network.

/** Git's blob id for a file's bytes (the same id `git hash-object` prints), so it works with or without git. */
export const blobHash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export type Probe = {
  exists: (path: string) => boolean;
  hash?: (path: string) => string | undefined;
  /** a file here with this hash, other than the given paths (for renames) */
  find?: (hash: string, like: string) => string | undefined;
};

const MAX_SCAN = 2000; // ponytail: rename search hashes candidate files; index blob ids instead if repos get huge
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
      return file ? blobHash(readFileSync(file)) : undefined;
    } catch {
      return undefined;
    }
  };
  let files: string[] | undefined;
  const list = () => {
    if (files) return files;
    const r = git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeout: 1500 });
    files = r.status === 0 ? (r.stdout ?? '').split('\n').filter(Boolean).slice(0, MAX_SCAN) : [];
    return files;
  };
  return {
    exists: (p) => !!localFile(cwd, p),
    hash,
    find: (want, like) => {
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
    const to = saved[f] && probe.find ? probe.find(saved[f], f) : undefined;
    if (to && !named.has(to)) moved.set(f, to);
    else if (read.has(f)) deleted.add(f);
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
      out[rel] = blobHash(readFileSync(join(cwd, rel)));
    } catch {
      /* deleted during the turn: nothing to remember */
    }
  }
  return out;
}
