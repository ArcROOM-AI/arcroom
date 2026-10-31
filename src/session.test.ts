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
    'C:\\repo',
  );
  assert.match(note, /2 h ago, on laptop-a/);
  assert.match(note, /PARTIAL/);
  assert.match(note, /Asked: "add the loop guard"/);
  assert.match(note, /Edited: packages\/plugin\/src\/hook\.ts, loop\.ts\n/);
  assert.match(note, /48 tool calls, 1 blocked by the loop guard, memory: 3 lookups, 1 stored/);
});

test('works with a bare run (no report fields)', () => {
  const note = lastRunContext({ started_at: '2026-10-25T11:55:00Z', status: 'done', prompt: 'hi' }, now);
  assert.match(note, /5 min ago, on another machine\) ended done/);
  assert.match(note, /Asked: "hi"/);
  assert.doesNotMatch(note, /Edited/);
});

test('your own unfinished run on this branch: last ask, the check still failing, repo paths', () => {
  const note = lastRunContext(
    {
      started_at: '2026-10-25T11:00:00Z', machine: 'laptop-b', status: 'running', mine: true, branch: 'feature-x',
      last_prompt: 'now make the test pass', failing_check: 'npm test',
      report: { first_prompt: 'add a clear command', files: [{ path: '/home/b/work/app/src/clear.ts', edited: true }] },
    },
    now,
    'C:/Users/a/app',
  );
  assert.match(note, /your last session in this project \(1 h ago, on laptop-b, branch feature-x\) never closed/);
  assert.match(note, /Last asked: "now make the test pass"/);
  assert.match(note, /Still failing: `npm test`/);
  assert.match(note, /Edited: app\/src\/clear\.ts/);
});

test("a teammate's run says so", () => {
  const note = lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'done', mine: false, report: {} }, now);
  assert.match(note, /a teammate's last session/);
});

test('a session that never closed: unfinished, with the files it edited', () => {
  const note = lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'running', mine: true, prompt: 'migrate the db', edited: ['/repo/db/migrate.ts', '/repo/db/migrate.ts'] }, now, '/repo');
  assert.match(note, /never closed \(it stopped mid-way\): treat its work as unfinished/);
  assert.match(note, /Edited: db\/migrate\.ts\n/);
});
