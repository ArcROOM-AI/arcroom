import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFor, statusText, toolResult } from './signs.js';

test('reads the JSON out of an MCP tool response, or the ArcRoom error', () => {
  const blocks = [{ type: 'text', text: '{"match":"reuse"}' }];
  assert.deepEqual(toolResult(blocks), { match: 'reuse' });
  assert.deepEqual(toolResult({ content: blocks }), { match: 'reuse' });
  assert.deepEqual(toolResult('{"version":2}'), { version: 2 });
  assert.deepEqual(toolResult([{ type: 'text', text: 'ArcRoom error: invalid api key' }]), { error: 'invalid api key' });
  assert.equal(toolResult([{ type: 'image' }]), undefined);
});

test('one clear line per action, with the counter it bumps', () => {
  const reuse = signFor('find_task', {}, { match: 'reuse', intent: 'list breaking changes: react 19', version: { verified: true } });
  assert.deepEqual(reuse, { message: 'ArcRoom · reused a team answer (verified): list breaking changes: react 19', stat: 'reused' });
  assert.equal(signFor('find_task', {}, { match: 'replay', intent: 'x' })?.stat, 'replayed');
  assert.match(signFor('find_task', { intent: 'y' }, { match: 'none', candidates: [] })!.message, /new task, nothing stored yet: y/);
  assert.match(signFor('find_task', {}, { match: 'none', candidates: [{}, {}] })!.message, /2 similar to check/);
  assert.match(signFor('find_task', {}, { match: 'replay', intent: 'x', evicted_stale: ['package.json'] })!.message, /file changed \(package\.json\)/);
  assert.deepEqual(signFor('complete_task', {}, { version: 3 }), { message: 'ArcRoom · saved to team memory (v3)', stat: 'saved' });
  assert.match(signFor('evict_task', {}, { evicted: 1, cascaded: 2 })!.message, /threw away 1 answer\(s\) \+ 2 built on them/);
  assert.match(signFor('claim_task', {}, { claimed: false, claimed_by: 'laptop-b:9' })!.message, /already taken by laptop-b:9/);
  assert.match(signFor('find_task', {}, { error: 'invalid api key' })!.message, /ArcRoom · invalid api key/);
  assert.equal(signFor('find_task', {}, undefined), undefined);
});

test('status line shows live plus only the counters that moved', () => {
  const none = { reused: 0, replayed: 0, saved: 0, blocked: 0, evicted: 0, tokens_saved: 0 };
  assert.equal(statusText(none), 'ArcRoom · live');
  assert.equal(statusText({ ...none, reused: 2, saved: 1, blocked: 1 }), 'ArcRoom · live · 2 reused · 1 saved · 1 blocked');
  // tokens used this session and saved by reuse come first
  assert.equal(statusText({ ...none, reused: 1, tokens_saved: 46781 }, 48213), 'ArcRoom · live · 48.2k tokens used · 46.8k saved · 1 reused');
  assert.equal(statusText(none, 1_250_000), 'ArcRoom · live · 1.3M tokens used');
});

test('split line says how many parts are already done', () => {
  const r = { parts: [{}, {}, {}], counts: { reuse: 2, none: 1 } };
  assert.equal(signFor('split_task', {}, r)?.message, 'ArcRoom · split into 3 parts: 2 already done, 1 new');
});
