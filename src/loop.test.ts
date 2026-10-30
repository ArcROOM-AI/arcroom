import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoop, signature } from './loop.js';

test('signature ignores key order but not values or tool', () => {
  assert.equal(signature('Bash', { a: 1, b: [1, { c: 2, d: 3 }] }), signature('Bash', { b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(signature('Bash', { command: 'ls' }), signature('Bash', { command: 'ls -a' }));
  assert.notEqual(signature('Bash', { path: 'x' }), signature('Read', { path: 'x' }));
});

test('the 3rd identical call in a row is a loop; a different call in between resets it', () => {
  const a = signature('Bash', { command: 'ls' });
  const b = signature('Bash', { command: 'pwd' });
  assert.equal(isLoop([], a), false);
  assert.equal(isLoop([a], a), false);
  assert.equal(isLoop([a, a], a), true);
  assert.equal(isLoop([a, b], a), false);
  assert.equal(isLoop([b, a], a), false);
});
