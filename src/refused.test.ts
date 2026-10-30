import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a refused key stops ArcRoom on this machine until a new key is saved', async () => {
  process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-refused-'));
  const { api, keyRefused, loadConfig } = await import('./home.js');
  const server = createServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid api key"}'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = join(process.env.ARCROOM_HOME, 'config.json');
  writeFileSync(config, JSON.stringify({ apiKey: 'ark_oldkey_123456789', url }));
  assert.equal(keyRefused(), false);
  await assert.rejects(api(loadConfig(), '/v1/me'), /invalid api key/);
  assert.equal(keyRefused(), true); // the hook, daemon and tools now do nothing
  writeFileSync(config, JSON.stringify({ apiKey: 'ark_newkey_987654321', url })); // arcroom init with a new key
  assert.equal(keyRefused(), false);
  server.close();
});
