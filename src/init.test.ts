import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withArcroomHooks } from './init.js';

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
