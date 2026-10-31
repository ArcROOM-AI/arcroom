import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, toArcroomEvent } from './events.js';
import { toBatch } from './daemon.js';

const at = new Date('2026-10-24T12:00:00Z');
const base = { session_id: 's1', cwd: '/repo' };

test('maps every hook event to its ArcRoom event type', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ hook_event_name: 'SessionStart', source: 'startup' }, 'run.start'],
    [{ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, 'prompt'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } }, 'tool.start'],
    [{ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_response: 'ok' }, 'tool.end'],
    [{ hook_event_name: 'Stop' }, 'turn.end'],
    [{ hook_event_name: 'SessionEnd', reason: 'exit' }, 'run.end'],
    [{ hook_event_name: 'Notification' }, 'other.Notification'],
  ];
  for (const [raw, type] of cases) assert.equal(toArcroomEvent({ ...base, ...raw }, at).type, type);
});

test('tool events carry the tool, its id and input', () => {
  const start = toArcroomEvent({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } }, at);
  assert.deepEqual(start.data, { id: 't1', tool: 'Bash', input: { command: 'ls' } });
  assert.equal(start.session, 's1');
  assert.equal(start.at, '2026-10-24T12:00:00.000Z');
});

test('clip keeps small values and caps big ones', () => {
  assert.equal(clip('short'), 'short');
  const big = clip('x'.repeat(10_000)) as { truncated: boolean; size: number; preview: string };
  assert.equal(big.truncated, true);
  assert.equal(big.size, 10_000);
  assert.equal(big.preview.length, 4000);
});

test('only metadata leaves: no file contents, edits, sub-agent prompts or tool output', () => {
  const pre = (tool_name: string, tool_input: unknown) => toArcroomEvent({ hook_event_name: 'PreToolUse', tool_name, tool_input }).data.input;
  assert.deepEqual(pre('Write', { file_path: '/repo/a.ts', content: 'const KEY = 1' }), { file_path: '/repo/a.ts' });
  assert.deepEqual(pre('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }), { file_path: '/repo/a.ts' });
  assert.deepEqual(pre('MultiEdit', { file_path: '/repo/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }), { file_path: '/repo/a.ts' });
  assert.deepEqual(pre('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'x' }), { notebook_path: '/repo/n.ipynb' });
  assert.deepEqual(pre('Task', { description: 'look around', prompt: 'read every file and summarise' }), { description: 'look around' });
  assert.deepEqual(pre('Grep', { pattern: 'useEffect', path: 'src', output_mode: 'content' }), { pattern: 'useEffect', path: 'src' });
  assert.deepEqual(pre('WebFetch', { url: 'https://x.dev', prompt: 'p' }), { url: 'https://x.dev' });
  assert.equal((pre('Bash', { command: 'x'.repeat(5000) }) as { command: string }).command.length, 1000);
  for (const [tool_name, tool_response] of [['Read', 'file text'], ['Bash', { stdout: 'out' }], ['Grep', 'a.ts:1: match']] as const) {
    const end = toArcroomEvent({ hook_event_name: 'PostToolUse', tool_name, tool_use_id: 't1', tool_response }).data;
    assert.deepEqual(end, { id: 't1', tool: tool_name });
  }
  assert.deepEqual(toArcroomEvent({ hook_event_name: 'Notification', message: 'secret stuff' }).data, {});
});

test("ArcRoom's own tools keep their input and output", () => {
  const input = { intent: 'list breaking changes: react 19', inputs: {} };
  assert.deepEqual(toArcroomEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcp__arcroom__find_task', tool_input: input }).data.input, input);
  const out = [{ type: 'text', text: '{"match":"reuse"}' }];
  assert.deepEqual(toArcroomEvent({ hook_event_name: 'PostToolUse', tool_name: 'mcp__arcroom__find_task', tool_response: out }).data.output, out);
});

test('the prompt is what the person typed, redacted and cut to 1,000 chars', () => {
  const prompt = (p: string) => toArcroomEvent({ hook_event_name: 'UserPromptSubmit', prompt: p }).data.prompt as string;
  assert.equal(prompt('fix the bug<system-reminder>internal note</system-reminder>'), 'fix the bug');
  assert.equal(prompt('y'.repeat(5000)).length, 1000);
  assert.ok(!prompt('x'.repeat(990) + ' sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123').includes('abcdef'));
});

test('a secret file leaves only as "[secret file]", by path or by the command that names it', () => {
  const pre = (tool_name: string, tool_input: unknown) => toArcroomEvent({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input }).data.input;
  assert.deepEqual(pre('Read', { file_path: 'C:/app/.env' }), { file_path: '[secret file]' });
  assert.deepEqual(pre('Bash', { command: 'cat .env.production' }), { command: '[secret file]' });
  assert.deepEqual(pre('Read', { file_path: 'C:/app/.env.example' }), { file_path: 'C:/app/.env.example' });
  assert.deepEqual(pre('Bash', { command: 'npm test' }), { command: 'npm test' });
});

test('events queued for a repo switched off are never sent', () => {
  const line = (cwd: string) => JSON.stringify({ v: 1, session: 's', cwd, type: 'prompt', data: {} }) + '\n';
  const { events } = toBatch(line('C:/work/client') + line('C:/work/private/sub') + line('C:/work/other'), {}, 50, (e) => e, ['C:/work/private']);
  assert.deepEqual(events.map((e: any) => e.cwd), ['C:/work/client', 'C:/work/other']);
});

test('a tool call inside a subagent says which subagent ran it', () => {
  const raw = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_use_id: 't', tool_input: { file_path: 'a.ts' } };
  assert.equal(toArcroomEvent(raw).data.subagent, undefined);
  assert.equal(toArcroomEvent({ ...raw, agent_id: 'a1', agent_type: 'Explore' }).data.subagent, 'Explore');
});
