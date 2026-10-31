import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-scope-home-'));
const { git, projectOf } = await import('./git.js');
const { laptopHookActs, projectHooksAbove, setUpHere } = await import('./scope.js');

test('laptop-wide hooks act only in set-up repos, and step aside where project hooks already run', () => {
  const clone = mkdtempSync(join(tmpdir(), 'arcroom-clone-'));
  git(['init', '-q'], { cwd: clone });
  git(['remote', 'add', 'origin', 'https://github.com/team/app.git'], { cwd: clone });
  const other = mkdtempSync(join(tmpdir(), 'arcroom-other-'));
  git(['init', '-q'], { cwd: other });
  git(['remote', 'add', 'origin', 'https://github.com/someone/else.git'], { cwd: other });
  writeFileSync(join(process.env.ARCROOM_HOME!, 'config.json'), JSON.stringify({ apiKey: 'ark_x', setUp: [projectOf(clone)] }));
  assert.equal(setUpHere(clone), true);
  assert.equal(laptopHookActs(clone), true); // a second clone of a set-up repo: covered
  assert.equal(laptopHookActs(other), false); // never set up: not traced
  const sub = join(clone, 'packages', 'web');
  mkdirSync(join(clone, '.claude'), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(clone, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node "C:/u/.arcroom/runtime/index.js" hook' }] }] } }));
  assert.equal(projectHooksAbove(sub), true);
  assert.equal(laptopHookActs(sub), false); // the project's own hooks run here: not twice
});
