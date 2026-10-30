import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { git, gitPath } from './git.js';

test('git is found by full path on PATH, never as a relative or planted name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-git-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  writeFileSync(join(bin, name), '');
  assert.equal(gitPath(['.', 'relative/bin', bin].join(delimiter)), join(bin, name)); // relative PATH entries skipped
  assert.equal(gitPath(['.', ''].join(delimiter)), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a repo's core.fsmonitor command never runs through ArcRoom's git calls", () => {
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-fsm-'));
  const marker = join(repo, 'PWNED');
  git(['init', '-q', '.'], { cwd: repo });
  git(['config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"`], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(['status', '--porcelain', '-uall'], { cwd: repo });
  git(['ls-files', '--others'], { cwd: repo });
  assert.equal(existsSync(marker), false);
  rmSync(repo, { recursive: true, force: true });
});
