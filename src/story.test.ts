import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a compaction hands back the first and latest ask and the edited files, and forgets what was handed', async () => {
  process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-'));
  const { noteStory, compactReset, storyNote } = await import('./session.js');
  const { sessionFile } = await import('./loop.js');

  assert.equal(compactReset('s0'), undefined, 'nothing noted yet: no note');

  noteStory('s1', { ask: 'fix the free plan on sign-up' });
  noteStory('s1', { files: ['C:\\repo\\migrations\\0069.sql'] }, 'C:\\repo');
  noteStory('s1', { files: ['C:\\repo\\tests\\plans.sql', 'C:\\repo\\migrations\\0069.sql'] }, 'C:\\repo');
  noteStory('s1', { ask: 'now do existing accounts too' });
  // what was handed in this session so far, and the code map's last look
  writeFileSync(sessionFile('s1', '.recalled'), '["m1"]');
  writeFileSync(sessionFile('s1', '.codelook'), '{}');

  const note = compactReset('s1')!;
  assert.match(note, /First ask: "fix the free plan on sign-up"/);
  assert.match(note, /Latest ask: "now do existing accounts too"/);
  assert.match(note, /Files edited: tests\/plans\.sql, migrations\/0069\.sql$/m, 'repo paths, newest last, no repeats');
  assert.ok(note.split('\n').length <= 5);
  assert.ok(!existsSync(sessionFile('s1', '.recalled')) && !existsSync(sessionFile('s1', '.codelook')));

  // one ask only: no "Latest ask" line; a long ask is cut
  const one = storyNote({ first: 'x'.repeat(300), last: 'x'.repeat(300) })!;
  assert.doesNotMatch(one, /Latest ask/);
  noteStory('s2', { ask: 'y'.repeat(1000) });
  assert.match(compactReset('s2')!, new RegExp(`"${'y'.repeat(300)}"`));
});
