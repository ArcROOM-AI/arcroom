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

test('a status check polled with a wait between is not a loop; fast identical repeats still are', async () => {
  const { isLoop, isPoll, POLL_GAP_MS } = await import('./loop.js');
  const poll = { command: 'gh run view 123 --json status' };
  assert.equal(isPoll('Bash', poll), true);
  assert.equal(isPoll('PowerShell', { command: 'Start-Sleep 30; gh run view 123' }), true);
  assert.equal(isPoll('Bash', { command: 'npm test' }), false);
  const now = 1_000_000;
  const waited = [{ sig: 's', at: now - 3 * POLL_GAP_MS }, { sig: 's', at: now - POLL_GAP_MS }];
  const rushed = [{ sig: 's', at: now - 2000 }, { sig: 's', at: now - 1000 }];
  assert.equal(isLoop(waited, 's', true, now), false); // waiting for CI
  assert.equal(isLoop(rushed, 's', true, now), true); // hammering it
  assert.equal(isLoop(waited, 's', false, now), true); // not a status check: blocked as before
});
