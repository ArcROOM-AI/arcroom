import { hostname } from 'node:os';
import { redact, redactText, sensitiveFile } from './redact.js';

const MAX = 4000; // ponytail: fixed per-field cap so one huge tool output can't bloat the queue; make configurable if reports need full outputs

export type ArcroomEvent = {
  v: 1;
  at: string;
  session: string;
  machine: string;
  cwd?: string;
  type: string;
  data: Record<string, unknown>;
};

/** Keeps small values as they are; replaces big ones with a preview and their size, redacted before the cut. */
export function clip(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text.length <= MAX) return value;
  // whole, so secrets under sensitive keys and keys whose END line the cut would lose are still found
  const safe = typeof value === 'string' ? redactText(value) : JSON.stringify(redact(value));
  return { truncated: true, size: text.length, preview: safe.slice(0, MAX) };
}

// Metadata only: a tool call leaves the laptop as its paths, patterns, command, URL or query, never what it read,
// wrote or printed (file contents, edits, sub-agent prompts, tool output). Steps, run reports and the feed read
// only these keys. ArcRoom's own tools keep their input and output: both go to and come from the ArcRoom API anyway.
const OURS = 'mcp__arcroom__';
const KEEP = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'query', 'description'];
const SHORT = 1000; // prompts and commands; the server reads the first 300 (prompt) and 200 (command) chars
// redacted before the cut, so a secret the cut splits is still found
const short = (v: unknown) => (typeof v === 'string' ? redactText(v).slice(0, SHORT) : v);
// a path to a secret file (.env, keys) or a command that names one leaves only as "[secret file]"
const kept = (k: string, v: unknown) => (sensitiveFile(v) ? '[secret file]' : k === 'command' ? short(v) : v);
const metadata = (input: unknown) =>
  Object.fromEntries(
    KEEP.filter((k) => input && typeof input === 'object' && (input as any)[k] !== undefined).map((k) => [k, kept(k, (input as any)[k])]),
  );
// what Claude Code adds to a prompt (<system-reminder> blocks) is not what the person typed
const typed = (prompt: unknown) => short(String(prompt ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim());

/** Maps one Claude Code hook payload to an ArcRoom run event. */
export function toArcroomEvent(raw: Record<string, any>, at = new Date()): ArcroomEvent {
  const base = {
    v: 1 as const,
    at: at.toISOString(),
    session: String(raw.session_id ?? 'unknown'),
    machine: hostname(),
    cwd: raw.cwd,
  };
  switch (raw.hook_event_name) {
    case 'SessionStart':
      return { ...base, type: 'run.start', data: { source: raw.source, model: raw.model, transcript: raw.transcript_path } };
    case 'UserPromptSubmit':
      return { ...base, type: 'prompt', data: { prompt: typed(raw.prompt) } };
    case 'PreToolUse': {
      const ours = String(raw.tool_name).startsWith(OURS);
      // a call made inside a subagent says which one, so its steps are not read as the main agent's
      const subagent = raw.agent_id ? { subagent: String(raw.agent_type ?? raw.agent_id).slice(0, 80) } : {};
      return { ...base, type: 'tool.start', data: { id: raw.tool_use_id, tool: raw.tool_name, input: clip(ours ? raw.tool_input : metadata(raw.tool_input)), ...subagent } };
    }
    case 'PostToolUse':
      return { ...base, type: 'tool.end', data: { id: raw.tool_use_id, tool: raw.tool_name, ...(String(raw.tool_name).startsWith(OURS) ? { output: clip(raw.tool_response) } : {}) } };
    case 'Stop':
      return { ...base, type: 'turn.end', data: {} };
    case 'SessionEnd':
      return { ...base, type: 'run.end', data: { reason: raw.reason } };
    default:
      return { ...base, type: `other.${raw.hook_event_name}`, data: {} }; // the type is enough: nothing reads the payload
  }
}
