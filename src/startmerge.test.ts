import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Session start hands over more than one block (this session's story after a compaction, the last run here) and Claude
// Code takes ONE additionalContext: every block must be in it, none may overwrite another.
const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

function runHook(home: string, cwd: string, payload: Record<string, unknown>, agent?: string): Promise<any> {
  // run from the fake repo, never from a folder that holds `home` (like tmpdir()): the hook then ignores ARCROOM_HOME
  // (home.ts) and uses the person's real ~/.arcroom, real key and real API
  const child = spawn(process.execPath, [entry, 'hook', ...(agent ? ['--agent', agent] : [])], { env: { ...process.env, ARCROOM_HOME: home }, cwd });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(JSON.stringify({ session_id: 'merge', ...payload }));
  return new Promise((done) => child.on('close', () => done(out ? JSON.parse(out) : {})));
}

test('after a compaction, the session story and the last-run note go out together; a fresh start has the note only', async () => {
  const lastRun = { started_at: new Date(Date.now() - 3_600_000).toISOString(), machine: 'laptop-b', status: 'done', prompt: 'teammate task', mine: false };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.startsWith('/v1/runs/last') ? lastRun : {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-merge-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-merge-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  // this test process poses as the running daemon (daemon.ts isRunning), so the hook starts none
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  try {
    await runHook(home, cwd, { hook_event_name: 'UserPromptSubmit', cwd, prompt: 'fix the free plan on sign-up' });
    // the hook used this test's home, not the real one: its queue is here (stop now if not, before more is recorded)
    assert.ok(existsSync(join(home, 'spool.jsonl')), 'the hook ignored ARCROOM_HOME');
    await runHook(home, cwd, { hook_event_name: 'PreToolUse', cwd, tool_name: 'Edit', tool_input: { file_path: join(cwd, 'plans.sql') } });

    const compact = (await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'compact' })).hookSpecificOutput?.additionalContext ?? '';
    assert.match(compact, /First ask: "fix the free plan on sign-up"/, 'the story');
    assert.match(compact, /Files edited: plans\.sql/);
    assert.match(compact, /laptop-b/, 'the last-run note is still there');
    assert.match(compact, /teammate task/);
    assert.ok(compact.indexOf('First ask') < compact.indexOf('laptop-b'), 'own story first, teammate note fenced after it');

    const fresh = (await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 'other' })).hookSpecificOutput?.additionalContext ?? '';
    assert.match(fresh, /laptop-b/);
    assert.doesNotMatch(fresh, /this session so far/, 'no story on a normal start');

    const log = readdirSync(join(home, 'handed')).map((f) => readFileSync(join(home, 'handed', f), 'utf8')).join('');
    const compactEntry = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.when === 'compact');
    assert.deepEqual(compactEntry.handed.map((i: any) => i.kind), ['compact', 'last_run'], 'arcroom handed sees both');
  } finally {
    server.closeAllConnections();
    server.close();
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('session start: teammates open work joins the last-run note in one fence, without the run it already shows; a slow open list is skipped', async () => {
  const lastRun = { id: 'r-last', started_at: new Date(Date.now() - 600_000).toISOString(), machine: 'laptop-b', status: 'running', prompt: 'teammate task', mine: false };
  const openNow = {
    open: [
      { run_id: 'r-last', machine: 'laptop-b', ask: 'teammate task', files: [], state: 'working', minutes: 2 },
      { run_id: 'r-2', machine: 'laptop-c', ask: 'fix the invoice total', files: ['billing/tax.ts'], state: 'working', minutes: 4 },
    ],
    unfinished: [{ task: 'migrate billing tables', machine: 'laptop-c', state: 'claim_lapsed', minutes: 40 }],
  };
  let slow = false;
  const server = createServer((req, res) => {
    const body = JSON.stringify(req.url?.startsWith('/v1/runs/last') ? lastRun : req.url?.startsWith('/v1/runs/open') ? openNow : {});
    const send = () => res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    if (slow && req.url?.startsWith('/v1/runs/open')) setTimeout(send, 2500);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-open-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-open-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  try {
    const out = await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 's-open' });
    assert.ok(existsSync(join(home, 'spool.jsonl')), 'the hook ignored ARCROOM_HOME');
    const ctx: string = out.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /laptop-b/, 'last-run note');
    assert.match(ctx, /open now from teammates/);
    assert.match(ctx, /- laptop-c · "fix the invoice total" · billing\/tax\.ts · working, 4 min ago/);
    assert.match(ctx, /"migrate billing tables" · laptop-c · claim lapsed, safe to take/);
    assert.equal(ctx.match(/teammate task/g)?.length, 1, 'the last run is not listed twice');
    assert.equal(ctx.split('\n</arcroom-memory>').length - 1, 1, 'the last run and open work share one fence');
    assert.match(out.systemMessage, /2 teammate sessions open here/);
    assert.ok(existsSync(join(home, 'sessions', 's-open.open.json')), 'kept for the clash check');

    slow = true;
    const started = Date.now();
    const late = await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 's-slow' });
    const lateCtx: string = late.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(Date.now() - started < 4000, `session start waited ${Date.now() - started} ms`);
    assert.match(lateCtx, /laptop-b/, 'the last-run note still comes');
    assert.doesNotMatch(lateCtx, /open now from teammates/, 'a slow open list is left out quietly');
  } finally {
    server.closeAllConnections();
    server.close();
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('the first prompt that matches a teammate open session gets one clash line inside the fence; later prompts do not', async () => {
  const openNow = { open: [{ run_id: 'r-2', machine: 'laptop-c', ask: 'fix the invoice total', files: ['billing/tax.ts'], state: 'working', minutes: 4 }], unfinished: [] };
  const server = createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url?.startsWith('/v1/runs/open') ? openNow : req.url?.startsWith('/v1/runs/last') ? null : {})),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-clash-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-clash-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  try {
    await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 'c1' });
    assert.ok(existsSync(join(home, 'spool.jsonl')), 'the hook ignored ARCROOM_HOME');
    const first = await runHook(home, cwd, { hook_event_name: 'UserPromptSubmit', cwd, session_id: 'c1', prompt: 'the invoice total is wrong, fix it' });
    const ctx: string = first.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /a teammate on laptop-c is already on this: "fix the invoice total"/);
    assert.ok(ctx.indexOf('already on this') > ctx.indexOf('<arcroom-memory>\n'), 'inside the fence');
    assert.match(first.systemMessage, /a teammate may already be on this/);
    const second = await runHook(home, cwd, { hook_event_name: 'UserPromptSubmit', cwd, session_id: 'c1', prompt: 'the invoice total again' });
    assert.doesNotMatch(second.hookSpecificOutput?.additionalContext ?? '', /already on this/, 'first prompt only');

    await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 'c2' });
    const other = await runHook(home, cwd, { hook_event_name: 'UserPromptSubmit', cwd, session_id: 'c2', prompt: 'update the README install section' });
    assert.doesNotMatch(other.hookSpecificOutput?.additionalContext ?? '', /already on this/, 'different work: no line');
  } finally {
    server.closeAllConnections();
    server.close();
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('arcroom open off: a repo whose .arcroom.json says "open": "off" never asks for the open-now list', async () => {
  let asked = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/runs/open')) asked++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.startsWith('/v1/runs/open') ? '{"open":[{"run_id":"r","machine":"m","ask":"x","state":"working","minutes":1}]}' : 'null');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-off-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-off-repo-'));
  spawnSync('git', ['init', '-q'], { cwd, windowsHide: true });
  writeFileSync(join(cwd, '.arcroom.json'), '{ "open": "off" }');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  try {
    const out = await runHook(home, cwd, { hook_event_name: 'SessionStart', cwd, source: 'startup', session_id: 'off1' });
    assert.ok(existsSync(join(home, 'spool.jsonl')), 'the hook ignored ARCROOM_HOME');
    assert.equal(asked, 0, 'no open-now request');
    assert.doesNotMatch(out.hookSpecificOutput?.additionalContext ?? '', /open now from teammates/);
    assert.ok(!existsSync(join(home, 'sessions', 'off1.open.json')), 'nothing kept for a clash check');
  } finally {
    server.closeAllConnections();
    server.close();
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('Cursor and OpenCode: the merged session-start block and the clash line reach them in their own shapes', async () => {
  const lastRun = { id: 'r-last', started_at: new Date(Date.now() - 600_000).toISOString(), machine: 'laptop-b', status: 'done', prompt: 'teammate task', mine: false };
  const openNow = { open: [{ run_id: 'r-2', machine: 'laptop-c', ask: 'fix the invoice total', files: ['billing/tax.ts'], state: 'working', minutes: 4 }], unfinished: [] };
  const server = createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url?.startsWith('/v1/runs/open') ? openNow : req.url?.startsWith('/v1/runs/last') ? lastRun : {})),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-agents-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'arcroom-agents-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  for (const f of ['daemon.pid', 'daemon.beat']) writeFileSync(join(home, f), String(process.pid));
  const both = (ctx: string) => /laptop-b/.test(ctx) && /open now from teammates/.test(ctx) && ctx.split('\n</arcroom-memory>').length === 2;
  try {
    // Cursor: session start as additional_context; prompt context is held and handed with the first tool call
    const cursor = (event: string, extra: Record<string, unknown> = {}) =>
      runHook(home, cwd, { hook_event_name: event, session_id: 'cur1', conversation_id: 'cur1', workspace_roots: [cwd], cwd: undefined, ...extra }, 'cursor');
    const start = await cursor('sessionStart');
    assert.ok(existsSync(join(home, 'spool.jsonl')), 'the hook ignored ARCROOM_HOME');
    assert.ok(both(start.additional_context ?? ''), `cursor start: ${JSON.stringify(start)}`);
    assert.deepEqual(await cursor('beforeSubmitPrompt', { prompt: 'the invoice total is wrong, fix it' }), { continue: true });
    const tool = await cursor('postToolUse', { tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: 'a' });
    assert.match(tool.additional_context ?? '', /a teammate on laptop-c is already on this/, 'clash line comes with the first tool call');

    // OpenCode: Claude-shaped output; its plugin posts the session-start text as a message and adds prompt context
    const oc = (payload: Record<string, unknown>) => runHook(home, cwd, { session_id: 'oc1', cwd, ...payload }, 'opencode');
    assert.ok(both((await oc({ hook_event_name: 'SessionStart' })).hookSpecificOutput?.additionalContext ?? ''), 'opencode start');
    const prompt = await oc({ hook_event_name: 'UserPromptSubmit', prompt: 'the invoice total is wrong, fix it' });
    assert.match(prompt.hookSpecificOutput?.additionalContext ?? '', /a teammate on laptop-c is already on this/);
  } finally {
    server.closeAllConnections();
    server.close();
    for (const dir of [home, cwd]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
