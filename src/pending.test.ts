import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-pending-'));
const { keepForLater, sendLater } = await import('./pending.js');

test('a save that could not reach the API is sent later; still offline it waits; refused it is dropped', async () => {
  keepForLater('/v1/memory/remember', { kind: 'fact', text: 'builds with pnpm' }, '/repo');
  keepForLater('/v1/tasks/complete', { memo_id: 'm' }, '/repo');
  const offline = async () => { throw new Error('could not reach https://api.example.com (ECONNREFUSED)'); };
  assert.deepEqual(await sendLater(offline), { sent: 0, dropped: [] });
  const seen: string[] = [];
  const back = async (_cwd: string, path: string) => {
    seen.push(path);
    if (path === '/v1/tasks/complete') throw new Error('this task is not claimed by you');
  };
  const r = await sendLater(back);
  assert.equal(r.sent, 1);
  assert.deepEqual(r.dropped, ['/v1/tasks/complete: this task is not claimed by you']);
  assert.deepEqual(seen, ['/v1/memory/remember', '/v1/tasks/complete']);
  assert.deepEqual(await sendLater(back), { sent: 0, dropped: [] }); // nothing left
});
