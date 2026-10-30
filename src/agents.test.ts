import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromAgent, normalizeTool, opencodePlugin, toAgent } from './agents.js';
import { withArcroomHooks, withCodexMcp, withCursorHooks } from './init.js';

test("other agents' tools become the same steps as Claude Code's", () => {
  assert.deepEqual(normalizeTool('shell', { command: ['npm', 'test'] }), { tool: 'Bash', input: { command: 'npm test' }, more: [] });
  assert.deepEqual(normalizeTool('read', { filePath: 'src/a.ts' }), { tool: 'Read', input: { file_path: 'src/a.ts' }, more: [] });
  assert.deepEqual(normalizeTool('edit_file', { target_file: 'src/a.ts' }).tool, 'Edit');
  assert.deepEqual(normalizeTool('write', { filePath: 'src/b.ts' }).tool, 'Write');
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch';
  assert.deepEqual(normalizeTool('apply_patch', { input: patch }), { tool: 'Edit', input: { file_path: 'src/a.ts' }, more: ['src/b.ts'] });
  // Claude Code's own names pass through untouched
  assert.deepEqual(normalizeTool('Read', { file_path: 'x' }), { tool: 'Read', input: { file_path: 'x' }, more: [] });
});

test('a Cursor payload becomes a Claude Code payload', () => {
  const r = fromAgent({ hook_event_name: 'preToolUse', conversation_id: 'c1', workspace_roots: ['/repo'], tool_name: 'read_file', tool_input: { target_file: 'a.js' } }, 'cursor');
  assert.equal(r.hook_event_name, 'PreToolUse');
  assert.equal(r.session_id, 'c1');
  assert.equal(r.cwd, '/repo');
  assert.deepEqual([r.tool_name, r.tool_input], ['Read', { file_path: 'a.js' }]);
  assert.equal(fromAgent({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', prompt: 'hi' }, 'cursor').hook_event_name, 'UserPromptSubmit');
});

test("the hook's answer in Cursor's terms; prompt context waits for the first tool call", () => {
  const session = `test-cursor-${process.pid}`;
  const ctx = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'team memory' } };
  assert.deepEqual(toAgent('cursor', 'UserPromptSubmit', ctx, session), { continue: true });
  assert.deepEqual(toAgent('cursor', 'PostToolUse', {}, session), { additional_context: 'team memory' });
  assert.deepEqual(toAgent('cursor', 'PostToolUse', {}, session), {}); // handed over once
  const deny = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'loop' } };
  assert.deepEqual(toAgent('cursor', 'PreToolUse', deny, session), { permission: 'deny', agent_message: 'loop', user_message: 'loop' });
  assert.deepEqual(toAgent('cursor', 'Stop', { decision: 'block', reason: 'tests fail' }, session), { followup_message: 'tests fail' });
  // Codex and Claude Code take the answer as it is
  assert.deepEqual(toAgent('codex', 'Stop', { decision: 'block', reason: 'x' }, session), { decision: 'block', reason: 'x' });
});

test("init writes each agent's files and keeps what was there", () => {
  const codex = withArcroomHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } }, 'node "/h/.arcroom/runtime/index.js" hook --agent codex', '.*');
  assert.equal(codex.hooks!.Stop.length, 2);
  assert.equal(codex.hooks!.PreToolUse[0].matcher, '.*');
  const toml = withCodexMcp('model = "o5"\n\n[mcp_servers.arcroom]\ncommand = "old"\n\n[other]\nx = 1\n', '/h/runtime/index.js', 'node');
  assert.equal(toml, 'model = "o5"\n\n[other]\nx = 1\n\n[mcp_servers.arcroom]\ncommand = "node"\nargs = ["/h/runtime/index.js", "mcp"]\n');
  const cursor = withCursorHooks({ hooks: { stop: [{ command: 'theirs' }, { command: 'node .arcroom/runtime/index.js hook' }] } }, 'node .arcroom/runtime/index.js hook --agent cursor');
  assert.equal(cursor.version, 1);
  assert.deepEqual(cursor.hooks!.stop.map((h) => h.command), ['theirs', 'node .arcroom/runtime/index.js hook --agent cursor']);
  assert.equal(Object.keys(cursor.hooks!).length, 6);
  assert.match(opencodePlugin('/h/runtime/index.js'), /\["\/h\/runtime\/index\.js","hook","--agent","opencode"\]/);
});

test("opencode: a prompt's recall goes into that turn's system prompt, and is gone after the turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-opencode-'));
  try {
    // a stand-in for the hook: answers UserPromptSubmit with context built from the prompt
    const fake = join(dir, 'fake-hook.mjs');
    writeFileSync(fake, `let s='';for await (const c of process.stdin) s+=c;const p=JSON.parse(s);
process.stdout.write(JSON.stringify(p.hook_event_name==='UserPromptSubmit'?{hookSpecificOutput:{additionalContext:'recall for '+p.prompt}}:{}));`);
    const file = join(dir, 'arcroom.mjs');
    writeFileSync(file, opencodePlugin(fake));
    const { ArcRoom } = await import(pathToFileURL(file).href);
    const hooks = await ArcRoom({ client: { session: { prompt: async () => {} } }, directory: dir });
    await hooks['chat.message']({ sessionID: 's1' }, { parts: [{ type: 'text', text: 'add a clear command' }, { type: 'text', text: 'note', synthetic: true }] });
    const system: string[] = ['base'];
    await hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system });
    assert.deepEqual(system, ['base', 'recall for add a clear command']);
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    const after: string[] = [];
    await hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system: after });
    assert.deepEqual(after, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor: a Stop note waits for the next tool call, for the agent to pass on', () => {
  const session = `stop-note-${process.pid}`;
  assert.deepEqual(toAgent('cursor', 'Stop', { systemMessage: 'ArcRoom · done-checks in .arcroom.json are new or changed' }, session), {});
  assert.match(toAgent('cursor', 'PostToolUse', {}, session).additional_context, /^ArcRoom note for the user \(tell them\): ArcRoom · done-checks/);
});
