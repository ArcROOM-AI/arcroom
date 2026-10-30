import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashFiles } from './fresh.js';
import { ARCROOM_HOME } from './home.js';
import { sessionFile } from './loop.js';

// Finish line: on Stop, if this turn edited files, the project's done-checks (.arcroom.json "doneChecks") must have passed
// since the last edit. The hook never runs them itself: it blocks the stop and asks the agent to run them with its own
// Bash tool, so the agent's permission prompt shows every run (a test file or package script the agent just edited can
// not run behind the person's back). A Bash call that ran a check and succeeded counts as passed; an edit after it
// clears that. At most MAX_BLOCKS blocks in a row, then the stop is let go as partial.
// Checks are asked for only once the person approved these exact commands for this folder (`arcroom checks approve`):
// a cloned repo, a pull request or an agent's edit that adds or changes them asks for nothing until then.

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const MAX_BLOCKS = 2;
const MAX_PASSED = 50;

/** passed: Bash commands that succeeded since the turn's last edit */
export type DoneState = { edited: boolean; blocks: number; touched?: string[]; passed?: string[] };
const FILE_TOOLS = new Set(['Read', ...EDIT_TOOLS]);
const MAX_TOUCHED = 200;
export type StopResult = { data: Record<string, unknown>; block?: string; unapproved?: boolean };

/** A Bash result that did not fail: Claude Code reports failures apart; other agents carry an exit code. */
const succeeded = (r: any) =>
  typeof r === 'string'
    ? !/^Error: Exit code [1-9]/.test(r)
    : !(r && typeof r === 'object' && (r.interrupted || r.is_error || r.isError || [r.exit_code, r.exitCode, r.returncode].some((c) => typeof c === 'number' && c !== 0)));

/** True when this Bash command ran the check: as written, or last after `cd … &&` / `;`. */
export const ranCheck = (command: string, check: string) => {
  const c = check.trim();
  return command === c || command.endsWith(`&& ${c}`) || command.endsWith(`; ${c}`);
};

/**
 * Records an edit when this tool call changes files, every file the turn reads or writes (for their hashes), and every
 * Bash command that succeeded since the last edit (a done-check the agent ran).
 */
export function track(state: DoneState, raw: Record<string, any>): DoneState {
  if (raw.hook_event_name === 'PostToolUse' && raw.tool_name === 'Bash') {
    const command = String(raw.tool_input?.command ?? '').trim();
    const passed = state.passed ?? [];
    if (!command || command.length > 500 || passed.includes(command) || passed.length >= MAX_PASSED || !succeeded(raw.tool_response)) return state;
    return { ...state, passed: [...passed, command] };
  }
  if (raw.hook_event_name !== 'PreToolUse' || !FILE_TOOLS.has(raw.tool_name)) return state;
  const path = raw.tool_input?.file_path ?? raw.tool_input?.notebook_path;
  const touched = state.touched ?? [];
  const more = typeof path === 'string' && !touched.includes(path) && touched.length < MAX_TOUCHED ? [...touched, path] : touched;
  const edited = state.edited || EDIT_TOOLS.has(raw.tool_name);
  // a change after a check ran means it has to run again
  const stale = EDIT_TOOLS.has(raw.tool_name) && state.passed !== undefined;
  if (edited === state.edited && more === touched && !stale) return state;
  const { passed: _passed, ...rest } = state;
  return { ...(stale ? rest : state), edited, ...(more.length ? { touched: more } : {}) };
}

/** The touched files' blob hashes for turn.end: the steps built from this turn keep them (hashes only). */
const filesOf = (state: DoneState, cwd: string) => {
  const files = state.touched?.length && cwd ? hashFiles(cwd, state.touched) : {};
  return Object.keys(files).length ? { files } : {};
};

/** Block, or let the stop go as done/partial, from the checks not passed yet and the blocks so far in a row. */
export function decide(pending: string[], blocks: number): 'done' | 'block' | 'partial' {
  if (!pending.length) return 'done';
  return blocks < MAX_BLOCKS ? 'block' : 'partial';
}

export function blockReason(pending: string[], cwd: string): string {
  return (
    `ArcRoom done-checks: before you stop, run ${pending.length > 1 ? 'each of these' : 'this'} with your Bash tool from ${cwd}, ` +
    `exactly as written, and fix anything that fails:\n${pending.map((c) => `- \`${c}\``).join('\n')}`
  );
}

export function loadChecks(cwd: string): string[] {
  const file = join(cwd, '.arcroom.json');
  if (!existsSync(file)) return [];
  const checks = JSON.parse(readFileSync(file, 'utf8')).doneChecks;
  // control characters (escape codes, carriage returns, newlines) could hide a command from the person approving it
  return Array.isArray(checks) ? checks.filter((c) => typeof c === 'string' && c.trim() && !/[\x00-\x1f\x7f]/.test(c)) : [];
}

/** folder -> sha256 of the done-checks approved there */
export type Approvals = Record<string, string>;
const APPROVED = join(ARCROOM_HOME, 'approved-checks.json');
export const checksHash = (checks: string[]) => createHash('sha256').update(JSON.stringify(checks)).digest('hex');

export function readApprovals(): Approvals {
  try {
    return JSON.parse(readFileSync(APPROVED, 'utf8'));
  } catch {
    return {};
  }
}

/** True only when these exact commands were approved for this folder. */
export const isApproved = (cwd: string, checks: string[], approvals: Approvals) => approvals[resolve(cwd)] === checksHash(checks);

/** `arcroom checks approve <code>`: the person approves the folder's done-checks they were shown (`code` = the first
 *  8 characters of their hash, printed by `arcroom checks`); null when the file no longer holds those checks. */
export function approveChecks(cwd: string, code: string): string[] | null {
  const checks = loadChecks(cwd);
  if (code.length < 8 || !checksHash(checks).startsWith(code)) return null;
  const approvals = { ...readApprovals(), [resolve(cwd)]: checksHash(checks) };
  mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(APPROVED, JSON.stringify(approvals, null, 2) + '\n', { mode: 0o600 });
  return checks;
}

const read = (file: string): DoneState => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { edited: false, blocks: 0 });

/** PreToolUse / PostToolUse: remember what this turn edited, and the Bash commands that passed after that. */
export function noteEdit(raw: Record<string, any>): void {
  const file = sessionFile(String(raw.session_id), '.done');
  const state = read(file);
  const next = track(state, raw);
  if (next !== state) writeFileSync(file, JSON.stringify(next));
}

/** Stop: the turn.end data and, when checks fail, a block reason. Any error lets Claude stop. */
export function onStop(raw: Record<string, any>): StopResult {
  try {
    const file = sessionFile(String(raw.session_id), '.done');
    const state = read(file);
    const found = state.edited ? loadChecks(raw.cwd) : [];
    const unapproved = found.length > 0 && !isApproved(raw.cwd, found, readApprovals());
    const checks = unapproved ? [] : found;
    if (!checks.length) {
      writeFileSync(file, JSON.stringify({ edited: false, blocks: 0 }));
      return { data: filesOf(state, raw.cwd), ...(unapproved ? { unapproved } : {}) };
    }
    const pending = checks.filter((c) => !(state.passed ?? []).some((command) => ranCheck(command, c)));
    // stop_hook_active is false on a fresh stop, so an old count never carries over
    const blocks = raw.stop_hook_active ? state.blocks : 0;
    const verdict = decide(pending, blocks);
    if (verdict === 'block') {
      writeFileSync(file, JSON.stringify({ ...state, edited: true, blocks: blocks + 1 }));
      return { data: { blocked: pending[0] }, block: blockReason(pending, raw.cwd) };
    }
    writeFileSync(file, JSON.stringify({ edited: false, blocks: 0 }));
    // which checks passed (or not) is the proof a stored procedure carries; the files' hashes say where it was true
    return { data: { outcome: verdict, checks, ...filesOf(state, raw.cwd) } };
  } catch {
    return { data: {} };
  }
}
