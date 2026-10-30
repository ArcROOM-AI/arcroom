import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumUsage, tokensOf } from './usage.js';

const line = (id: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
  }) + '\n';

test('counts each message once even when it spans several lines', () => {
  const text = line('m1', 2, 268, 48080, 23944) + line('m1', 2, 268, 48080, 23944) + JSON.stringify({ type: 'user' }) + '\n' + line('m2', 5, 10);
  const { usage, consumed } = sumUsage(text, new Set());
  assert.deepEqual(usage, { input: 7, output: 278, cache_read: 48080, cache_write: 23944, model: 'claude-sonnet-5-5' });
  assert.equal(consumed, text.length);
  assert.equal(tokensOf(usage), 7 + 278 + 48080 + 23944);
});

test('skips ids already counted and stops before a half-written line', () => {
  const seen = new Set(['m1']);
  const text = line('m1', 2, 268) + line('m3', 1, 1) + '{"type":"assistant","mess';
  const { usage, consumed } = sumUsage(text, seen);
  assert.equal(usage.output, 1);
  assert.equal(consumed, text.lastIndexOf('\n') + 1);
  assert.ok(seen.has('m3'));
});
