import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { sessionFile } from './loop.js';

// Other coding agents on the same hook handler. The hook speaks Claude Code's payloads; this file translates.
//   codex     same events, payloads and outputs as Claude Code; only its tool names differ (shell, apply_patch)
//   cursor    camelCase events, conversation_id, workspace_roots; can't add context to a prompt, so recall is held
//             back and handed over on the next tool call (postToolUse accepts additional_context)
//   opencode  a plugin file (opencodePlugin) calls the hook with Claude Code payloads; tools are lowercase; recall is
//             found on chat.message and added through experimental.chat.system.transform (an experimental OpenCode hook)
// Sources (Oct 2026): cursor.com/docs/agent/hooks, learn.chatgpt.com/docs/hooks, opencode.ai/docs/plugins

export const AGENTS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type Agent = (typeof AGENTS)[number];

const CURSOR_EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  stop: 'Stop',
  sessionEnd: 'SessionEnd',
};
export const CURSOR_HOOKS = Object.keys(CURSOR_EVENTS);

/** Every file an apply_patch touches ("*** Update File: src/a.ts"). */
export const patchFiles = (patch: string) => [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

/**
 * Any agent's tool call in Claude Code's terms (Read / Edit / Bash / Grep / Glob), so traces become the same steps.
 * Returns the tool, its input, and any further files (a patch can touch several).
 */
export function normalizeTool(name: string, input: any): { tool: string; input: any; more: string[] } {
  const n = String(name ?? '');
  const i = input ?? {};
  const file = i.file_path ?? i.filePath ?? i.target_file ?? i.path;
  const command = Array.isArray(i.command) ? i.command.join(' ') : (i.command ?? i.cmd);
  const patch = typeof i === 'string' ? i : (i.input ?? i.patch);
  if (/apply_patch/i.test(n) && typeof patch === 'string') {
    const [first, ...more] = patchFiles(patch);
    return { tool: 'Edit', input: { file_path: first }, more };
  }
  if (/^(bash|shell|exec_command|run_terminal_cmd|terminal)$/i.test(n) && command) return { tool: 'Bash', input: { command }, more: [] };
  if (/^(read|read_file|view)$/i.test(n) && file) return { tool: 'Read', input: { file_path: file }, more: [] };
  if (/^(edit|write|multiedit|edit_file|write_file|search_replace|create_file)$/i.test(n) && file)
    return { tool: /write|create/i.test(n) ? 'Write' : 'Edit', input: { file_path: file }, more: [] };
  if (/^(grep|codebase_search|grep_search)$/i.test(n)) return { tool: 'Grep', input: { pattern: i.pattern ?? i.query, path: i.path }, more: [] };
  if (/^(glob|list|list_dir|file_search)$/i.test(n)) return { tool: 'Glob', input: { pattern: i.pattern ?? i.query ?? i.path }, more: [] };
  return { tool: n, input: i, more: [] };
}

/** One agent's hook payload as the Claude Code payload the hook handles (+ more_files for multi-file patches). */
export function fromAgent(raw: any, agent: Agent): any {
  if (agent === 'claude') return raw;
  const r = { ...raw };
  if (agent === 'cursor') {
    r.hook_event_name = CURSOR_EVENTS[raw.hook_event_name] ?? raw.hook_event_name;
    r.session_id = raw.session_id ?? raw.conversation_id;
    r.cwd = raw.cwd ?? raw.workspace_roots?.[0];
    r.tool_response = raw.tool_response ?? raw.tool_output;
  }
  if (r.tool_name !== undefined) {
    const t = normalizeTool(r.tool_name, r.tool_input);
    r.tool_name = t.tool;
    r.tool_input = t.input;
    if (t.more.length) r.more_files = t.more;
  }
  return r;
}

/** The hook's Claude Code output in the agent's own terms. */
export function toAgent(agent: Agent, event: string, out: Record<string, any>, session: string): Record<string, any> {
  if (agent !== 'cursor') return out;
  const context: string | undefined = out.hookSpecificOutput?.additionalContext;
  const pending = sessionFile(session, '.pending-context');
  switch (event) {
    case 'SessionStart':
      return context ? { additional_context: context } : {};
    case 'UserPromptSubmit':
      // Cursor can't add context here: keep it for the first tool call of this turn
      if (context) writeFileSync(pending, context);
      return { continue: true };
    case 'PostToolUse': {
      if (!existsSync(pending)) return {};
      const held = readFileSync(pending, 'utf8');
      rmSync(pending, { force: true });
      return { additional_context: held };
    }
    case 'PreToolUse': {
      const deny = out.hookSpecificOutput?.permissionDecision === 'deny';
      const reason = out.hookSpecificOutput?.permissionDecisionReason;
      return deny ? { permission: 'deny', agent_message: reason, user_message: reason } : {};
    }
    case 'Stop':
      if (out.decision === 'block') return { followup_message: out.reason };
      // Cursor shows the person nothing from a Stop hook: the note (e.g. done-checks not approved) waits for the next
      // tool call, where the agent is asked to pass it on (N21)
      if (out.systemMessage) writeFileSync(pending, `ArcRoom note for the user (tell them): ${out.systemMessage}`);
      return {};
    default:
      return {};
  }
}

/** The OpenCode plugin: calls the ArcRoom hook with Claude Code payloads for each OpenCode event. */
export function opencodePlugin(entry: string, project?: string, node = process.execPath): string {
  const args = JSON.stringify([entry, 'hook', '--agent', 'opencode', ...(project ? ['--project', project] : [])]);
  return `// ArcRoom for OpenCode (written by \`arcroom init --agent opencode\`; experimental).
// Traces prompts and tool calls, hands over team memory for each prompt, blocks repeated calls, keeps the agent on
// failing done-checks, and adds the last run's note.
import { spawnSync } from 'node:child_process';

const run = (payload) => {
  const r = spawnSync(${JSON.stringify(node)}, ${args}, { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
};

export const ArcRoom = async ({ client, directory }) => {
  const base = (id) => ({ session_id: id ?? 'opencode', cwd: directory });
  const say = async (id, text) => {
    if (id && text) await client.session.prompt({ path: { id }, body: { noReply: true, parts: [{ type: 'text', text }] } }).catch(() => {});
  };
  // recall for the prompt being answered: found when the message arrives, added to the system prompt for that turn
  const pending = new Map();
  return {
    'chat.message': async (input, output) => {
      const prompt = (output.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n');
      if (!prompt) return;
      const context = run({ ...base(input.sessionID), hook_event_name: 'UserPromptSubmit', prompt }).hookSpecificOutput?.additionalContext;
      if (context) pending.set(input.sessionID, context);
      else pending.delete(input.sessionID);
    },
    'experimental.chat.system.transform': async (input, output) => {
      const context = input.sessionID && pending.get(input.sessionID);
      if (context) output.system.push(context);
    },
    'tool.execute.before': async (input, output) => {
      const out = run({ ...base(input.sessionID), hook_event_name: 'PreToolUse', tool_name: input.tool, tool_input: output.args, tool_use_id: input.callID });
      if (out.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(out.hookSpecificOutput.permissionDecisionReason);
    },
    'tool.execute.after': async (input, output) => {
      run({ ...base(input.sessionID), hook_event_name: 'PostToolUse', tool_name: input.tool, tool_input: output.args, tool_response: output.output, tool_use_id: input.callID });
    },
    event: async ({ event }) => {
      const id = event.properties?.sessionID ?? event.properties?.info?.id;
      if (event.type === 'session.created') await say(id, run({ ...base(id), hook_event_name: 'SessionStart' }).hookSpecificOutput?.additionalContext);
      if (event.type === 'session.idle') {
        pending.delete(id); // the turn is over: the next prompt gets its own recall
        const out = run({ ...base(id), hook_event_name: 'Stop' });
        if (out.decision === 'block' && id) await client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text: out.reason }] } }).catch(() => {});
      }
      if (event.type === 'session.deleted') run({ ...base(id), hook_event_name: 'SessionEnd' });
    },
  };
};
`;
}
