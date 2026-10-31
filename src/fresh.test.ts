import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobHash, freshen, lf, localFile, type Probe } from './fresh.js';

test('blobHash is the id git gives the bytes', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(blobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

const here = (files: Record<string, string>): Probe => ({
  exists: (p) => p in files,
  hash: (p) => files[p],
  find: (h) => Object.keys(files).find((f) => files[f] === h),
});

const steps = ['read src/a.js', 'read src/b.js', 'run npm test', 'write src/a.js', 'write src/new.js'];
const saved = { 'src/a.js': 'A', 'src/b.js': 'B', 'src/new.js': 'N' };

test('same files: steps as they were', () => {
  const f = freshen(steps, saved, here({ 'src/a.js': 'A', 'src/b.js': 'B', 'src/new.js': 'N' }));
  assert.deepEqual(f.steps, steps);
  assert.equal(f.stale, false);
  assert.deepEqual([f.changed, f.renamed, f.deleted], [[], [], []]);
});

test('a renamed file is followed to its new path; a changed one is flagged', () => {
  const f = freshen(steps, saved, here({ 'lib/a.js': 'A', 'src/b.js': 'B2', 'src/new.js': 'N' }));
  assert.deepEqual(f.renamed, [['src/a.js', 'lib/a.js']]);
  assert.deepEqual(f.changed, ['src/b.js']);
  assert.deepEqual(f.steps, ['read lib/a.js', 'read src/b.js', 'run npm test', 'write lib/a.js', 'write src/new.js']);
});

test('a deleted file is dropped; most of them gone is stale; a created file missing is still a target', () => {
  const one = freshen(steps, saved, here({ 'src/a.js': 'A' }));
  assert.deepEqual(one.deleted, ['src/b.js']);
  assert.deepEqual(one.created, ['src/new.js']);
  assert.equal(one.stale, false); // 1 of the 2 files it read
  assert.ok(!one.steps.includes('read src/b.js'));
  assert.equal(freshen(steps, saved, here({})).stale, true);
});

test('paths from stored memory are read only inside the repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-local-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'x');
  assert.equal(localFile(repo, 'src/a.ts'), realpathSync(join(repo, 'src', 'a.ts')));
  for (const p of ['../outside.txt', '/etc/passwd', 'C:/Windows/win.ini', String.raw`\\evil.com\s\x`, '//evil.com/s/x', 'src', '', 'src/../../x'])
    assert.equal(localFile(repo, p), undefined, p);
  rmSync(repo, { recursive: true, force: true });
});

test('a file hashes the same with Windows or Mac line ends; a binary file is left as it is', () => {
  assert.equal(blobHash(lf(Buffer.from('a\r\nb\r\n'))), blobHash(Buffer.from('a\nb\n')));
  const bin = Buffer.from([0, 13, 10, 1]);
  assert.deepEqual(lf(bin), bin);
});

test('a file moved and edited is followed by its name and flagged as changed', () => {
  const files = { 'lib/a.js': 'A2', 'src/b.js': 'B', 'src/new.js': 'N' };
  const f = freshen(steps, saved, { ...here(files), sameName: (p) => Object.keys(files).find((k) => k.endsWith(`/${p.split('/').pop()}`)) });
  assert.deepEqual(f.renamed, [['src/a.js', 'lib/a.js']]);
  assert.deepEqual(f.changed, ['lib/a.js']);
  assert.equal(f.stale, false);
});

test("a big repo's moved file is found through git's index, not a capped scan", async () => {
  const { checkout } = await import('./fresh.js');
  const { git } = await import('./git.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'arcroom-index-')));
  if (git(['init', '-q'], { cwd: dir }).status !== 0) return; // no git here
  mkdirSync(join(dir, 'pad'));
  for (let i = 0; i < 2500; i++) writeFileSync(join(dir, 'pad', `f${i}.txt`), String(i));
  mkdirSync(join(dir, 'zz'));
  writeFileSync(join(dir, 'zz', 'moved.ts'), 'export const x = 1;\n');
  git(['add', '-A'], { cwd: dir });
  const want = blobHash(Buffer.from('export const x = 1;\n'));
  assert.equal(checkout(dir).find!(want, 'src/moved.ts'), 'zz/moved.ts');
  rmSync(dir, { recursive: true, force: true });
});
