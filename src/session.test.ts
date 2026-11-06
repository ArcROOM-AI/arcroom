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
  const note = lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'done', mine: false, prompt: 'fix the login page', report: {} }, now);
  assert.match(note, /a teammate's last session/);
});

test('a session with nothing asked and nothing edited is not handed over', () => {
  assert.equal(lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'running', mine: true, report: {} }, now), '');
});

test('a session that never closed: unfinished, with the files it edited', () => {
  const note = lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'running', mine: true, prompt: 'migrate the db', edited: ['/repo/db/migrate.ts', '/repo/db/migrate.ts'] }, now, '/repo');
  assert.match(note, /never closed \(it stopped mid-way\): treat its work as unfinished/);
  assert.match(note, /Edited: db\/migrate\.ts\n/);
  assert.doesNotMatch(note, /tool calls/);
});

test('a long ask is handed over whole, so its last steps are not lost', () => {
  const ask = `Go through every email. 1) ${'tag each one. '.repeat(20)}3) In replies/, draft a reply to each angry customer.`;
  const note = lastRunContext({ started_at: '2026-10-25T11:00:00Z', status: 'running', prompt: ask }, now);
  assert.ok(ask.length > 200);
  assert.match(note, /3\) In replies\/, draft a reply to each angry customer\."/);
});

test('open now: teammates sessions and unfinished claims, short; the last-run run is not repeated; empty is no block', async () => {
  const { openNowContext } = await import('./session.js');
  assert.equal(openNowContext(undefined), undefined);
  assert.equal(openNowContext({ open: [], unfinished: [] }), undefined);
  const o = {
    open: [
      { run_id: 'r1', machine: 'laptop-a', ask: 'now the invoice total', files: ['billing/tax.ts'], state: 'working', minutes: 4, branch: 'main' },
      { run_id: 'r2', machine: 'laptop-b', ask: 'answer a question', files: [], state: 'your_turn', minutes: 12, branch: 'feat/x' },
      { run_id: 'r3', machine: 'laptop-c', ask: 'already in the last-run note', files: [], state: 'working', minutes: 1 },
    ],
    unfinished: [
      { task: 'migrate billing tables', machine: 'laptop-a', state: 'in_progress', minutes: 2 },
      { task: 'split usage by model', machine: 'laptop-a', state: 'claim_lapsed', minutes: 1140 },
    ],
  };
  const note = openNowContext(o, 'r3', 'main')!;
  assert.equal(
    note,
    [
      'ArcRoom: open now from teammates on this repo (their sessions as of this session start):',
      '- laptop-a · "now the invoice total" · billing/tax.ts · working, 4 min ago',
      '- laptop-b · "answer a question" · waiting for its person, 12 min ago (branch feat/x)',
      'Unfinished work they claimed:',
      '- "migrate billing tables" · laptop-a · in progress (claimed 2 min ago)',
      '- "split usage by model" · laptop-a · claim lapsed, safe to take (claimed 19 h ago)',
    ].join('\n'),
  );
  const many = openNowContext({ open: Array.from({ length: 9 }, (_, i) => ({ run_id: `x${i}`, ask: 'a', state: 'working', minutes: 1 })) })!;
  assert.equal(many.split('\n').length, 1 + 5, 'at most 5 sessions');
});

test('clash: the same file or the same task flags; different files and tasks do not', async () => {
  const { clashLine, sameTask } = await import('./session.js');
  const o = {
    open: [{ run_id: 'r1', machine: 'laptop-a', ask: 'free plan for old accounts', files: ['migrations/0069_free_plan_row.sql'], state: 'working', minutes: 4 }],
    unfinished: [
      { task: 'migrate billing tables', machine: 'laptop-c', state: 'in_progress', minutes: 3 },
      { task: 'split usage by model', machine: 'laptop-c', state: 'claim_lapsed', minutes: 90 },
    ],
  };
  // same task by words
  assert.match(clashLine('fix the free plan on sign-up for accounts', o)!, /^ArcRoom: a teammate on laptop-a is already on this: "free plan for old accounts", working 4 min ago\. Check with them/);
  // same file, named any way
  assert.match(clashLine('look at C:\\repo\\migrations\\0069_free_plan_row.sql please', o)!, /\(editing migrations\/0069_free_plan_row\.sql\)/);
  assert.match(clashLine('what does 0069_free_plan_row.sql do', o)!, /editing/);
  // claimed tasks: still held, or lapsed and free to take
  assert.match(clashLine('Migrate the billing tables to the new schema', o)!, /claimed this 3 min ago and is still on it/);
  assert.match(clashLine('split the usage by model', o)!, /left unfinished \(the claim lapsed\): you may take it over/);
  // different work: nothing
  assert.equal(clashLine('update the README install section', o), undefined);
  assert.equal(clashLine('fix the plan', o), undefined, 'one shared word is not enough');
  assert.equal(clashLine('anything', undefined), undefined);
  assert.equal(sameTask('add the dark mode toggle', 'dark mode toggle in settings'), true);
  assert.equal(sameTask('fix the login bug', 'fix the signup bug'), false, 'filler words do not count');
});

test('teammates show by the name they signed up with, else by machine', async () => {
  const { clashLine, openNowContext } = await import('./session.js');
  const o = {
    open: [
      { run_id: 'r1', name: 'Asha', machine: 'BlueFlare', ask: 'fix the invoice total', files: [], state: 'working', minutes: 2 },
      { run_id: 'r2', machine: 'BlueFlare', ask: 'dark mode toggle', files: [], state: 'working', minutes: 3 },
    ],
    unfinished: [{ task: 'migrate billing tables', name: 'Asha', machine: 'BlueFlare', state: 'claim_lapsed', minutes: 40 }],
  };
  const note = openNowContext(o)!;
  assert.match(note, /^- Asha · "fix the invoice total"/m);
  assert.match(note, /^- BlueFlare · "dark mode toggle"/m, 'no name: the machine');
  assert.match(note, /"migrate billing tables" · Asha · claim lapsed/);
  assert.match(clashLine('the invoice total is wrong', o)!, /^ArcRoom: Asha is already on this/);
  assert.match(clashLine('migrate the billing tables', { unfinished: o.unfinished })!, /was claimed by Asha 40 min ago/);
  assert.doesNotMatch(note, /@/);
});
