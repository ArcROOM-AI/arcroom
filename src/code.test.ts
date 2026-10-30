import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeNote } from './code.js';
import { codeTag } from './daemon.js';
import { parseLsTree, syncBody, withDirty } from './tree.js';

const LS = [
  '040000 tree 1111111111111111111111111111111111111111\tsrc',
  '040000 tree 2222222222222222222222222222222222222222\tsrc/billing',
  '100644 blob 3333333333333333333333333333333333333333\tsrc/billing/tax.ts',
  '100644 blob 4444444444444444444444444444444444444444\tREADME.md',
].join('\n');

test('the tree comes from git ls-tree: folders and files with their hashes, the root as "."', () => {
  const t = parseLsTree(LS, 'r000');
  assert.deepEqual([...t.keys()], ['.', 'src', 'src/billing', 'src/billing/tax.ts', 'README.md']);
  assert.deepEqual(t.get('src/billing'), { kind: 'dir', hash: '2222222222222222222222222222222222222222' });
});

test('uncommitted edits: the file gets its new hash, every folder above it a *', () => {
  const t = withDirty(parseLsTree(LS, 'r000'), [{ path: 'src/billing/tax.ts', hash: 'abc' }, { path: 'README.md' }]);
  assert.equal(t.get('src/billing/tax.ts')!.hash, 'abc');
  assert.equal(t.get('src/billing')!.hash.endsWith('*'), true);
  assert.equal(t.get('.')!.hash, 'r000*');
  assert.equal(t.has('README.md'), false);
});

test('the default branch sends everything once, then only what changed and what went', () => {
  const s = { root: '/repo', mode: 'standard' as const };
  const b = { branch: 'main', def: 'main', ahead: 0, all: ['main', 'feature/x'], merged: ['main'] };
  const first = syncBody(s, parseLsTree(LS, 'r000'), b, undefined);
  assert.equal(first.body.full, true);
  assert.equal(first.body.nodes.length, 5);
  const t2 = withDirty(parseLsTree(LS, 'r000'), [{ path: 'src/billing/tax.ts', hash: 'abc' }, { path: 'README.md' }]);
  const next = syncBody(s, t2, b, first.sent);
  assert.equal(next.body.full, false);
  assert.deepEqual(next.body.nodes.map((n) => n.k).sort(), ['.', 'src', 'src/billing', 'src/billing/tax.ts']);
  assert.deepEqual(next.body.deleted, ['README.md']);
  assert.deepEqual(next.body.nodes.find((n) => n.k === 'src/billing'), { k: 'src/billing', p: 'src', kind: 'dir', h: '2222222222222222222222222222222222222222*' });
});

test('the agent is told summaries that still hold, folders that changed, who is editing, notes and changes', () => {
  const now = new Date('2026-10-27T10:10:00Z');
  const text = codeNote(
    {
      known: true,
      nodes: [
        { k: 'src/auth', summary: { body: 'sessions in session.ts', at: '2026-10-12T09:00:00Z' } },
        { k: 'src/billing', changed_at: '2026-10-27T10:00:00Z', changed_by: 'arjun@x.test', stale_summary: { body: 'old billing notes', at: '2026-10-01T00:00:00Z' } },
        { k: 'src/api' },
      ],
      claims: [
        { k: 'src/billing', by: 'arjun@x.test', agent: 'codex', branch: 'main', since: '2026-10-27T10:07:00Z' },
        { k: 'src/billing/invoice.ts', by: 'arjun@x.test', agent: 'codex', branch: 'main', since: '2026-10-27T10:07:00Z' },
        { k: 'src/api/routes.ts', by: 'riya@x.test', agent: 'claude', branch: 'feature/api', since: '2026-10-27T10:09:00Z' },
      ],
      notes: [{ k: 'src/billing', by: 'arjun@x.test', agent: 'codex', branch: 'main', body: 'renaming Invoice to Bill' }],
      changed: [{ k: 'src/billing', by: 'arjun@x.test', at: '2026-10-27T10:00:00Z' }],
    },
    'main',
    now,
  )!;
  assert.match(text, /- src\/auth: sessions in session\.ts \((still true: the folder has not changed since this was written, on 2026-10-12)\)/);
  assert.match(text, /- src\/billing: changed 10 min ago by arjun since its summary/);
  assert.match(text, /- src\/billing\/invoice\.ts · arjun's codex, 3 min \(same branch\)/);
  assert.match(text, /- src\/api\/routes\.ts · riya's claude, 1 min \(on feature\/api: expect a merge conflict/);
  assert.match(text, /- src\/billing \(arjun's codex\): renaming Invoice to Bill/);
  assert.match(text, /No summary yet: src\/api\. After you understand one, save a line about it with mcp__arcroom__code_note\./);
  assert.equal(codeNote({ known: true, nodes: [{ k: 'src/x' }] }, 'main'), undefined); // nothing to say: silent
  assert.equal(codeNote({ known: false }, 'main'), undefined);
});

test('an edit is tagged with its repo, branch, file and folder; reads and other tools are not', () => {
  const s = { root: '/repo', mode: 'standard' as const };
  const e = { type: 'tool.start', cwd: '/repo', data: { tool: 'Edit', agent: 'codex', input: { file_path: '/repo/src/billing/tax.ts' } } };
  const tagged = codeTag(e, s, 'feature/tax');
  assert.equal(tagged.data.code.node, 'src/billing/tax.ts');
  assert.equal(tagged.data.code.dir, 'src/billing');
  assert.equal(tagged.data.code.branch, 'feature/tax');
  assert.equal(tagged.data.code.agent, 'codex');
  assert.equal(codeTag({ ...e, data: { ...e.data, tool: 'Read' } }, s, 'main').data.code, undefined);
  assert.equal(codeTag(e, { root: '/repo', mode: 'off' }, 'main').data.code, undefined);
});
