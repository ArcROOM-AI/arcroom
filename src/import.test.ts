import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-import-home-'));
const { bulletsOf, chosen, importList, itemsOf, notesDir, sendItems, sourcesOf } = await import('./import.js');

test('bullets: one per top-level bullet with its indented lines; code, headings, paragraphs and tool blocks skipped', () => {
  const md = [
    '# Rules',
    'Intro paragraph, not a rule.',
    '- Never post anything yourself.',
    '  Write drafts into files only.',
    '- Plain English. Short sentences.',
    '  - a nested point stays out of the one above',
    '1. Run the tests before you stop.',
    '```',
    '- not a rule, inside code',
    '```',
    '<!-- BEGIN:tool -->',
    '- written by a tool',
    '<!-- END:tool -->',
  ].join('\n');
  assert.deepEqual(bulletsOf(md), [
    { line: 3, body: 'Never post anything yourself. Write drafts into files only.' },
    { line: 5, body: 'Plain English. Short sentences.' },
    { line: 7, body: 'Run the tests before you stop.' },
  ]);
});

test('items: default sources only, --all adds CLAUDE.md and AGENTS.md; secrets dropped; long ones split; files found', () => {
  const root = mkdtempSync(join(tmpdir(), 'arcroom-import-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-import-user-'));
  mkdirSync(join(root, 'db'));
  writeFileSync(join(root, 'db', 'schema.sql'), 'x');
  writeFileSync(join(root, 'CLAUDE.md'), '- Use pnpm, never npm.\n');
  writeFileSync(join(root, 'AGENTS.md'), '<!-- BEGIN:x -->\n- generated\n<!-- END:x -->\n');
  writeFileSync(
    join(root, 'CLAUDE.local.md'),
    ['- Migrations live in db/schema.sql; change it by hand.', '- The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789', `- ${'Long rule sentence here. '.repeat(30)}`, '- Use pnpm, never npm.'].join('\n'),
  );
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'rules', 'api.mdc'), '---\ndescription: api\nalwaysApply: true\n---\n- Every route checks the key first.\n');
  writeFileSync(join(root, '.cursorrules'), '# heading\nKeep functions short.\n\n');
  mkdirSync(notesDir(root, home), { recursive: true });
  writeFileSync(join(notesDir(root, home), 'MEMORY.md'), '- [x](x.md) index only\n');
  writeFileSync(join(notesDir(root, home), 'sessions.md'), '---\nname: sessions\ndescription: Sessions live in Postgres, not Redis\n---\n\nBody.\n**Why:** logout has to work on every server\n');

  const items = itemsOf(root, false, home);
  assert.deepEqual(
    items.map((i) => i.source),
    ['CLAUDE.local.md:1', 'CLAUDE.local.md:3', 'CLAUDE.local.md:4', 'memory note sessions', '.cursor/rules/api.mdc:5', '.cursorrules:2'],
    'secret line dropped, CLAUDE.md and the memory index not read by default',
  );
  assert.deepEqual(items[0].files, ['db/schema.sql']);
  assert.ok(items[1].text.length <= 500 && items[1].why && items[1].why.length > 0, 'a long rule is split into text and why');
  assert.deepEqual([items[3].text, items[3].why], ['Sessions live in Postgres, not Redis', 'logout has to work on every server']);
  assert.ok(!JSON.stringify(items).includes('ghp_'), 'no secret anywhere');

  const all = itemsOf(root, true, home);
  assert.equal(all[0].source, 'CLAUDE.md:1', '--all reads the committed file first');
  assert.equal(all.filter((i) => /Use pnpm/.test(i.text)).length, 1, 'the same words once');
  assert.ok(!all.some((i) => /generated/.test(i.text)), 'the tool block in AGENTS.md is skipped');
  assert.deepEqual(sourcesOf(root, true, home).map((s) => s.label).slice(0, 2), ['CLAUDE.md', 'AGENTS.md']);
  assert.match(importList(items, sourcesOf(root, false, home)), /^From CLAUDE\.local\.md, memory note sessions, \.cursor\/rules\/api\.mdc, \.cursorrules: 6 items/);
  assert.match(importList([], []), /^Nothing to import/);
});

test('answers: y is all, "skip 2, 3" leaves those out, anything else sends nothing', () => {
  assert.deepEqual(chosen('y', 3), [0, 1, 2]);
  assert.deepEqual(chosen(' Yes ', 2), [0, 1]);
  assert.deepEqual(chosen('skip 2, 3', 4), [0, 3]);
  assert.deepEqual(chosen('n', 3), []);
  assert.deepEqual(chosen('', 3), []);
  assert.deepEqual(chosen('sure', 3), []);
});

test('send: each item through remember with its project and file hashes, one at a time, each in arcroom sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arcroom-import-send-'));
  writeFileSync(join(root, 'a.sql'), 'x');
  const calls: any[] = [];
  const fake = async (_cfg: any, path: string, body: any) => (calls.push([path, body]), { saved: calls.length === 1 });
  const r = await sendItems({ apiKey: 'k', url: 'http://x' } as any, root, [{ text: 'one', files: ['a.sql'], source: 's:1' }, { text: 'two', files: [], source: 's:2' }], fake);
  assert.deepEqual(r, { saved: 1, already: 1, failed: 0 });
  assert.equal(calls[0][0], '/v1/memory/remember');
  assert.equal(calls[0][1].kind, 'fact');
  assert.match(calls[0][1].hashes['a.sql'], /^[0-9a-f]{40}$/);
  assert.equal(calls[1][1].hashes, undefined);
  const sent = readdirSync(join(process.env.ARCROOM_HOME!, 'sent')).map((f) => readFileSync(join(process.env.ARCROOM_HOME!, 'sent', f), 'utf8')).join('');
  assert.equal(sent.match(/"type":"import"/g)?.length, 2);
});

test('arcroom import: dry run and "n" send nothing; "skip 1" sends the rest; the rule files are byte for byte unchanged', async () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
  const posts: any[] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d)).on('end', () => {
      posts.push([req.url, JSON.parse(b || '{}')]);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"saved":true,"memo_id":"m"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'arcroom-import-cli-home-'));
  const user = mkdtempSync(join(tmpdir(), 'arcroom-import-cli-user-'));
  const repo = mkdtempSync(join(tmpdir(), 'arcroom-import-cli-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ apiKey: 'test', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  writeFileSync(join(repo, 'CLAUDE.local.md'), '- Rule one.\r\n- Rule two.\r\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '- Committed rule.\n');
  const before = ['CLAUDE.local.md', 'CLAUDE.md'].map((f) => readFileSync(join(repo, f)));
  const run = (args: string[], input: string) =>
    new Promise<string>((done) => {
      const c = spawn(process.execPath, [entry, 'import', ...args], { cwd: repo, env: { ...process.env, ARCROOM_HOME: home, USERPROFILE: user, HOME: user } });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stdin.end(input);
      c.on('close', () => done(out));
    });
  try {
    assert.match(await run(['--dry-run'], ''), /2 items[\s\S]*Dry run: nothing was sent/);
    assert.match(await run([], 'n\n'), /Nothing was sent/);
    assert.equal(posts.length, 0, 'no request before a yes');
    assert.match(await run([], 'skip 1\n'), /Imported 1 new team fact/);
    assert.deepEqual(posts.map(([u, b]) => [u, b.text]), [['/v1/memory/remember', 'Rule two.']]);
    ['CLAUDE.local.md', 'CLAUDE.md'].forEach((f, i) => assert.ok(readFileSync(join(repo, f)).equals(before[i]), `${f} changed`));
  } finally {
    server.closeAllConnections();
    server.close();
    for (const d of [home, user, repo]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
