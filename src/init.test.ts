import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.equal(s.hooks!.PostToolUse[0].matcher, 'Bash|PowerShell|mcp__arcroom__.*|mcp__plugin_arcroom_arcroom__.*');
  for (const tool of ['Bash', 'PowerShell', 'mcp__arcroom__find_task', 'mcp__plugin_arcroom_arcroom__find_task'])
    assert.match(tool, new RegExp(`^(${AFTER_TOOLS})$`));
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

// CLAUDE.md and AGENTS.md hold the team's rules and stay their only owner: ArcRoom never rewrites or hides them, and no
// hook turns a line of them into a fact, a how-to or a playbook. Only `arcroom import --all`, run by a person who sees
// the list and says yes, reads them (never writes). (init() itself needs the API, so its repo step is run here)
test('init leaves CLAUDE.md and AGENTS.md byte for byte as they were, and in plain sight of git', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-mdfiles-'));
  git(['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'CLAUDE.md'), '# Rules\r\n- use pnpm, never npm\r\n');
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n- run the tests before you stop\n');
  git(['add', 'CLAUDE.md'], { cwd: repo }); // one the team commits, one it keeps local
  const before = ['CLAUDE.md', 'AGENTS.md'].map((f) => readFileSync(join(repo, f)));
  mkdirSync(join(repo, '.claude'));
  for (const f of [join('.claude', 'settings.local.json'), '.mcp.json']) writeFileSync(join(repo, f), '{}');
  keepOutOfGit([join(repo, '.claude', 'settings.local.json'), join(repo, '.mcp.json')], repo);
  ['CLAUDE.md', 'AGENTS.md'].forEach((f, i) => assert.ok(readFileSync(join(repo, f)).equals(before[i]), `${f} changed`));
  assert.doesNotMatch(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /\.md$/m);
  assert.equal(git(['diff', '--name-only'], { cwd: repo }).stdout, '');
  assert.match(git(['status', '--porcelain'], { cwd: repo }).stdout ?? '', /^\?\? AGENTS\.md$/m);
});

test('no plugin code writes CLAUDE.md or AGENTS.md, and only arcroom import reads them (tests and comments may name them)', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url)); // the tests run from dist/
  const code = readdirSync(src)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')] as const);
  assert.ok(code.length > 20);
  for (const [f, text] of code) {
    if (f !== 'import.ts') assert.doesNotMatch(text, /\b(CLAUDE|AGENTS)\.md\b/i, f);
    assert.doesNotMatch(text, /(write|append|rm|unlink|rename|copy)\w*\([^)]*\.md\b/i, f);
  }
  // import only reads: no write call of any kind in it
  const imp = code.find(([f]) => f === 'import.ts')![1];
  assert.doesNotMatch(imp, /\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|createWriteStream)\b/);
});
