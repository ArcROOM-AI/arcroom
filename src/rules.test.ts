import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-rules-home-'));
const { alwaysOn, changedFiles, committedRuleFiles, importRulesList, onDiskFor, proposeFiles, ruleFilesOf, rulesBlock, textsOf } = await import('./rules.js');
const { RULES_HIDDEN } = await import('./flags.js');
const { TOOLS } = await import('./mcp.js');

const sh = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'arcroom-rules-repo-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@t.test');
  sh(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'packages', 'api'), { recursive: true });
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), '# Repo\nSome prose, not a rule.\n- Use pnpm, never npm.\n- Run tests first.\n```\n- inside code\n```\n');
  writeFileSync(join(root, 'packages', 'api', 'CLAUDE.md'), '- Never edit src/generated.\n');
  writeFileSync(join(root, 'AGENTS.md'), '- New endpoints need an OpenAPI entry.\n');
  writeFileSync(join(root, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\n- Tests use Vitest.\n');
  writeFileSync(join(root, '.cursor', 'rules', 'scoped.mdc'), '---\nglobs: src/**\n---\n- Only in src.\n');
  writeFileSync(join(root, 'CLAUDE.local.md'), '- Answer me in short sentences.\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  return root;
}

test('rules are hidden: no propose_rule tool while the flag is on', () => {
  assert.equal(RULES_HIDDEN, true);
  assert.equal(TOOLS.some((t) => t.name === 'propose_rule'), false);
});

test('rules files: committed CLAUDE.md, nested ones, AGENTS.md and always-on Cursor rules; scoped Cursor rules stay Cursor\'s', () => {
  const root = repo();
  try {
    assert.deepEqual(committedRuleFiles(root).sort(), ['.cursor/rules/always.mdc', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'packages/api/CLAUDE.md'].filter((p) => p !== 'CLAUDE.local.md'));
    const files = ruleFilesOf(root);
    assert.deepEqual(files.find((f) => f.path === 'CLAUDE.md')?.texts, ['Use pnpm, never npm.', 'Run tests first.']);
    assert.equal(files.some((f) => f.mine), false, 'personal files only when asked');
    assert.deepEqual(ruleFilesOf(root, true).find((f) => f.path === 'CLAUDE.local.md'), { path: 'CLAUDE.local.md', mine: true, texts: ['Answer me in short sentences.'] });
    assert.match(importRulesList(files), /CLAUDE\.md: 2 rules\n {2}- Use pnpm, never npm\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a line holding a secret is dropped; .cursorrules is read line by line', () => {
  assert.deepEqual(textsOf('CLAUDE.md', '- Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for tests.\n- Keep it short.\n'), ['Keep it short.']);
  assert.deepEqual(textsOf('.cursorrules', '# heading\nUse tabs.\n\nNo semicolons.\n'), ['Use tabs.', 'No semicolons.']);
  assert.equal(alwaysOn('---\nalwaysApply: true\n---\nx'), true);
  assert.equal(alwaysOn('---\nalwaysApply: false\n---\nx'), false);
});

test('each tool skips the files it reads itself', () => {
  const files = ['CLAUDE.md', 'packages/api/CLAUDE.md', 'AGENTS.md', '.cursor/rules/always.mdc'];
  assert.deepEqual(onDiskFor('claude', files).sort(), ['CLAUDE.local.md', 'CLAUDE.md', 'packages/api/CLAUDE.md', '~/.claude/CLAUDE.md']);
  assert.deepEqual(onDiskFor('codex', files), ['AGENTS.md']);
  assert.deepEqual(onDiskFor('cursor', files).sort(), ['.cursor/rules/always.mdc', '.cursorrules', 'AGENTS.md']);
});

test('follow: a committed change or a deleted file becomes a card; an unchanged file does not', async () => {
  const root = repo();
  const sent: any[] = [];
  const call = async (_cfg: any, path: string, body: any) => (sent.push({ path, body }), { stored: true });
  try {
    await proposeFiles({} as any, 'acme/web', ruleFilesOf(root), false, call as any);
    assert.equal(sent.length, 4);
    assert.ok(sent.every((s) => s.path === '/v1/team-rules/propose' && s.body.desk === 'acme/web' && s.body.follow === false));
    assert.deepEqual(changedFiles(root, 'acme/web'), [], 'nothing changed');
    writeFileSync(join(root, 'CLAUDE.md'), '- Use pnpm 9, never npm.\n- Run tests first.\n');
    rmSync(join(root, 'AGENTS.md'));
    assert.deepEqual(changedFiles(root, 'acme/web'), [], 'an edit nobody committed is not followed');
    sh(root, 'commit', '-qam', 'change rules');
    const changed = changedFiles(root, 'acme/web');
    assert.deepEqual(changed.map((f) => [f.path, f.texts]).sort(), [['AGENTS.md', []], ['CLAUDE.md', ['Use pnpm 9, never npm.', 'Run tests first.']]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the rules block: the room\'s answer first, the kept copy when the room is down or says unchanged', () => {
  const answer = { version: 4, text: '- Use pnpm, never npm.', chars: 21, rules: [] };
  assert.match(rulesBlock('p', answer)!, /^Rules from your team .* version 4\n.*\n- Use pnpm, never npm\.$/);
  assert.match(rulesBlock('p', undefined)!, /could not be reached, so this is the last copy/);
  assert.doesNotMatch(rulesBlock('p', { version: 4, unchanged: true } as any)!, /could not be reached/);
  assert.equal(rulesBlock('other', undefined), undefined);
});
