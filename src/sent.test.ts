import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-sent-'));
const { KEEP_DAYS, logSent, sentReport } = await import('./sent.js');

test('what was sent is kept per day for a week, and arcroom sent shows it exactly', () => {
  const dir = join(process.env.ARCROOM_HOME!, 'sent');
  const now = new Date('2026-10-30T12:00:00Z');
  const events = [
    { v: 1, at: '2026-10-30T11:58:00Z', type: 'prompt', cwd: 'C:/work/app', data: { prompt: 'my password is [REDACTED]' } },
    { v: 1, at: '2026-10-30T11:59:00Z', type: 'tool.start', cwd: 'C:/work/app', data: { tool: 'Read', input: { file_path: '[secret file]' } } },
  ];
  logSent(events, now);
  const old = join(dir, '2026-10-01.jsonl');
  writeFileSync(old, '{}\n');
  logSent([{ v: 1, at: '2026-10-30T11:59:30Z', type: 'turn.end', cwd: 'C:/work/app', data: {} }], now);
  assert.equal(existsSync(old), false, `days older than ${KEEP_DAYS} are dropped`);
  const report = sentReport([], now);
  assert.match(report, /Sent on 2026-10-30: 3 events from 1 folder/);
  assert.match(report, /1 prompts, 1 tool calls/);
  assert.match(report, /1 values redacted, 1 secret-file paths hidden/);
  const all = sentReport(['--all'], now).split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(all.slice(0, 2), events); // exactly what went out
  assert.match(sentReport(['2026-10-29'], now), /Nothing was sent on 2026-10-29/);
});
