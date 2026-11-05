import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the hand-over log keeps titles and sizes per day, skips empty hand-overs and drops days after 7', async () => {
  process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-'));
  const { HANDED_DIR, logHanded } = await import('./handed.js');
  const now = new Date('2026-11-06T10:00:00Z');
  mkdirSync(HANDED_DIR, { recursive: true });
  writeFileSync(join(HANDED_DIR, '2026-10-30.jsonl'), '{}\n'); // 8 days old

  logHanded({ session: 's', when: 'prompt', handed: [], cut: [] }, now);
  assert.ok(!existsSync(join(HANDED_DIR, '2026-11-06.jsonl')), 'nothing found: no entry');

  logHanded(
    {
      session: 's',
      cwd: 'C:\\repo',
      when: 'prompt',
      handed: [{ kind: 'knowledge', title: `decision: ${'x'.repeat(200)}`, chars: 640 }],
      cut: [{ kind: 'code', title: 'code map', chars: 900, reason: 'over budget' }],
    },
    now,
  );
  const [entry] = readFileSync(join(HANDED_DIR, '2026-11-06.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entry.at, now.toISOString());
  assert.equal(entry.handed[0].chars, 640);
  assert.equal(entry.handed[0].title.length, 120, 'titles are clipped');
  assert.equal(entry.cut[0].reason, 'over budget');
  assert.ok(!existsSync(join(HANDED_DIR, '2026-10-30.jsonl')), 'kept 7 days, like sent');
});

test('arcroom handed: the newest hand-over by default, --last N across days, a plain line when there is none', async () => {
  const { handedReport } = await import('./handed.js');
  const dir = mkdtempSync(join(tmpdir(), 'handed-'));
  assert.match(handedReport([], dir), /^Nothing was handed over yet/);

  const e = (at: string, when: string, title: string) =>
    JSON.stringify({ at, session: 's', cwd: 'C:\\repo', when, handed: [{ kind: 'knowledge', title, chars: 300 }], cut: [] });
  writeFileSync(join(dir, '2026-11-05.jsonl'), e('2026-11-05T09:00:00Z', 'start', 'yesterday') + '\n');
  writeFileSync(
    join(dir, '2026-11-06.jsonl'),
    e('2026-11-06T09:00:00Z', 'prompt', 'older today') + '\n{"broken\n' +
      JSON.stringify({ at: '2026-11-06T10:00:00Z', session: 's', when: 'prompt', handed: [{ kind: 'recall', title: 'steps: fix signup', chars: 600 }], cut: [{ kind: 'code', title: 'code map', chars: 900, reason: 'over budget' }] }) +
      '\n',
  );

  const last = handedReport([], dir);
  assert.match(last, /^2026-11-06 10:00 UTC · before a prompt/);
  assert.match(last, /Handed over \(1, 600 chars\):\n {2}recall {4} {3}600 chars {2}steps: fix signup/);
  assert.match(last, /Left out \(1\):\n.*code map · over budget/);
  assert.doesNotMatch(last, /older today/);

  const three = handedReport(['--last', '3'], dir);
  assert.deepEqual([...three.matchAll(/^2026-11-0\d \d\d:00/gm)].map((m) => m[0]), ['2026-11-06 10:00', '2026-11-06 09:00', '2026-11-05 09:00'], 'newest first, a broken line skipped');
  assert.match(three, /at session start/);
});
