import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The API down or hung must never hold a prompt: the hook gives up within its 3 s budget, says memory is offline,
// and skips the lookup for a minute after that.
const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

function runHook(home: string, cwd: string): Promise<{ ms: number; code: number | null; out: string }> {
  const started = Date.now();
  // never run from a folder that holds `home`: the hook then ignores ARCROOM_HOME (home.ts) and would use the real one
  const child = spawn(process.execPath, [entry, 'hook'], { env: { ...process.env, ARCROOM_HOME: home }, cwd });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'outage', cwd, prompt: 'add a clear command to the todo app' }));
  return new Promise((done) => child.on('close', (code) => done({ ms: Date.now() - started, code, out })));
}

function setup(url: string) {
  const home = mkdtempSync(join(tmpdir(), 'arcroom-outage-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-outage-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url }));
  // this test process poses as the running daemon (daemon.ts isRunning), so the hook starts none: no process is left
  // behind holding the folders, and the hook does its own lookup, as it does when no daemon runs
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  const cleanup = async () => {
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { home, cwd, cleanup };
}

test('a hung API: the prompt goes through within the budget, says offline, and the next one skips the wait', async () => {
  const server: Server = createServer(() => {}); // accepts, never answers
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { home, cwd, cleanup } = setup(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const first = await runHook(home, cwd);
    assert.equal(first.code, 0);
    assert.ok(first.ms < 5000, `took ${first.ms} ms`); // 3 s budget + node start-up
    assert.match(first.out, /memory offline, prompt sent without it/);
    assert.match(first.out, /additionalContext/);
    const second = await runHook(home, cwd);
    assert.ok(second.ms < 2000, `cool-down not used: ${second.ms} ms`);
    assert.match(second.out, /memory offline/);
  } finally {
    server.closeAllConnections();
    server.close();
    await cleanup();
  }
});

test('a closed port: the prompt goes through at once', async () => {
  const { home, cwd, cleanup } = setup('http://127.0.0.1:9');
  try {
    const run = await runHook(home, cwd);
    assert.equal(run.code, 0);
    assert.ok(run.ms < 2000, `took ${run.ms} ms`);
    assert.match(run.out, /memory offline/);
  } finally {
    await cleanup();
  }
});
