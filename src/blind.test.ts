import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a commit cannot take a repo out of Blind mode on this laptop; the person here can', async () => {
  process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-home-'));
  const { codeSetup, forgetBlind } = await import('./blind.js');
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-blind-'));
  spawnSync('git', ['init', '-q', '.'], { cwd: repo });
  writeFileSync(join(repo, '.arcroom.json'), JSON.stringify({ code: 'blind', key: 'fp123' }));
  const root = codeSetup(repo)!.root;
  assert.equal(codeSetup(repo)!.mode, 'blind');
  writeFileSync(join(repo, '.arcroom.json'), '{}'); // a pull request drops "code": "blind"
  assert.deepEqual([codeSetup(repo)!.mode, codeSetup(repo)!.fp], ['blind', 'fp123']);
  forgetBlind(root); // arcroom code on
  assert.equal(codeSetup(repo)!.mode, 'standard');
  rmSync(repo, { recursive: true, force: true });
});
