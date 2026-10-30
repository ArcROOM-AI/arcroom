import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

test('doctor names each problem with its fix and exits non-zero on a failure', () => {
  const home = mkdtempSync(join(tmpdir(), 'arcroom-doctor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-doctor-repo-'));
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'ark_doctortest', url: 'http://127.0.0.1:9' }));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node "C:/u/.arcroom/runtime/index.js" hook' }] }] } }));
    // run from the repo, never from a folder holding `home` (home.ts would ignore ARCROOM_HOME)
    const run = spawnSync(process.execPath, [entry, 'doctor'], { cwd, env: { ...process.env, ARCROOM_HOME: home }, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /ok +key ark_doct/);
    assert.match(run.stdout, /FAIL +API http:\/\/127\.0\.0\.1:9 did not answer/);
    assert.match(run.stdout, /FAIL +no hook runtime[\s\S]*→ arcroom init/);
    assert.match(run.stdout, /ok +this folder is set up for Claude Code/);
  } finally {
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('doctor with no key says to run init', () => {
  const home = mkdtempSync(join(tmpdir(), 'arcroom-doctor-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-doctor-repo-'));
  try {
    const run = spawnSync(process.execPath, [entry, 'doctor'], { cwd, env: { ...process.env, ARCROOM_HOME: home }, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL +no key on this laptop[\s\S]*arcroom init/);
  } finally {
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
