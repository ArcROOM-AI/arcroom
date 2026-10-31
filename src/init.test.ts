import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git.js';
import { AFTER_TOOLS, keepOutOfGit, withArcroomHooks } from './init.js';

test('adds ArcRoom to every event, keeps other hooks, and is idempotent', () => {
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] };
  const start = { model: 'x', hooks: { PreToolUse: [theirs] } };
  const command = 'node "/home/me/.arcroom/runtime/index.js" hook';

  const once = withArcroomHooks(start, command);
  const twice = withArcroomHooks(once, command);

  assert.deepEqual(twice, once);
  assert.equal(once.model, 'x');
  assert.deepEqual(once.hooks!.PreToolUse[0], theirs);
  assert.equal(once.hooks!.PreToolUse.length, 2);
  assert.equal(Object.keys(once.hooks!).length, 6);
  assert.equal(once.hooks!.Stop[0].matcher, undefined);
});

test('after a tool, the hook runs only for shell and ArcRoom tools; before a tool, for every tool', () => {
  const s = withArcroomHooks({}, 'node "/home/u/.arcroom/runtime/index.js" hook', '*', AFTER_TOOLS);
  assert.equal(s.hooks!.PreToolUse[0].matcher, '*');
  assert.equal(s.hooks!.PostToolUse[0].matcher, 'Bash|PowerShell|mcp__arcroom__.*');
  for (const tool of ['Bash', 'PowerShell', 'mcp__arcroom__find_task']) assert.match(tool, new RegExp(`^(${AFTER_TOOLS})$`));
  for (const tool of ['Read', 'Edit', 'Grep']) assert.doesNotMatch(tool, new RegExp(`^(${AFTER_TOOLS})$`));
});

test('files init wrote that git does not track are kept out of commits in this clone only, once', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-exclude-'));
  git(['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.cursor'));
  writeFileSync(join(repo, '.cursor', 'mcp.json'), '{}');
  writeFileSync(join(repo, 'opencode.json'), '{}');
  git(['add', 'opencode.json'], { cwd: repo }); // the team already tracks this one
  const files = [join(repo, '.cursor', 'mcp.json'), join(repo, 'opencode.json')];
  assert.deepEqual(keepOutOfGit(files, repo), ['/.cursor/mcp.json']);
  assert.deepEqual(keepOutOfGit(files, repo), []); // a second init adds nothing
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.cursor\/mcp\.json$/m);
  assert.equal(git(['status', '--porcelain'], { cwd: repo }).stdout?.includes('.cursor'), false);
});
