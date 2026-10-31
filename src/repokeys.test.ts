import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-repokeys-'));
const { loadConfig } = await import('./home.js');
const { git, projectOf } = await import('./git.js');
const { keysAfterInit } = await import('./init.js');
const { byKey } = await import('./daemon.js');

const repoAt = (remote: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-client-'));
  git(['init', '-q'], { cwd: dir });
  git(['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
};

test("a second client's repo gets its own key; every other repo keeps the default", () => {
  const a = repoAt('https://github.com/client-a/app.git');
  const b = repoAt('git@github.com:client-b/site.git');
  let cfg = keysAfterInit({}, projectOf(a), 'ark_aaaa1111', 'https://api.example.com', 'Client A');
  cfg = keysAfterInit(cfg, projectOf(b), 'ark_bbbb2222', 'https://api.example.com', 'Client B');
  assert.equal(cfg.apiKey, 'ark_aaaa1111');
  assert.deepEqual(cfg.repos, { 'github.com/client-b/site': { apiKey: 'ark_bbbb2222', workspace: 'Client B' } });
  writeFileSync(join(process.env.ARCROOM_HOME!, 'config.json'), JSON.stringify(cfg));
  assert.equal(loadConfig(b).apiKey, 'ark_bbbb2222');
  assert.equal(loadConfig(a).apiKey, 'ark_aaaa1111');
  assert.equal(loadConfig().apiKey, 'ark_aaaa1111');
  // the uploader sends each repo's events with that repo's key
  const groups = byKey([{ cwd: a, n: 1 }, { cwd: b, n: 2 }, { cwd: a, n: 3 }], (cwd) => loadConfig(cwd));
  assert.deepEqual(groups.map((g) => [g.cfg.apiKey, g.events.map((e) => e.n)]), [['ark_aaaa1111', [1, 3]], ['ark_bbbb2222', [2]]]);
  // a new key for the same workspace replaces the default, and that repo has no key of its own any more
  const again = keysAfterInit(cfg, projectOf(b), 'ark_cccc3333', 'https://api.example.com', 'Client A');
  assert.equal(again.apiKey, 'ark_cccc3333');
  assert.equal(again.repos, undefined);
});
