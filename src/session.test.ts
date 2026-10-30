import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRunContext } from './session.js';

const now = new Date('2026-10-25T12:00:00Z');

test('summarises the last run: when, outcome, ask, edited files, activity', () => {
  const note = lastRunContext(
    {
      started_at: '2026-10-25T10:00:00Z',
      machine: 'laptop-a',
      status: 'partial',
      report: {
        first_prompt: 'add the loop guard',
        tool_calls: 48,
        blocked: 1,
        files: [
          { path: 'packages/plugin/src/hook.ts', edited: true },
          { path: 'README.md', edited: false },
          { path: 'C:\\repo\\loop.ts', edited: true },
        ],
        memory: { find: 3, complete: 1 },
      },
    },
    now,
  );
  assert.match(note, /2 h ago, on laptop-a/);
  assert.match(note, /PARTIAL/);
  assert.match(note, /Asked: "add the loop guard"/);
  assert.match(note, /Edited: hook\.ts, loop\.ts\n/);
  assert.match(note, /48 tool calls, 1 blocked by the loop guard, memory: 3 lookups, 1 stored/);
});

test('works with a bare run (no report fields)', () => {
  const note = lastRunContext({ started_at: '2026-10-25T11:55:00Z', status: 'done', prompt: 'hi' }, now);
  assert.match(note, /5 min ago, on another machine\) ended done/);
  assert.match(note, /Asked: "hi"/);
  assert.doesNotMatch(note, /Edited/);
});
