import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-rerun-'));
const { initChoice } = await import('./init.js');
const { api, DEFAULT_URL, stopForKey } = await import('./home.js');

test('re-running init asks for a new key once the saved one was refused', () => {
  const saved = { apiKey: 'ark_oldkey_123456789', url: 'https://api.example.com' };
  assert.equal(initChoice({ saved }).key, saved.apiKey); // a working key is reused
  stopForKey(saved.apiKey);
  const after = initChoice({ saved });
  assert.equal(after.key, undefined); // init asks for one
  assert.match(after.notes[0], /refused/);
  assert.equal(initChoice({ saved, envKey: 'ark_newkey_987654321' }).key, 'ark_newkey_987654321');
});

test('a local API saved during development moves to the live one unless --url keeps it', () => {
  const local = initChoice({ saved: { url: 'http://localhost:8787' } });
  assert.equal(local.url, DEFAULT_URL);
  assert.match(local.notes[0], /localhost:8787/);
  assert.equal(initChoice({ saved: { url: 'http://localhost:8787' }, argUrl: 'http://localhost:8787' }).url, 'http://localhost:8787');
  assert.deepEqual(initChoice({ saved: { url: 'https://api.example.com' } }).notes, []);
});

test('an API that cannot be reached is one readable line, from api() and from a typed command', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise((ok) => server.close(ok)); // nothing listens there now
  const cfg = { apiKey: 'ark_x', url };
  await assert.rejects(api(cfg, '/v1/me'), { message: `could not reach ${url} (ECONNREFUSED)` });
  writeFileSync(join(process.env.ARCROOM_HOME!, 'config.json'), JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'index.js'), 'whoami'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), `arcroom whoami: could not reach ${url} (ECONNREFUSED)`);
});
