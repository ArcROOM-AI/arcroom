import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKeys } from './blind.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunning, rotate, toBatch, unsent, withCode } from './daemon.js';

const line = (session: string, type: string, data: object = {}) =>
  JSON.stringify({ v: 1, session, type, at: '2026-10-24T10:00:00Z', data }) + '\n';

test('numbers events per session, continuing from saved seq', () => {
  const text = line('a', 'run.start') + line('b', 'run.start') + line('a', 'prompt');
  const { events, seq } = toBatch(text, { a: 5 });
  assert.deepEqual(events.map((e) => [e.session, e.seq]), [['a', 5], ['b', 0], ['a', 6]]);
  assert.deepEqual(seq, { a: 7, b: 1 });
});

test('skips old raw lines and broken lines, stops before a half-written last line', () => {
  const full = JSON.stringify({ at: 'x', event: {} }) + '\n' + 'not json\n' + line('a', 'prompt');
  const text = full + '{"v":1,"sess';
  const { events, consumed } = toBatch(text, {});
  assert.equal(events.length, 1);
  assert.equal(consumed, full.length);
});

test('respects the batch size so the rest is sent next tick', () => {
  const text = line('a', 'prompt').repeat(5);
  const { events, consumed } = toBatch(text, {}, 2);
  assert.equal(events.length, 2);
  assert.equal(consumed, line('a', 'prompt').length * 2);
});

test('redacts secrets before upload', () => {
  const { events } = toBatch(line('a', 'prompt', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }), {});
  assert.equal((events[0].data as { prompt: string }).prompt, 'use key [REDACTED]');
});

test('a Blind repo sends no file contents, command output or plain paths', () => {
  const s = { root: '/repo', mode: 'blind' as const, keys: newKeys() };
  const setup = () => ({ s, branch: 'main' });
  const write = withCode({ type: 'tool.start', cwd: '/repo', data: { tool: 'Write', input: { file_path: '/repo/src/secret.ts', content: 'const KEY = 1' } } }, setup);
  assert.equal(write.data.input.content, undefined);
  assert.match(write.data.input.file_path, /^k_[0-9a-f]{24}$/);
  assert.equal(write.cwd, undefined);
  const out = withCode({ type: 'tool.end', cwd: '/repo', data: { tool: 'Read', output: 'file text' } }, setup);
  assert.equal(out.data.output, undefined);
  // the same event in a Standard repo keeps its content
  const std = withCode({ type: 'tool.start', cwd: '/repo', data: { tool: 'Write', input: { file_path: '/repo/a.ts', content: 'x' } } }, () => ({ s: { root: '/repo', mode: 'standard' as const }, branch: 'main' }));
  assert.equal(std.data.input.content, 'x');
});

test('a fully sent queue is moved aside, read to its end, then deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-spool-'));
  const spool = join(dir, 'spool.jsonl');
  const sending = join(dir, 'spool.sending.jsonl');
  writeFileSync(spool, 'abc\n');
  assert.equal(rotate({ offset: 2, seq: {} }, spool, sending).offset, 2); // not all sent: stays
  assert.ok(existsSync(spool) && !existsSync(sending));
  rotate({ offset: 4, seq: {} }, spool, sending); // all sent: moved aside
  assert.ok(!existsSync(spool) && existsSync(sending));
  writeFileSync(sending, 'abc\nlate\n'); // a hook appended in that moment
  assert.equal(rotate({ offset: 4, seq: {} }, spool, sending).offset, 4); // its tail is read first
  assert.equal(rotate({ offset: 9, seq: {} }, spool, sending).offset, 0); // then it goes and the new queue starts at 0
  assert.ok(!existsSync(sending));
  rmSync(dir, { recursive: true, force: true });
});

test('a daemon counts as running only when its PID also wrote the heartbeat lately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-pid-'));
  const pid = join(dir, 'daemon.pid');
  const beat = join(dir, 'daemon.beat');
  const other = process.ppid; // a live process that is not this one
  writeFileSync(pid, String(other));
  assert.equal(isRunning(pid, beat), false); // no heartbeat: a reused PID, not our daemon
  writeFileSync(beat, String(other));
  assert.equal(isRunning(pid, beat), true);
  assert.equal(isRunning(pid, beat, Date.now() + 10 * 60_000), false); // heartbeat too old
  writeFileSync(beat, '12345');
  assert.equal(isRunning(pid, beat), false); // the heartbeat is another PID's
  rmSync(dir, { recursive: true, force: true });
});

test('unsent counts the moved-aside rest and the new queue', () => {
  const d = mkdtempSync(join(tmpdir(), 'arcroom-unsent-'));
  const spool = join(d, 'spool.jsonl');
  const sending = join(d, 'sending.jsonl');
  writeFileSync(spool, 'a\n'.repeat(5));
  assert.equal(unsent({ offset: 4, seq: {} }, spool, sending), 6);
  writeFileSync(sending, 'b\n'.repeat(3));
  assert.equal(unsent({ offset: 6, seq: {} }, spool, sending), 10); // sending fully sent; the new queue is not
  assert.equal(unsent({ offset: 6, seq: {} }, join(d, 'none'), sending), 0);
});
