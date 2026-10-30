import { git } from './git.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Agent, AGENTS, fromAgent, toAgent } from './agents.js';
import { ensureDaemon } from './daemon.js';
import { noteEdit, onStop } from './done.js';
import { toArcroomEvent } from './events.js';
import { noteDir } from './code.js';
import { fence } from './fence.js';
import { redact, rememberSecrets } from './redact.js';
import { ARCROOM_HOME, isOff, keyRefused } from './home.js';
import { type Lookup, lookupFast } from './lookup.js';
import { checkLoop, sessionFile } from './loop.js';
import { type Kind, pack, type Piece } from './pack.js';
import { lastRunNote, projectOf } from './session.js';
import { bump, MARK, signFor, toolResult } from './signs.js';
import { costSinceClaim, markClaim, turnUsage } from './usage.js';

// Claude Code runs this for every hook event, with the event JSON on stdin.
// It turns the event into ArcRoom run events and appends them to the local queue (spool.jsonl),
// which the daemon drains: nothing is lost if the daemon is down or the machine is offline.
//   - PreToolUse: loop guard (can deny); Stop: done-checks (can block) + token usage of the turn
//   - context events log every piece of text ArcRoom injects into the agent (the context ledger)
//   - memory.* events record reuse / replay / cost of ArcRoom tool calls (tokens saved)
// What ArcRoom did is shown to the user as one short line (systemMessage). Claude Code takes ONE JSON object
// on stdout, so every part adds to `out` and it is written once at the end.
// It must never slow down or break a session: any error lets the call through, exit is always 0.

// Every prompt without a hit gets this short note; a hit gets the stored steps or answer instead.
// Code changes are recorded from the trace by the hooks, so the agent is told not to save them by hand:
// find/claim/complete on a code change only added calls (and duplicate step versions) in the benchmark.
const REMINDER =
  'ArcRoom team memory is on and records code changes by itself: for those, do not call the mcp__arcroom__ tools. ' +
  'For a question, lookup or analysis someone could reuse, call mcp__arcroom__find_task first (reuse: answer from it; ' +
  'none: claim_task, do it, complete_task with the answer). A request with several parts: split_task. ' +
  'Learned something lasting (a fact about this project, or a decision and why)? Save it with mcp__arcroom__remember.';
const OUR_TOOLS = 'mcp__arcroom__';

export async function hook(): Promise<void> {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    // Codex, Cursor and OpenCode call this same handler with --agent; their payloads become Claude Code's here
    const flag = process.argv.indexOf('--agent');
    const agent: Agent = flag > 0 && (AGENTS as readonly string[]).includes(process.argv[flag + 1]) ? (process.argv[flag + 1] as Agent) : 'claude';
    const raw = fromAgent(JSON.parse(input), agent);
    if (isOff(raw.cwd)) return; // switched off for this repo by this person (arcroom off): nothing recorded or sent
    if (keyRefused()) return; // the key was revoked or its account deleted: nothing runs until a new key (arcroom init)
    rememberSecrets(raw.cwd); // this project's .env values are redacted wherever they show up
    const name: string = raw.hook_event_name;
    const session = String(raw.session_id);
    const out: Record<string, any> = {};
    const say = (message: string) => (out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${message}` : message);

    // the local queue holds redacted events only, in a folder and file only this user can read
    const spool = join(ARCROOM_HOME, 'spool.jsonl');
    mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
    const queue = (e: unknown) => appendFileSync(spool, JSON.stringify(redact(e)) + '\n', { mode: 0o600 });
    const emit = (type: string, data: Record<string, unknown>) => queue({ ...toArcroomEvent(raw), type, data });
    const injected = (kind: string, text: string, keepText = false) =>
      emit('context', { kind, chars: text.length, ...(keepText ? { text: text.slice(0, 2000) } : {}) });

    // Token meter: the turn's usage goes in before its turn.end, so the report built at turn.end includes it.
    // After each tool call too, so the website shows a long turn's tokens while it runs.
    if (name === 'Stop' || name === 'SessionEnd' || name === 'PostToolUse') {
      const usage = turnUsage(session, raw.transcript_path);
      if (usage) emit('usage', usage);
    }

    const event = toArcroomEvent(raw);
    const project = name === 'SessionStart' && raw.cwd ? projectOf(raw.cwd) : undefined;
    // lets the next session find this run as "last run here"; project_id puts the run in the website's project
    const projectId = process.argv.includes('--project') ? process.argv[process.argv.indexOf('--project') + 1] : undefined;
    // cwd turns the trace's absolute paths into project paths when steps are built from it
    // the branch lets the Room label memories made on a branch that is not merged yet
    const branch = project ? git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: raw.cwd }).stdout?.trim() : undefined;
    if (project) event.data = { ...event.data, project, cwd: raw.cwd, ...(branch ? { branch } : {}), ...(projectId ? { project_id: projectId } : {}) };
    // which agent is editing: other agents are told who is changing a file (the daemon adds the file's repo and folder)
    if (name === 'PreToolUse') event.data = { ...event.data, agent };
    if (name === 'PreToolUse' && raw.cwd) noteDir(session, raw.cwd, raw.tool_input?.file_path ?? raw.tool_input?.notebook_path);
    const stop = name === 'Stop' ? onStop(raw) : undefined;
    if (stop) event.data = stop.data;
    queue(event);
    // a patch that touched several files: one step per file
    if (name === 'PreToolUse') for (const f of raw.more_files ?? []) emit('tool.start', { tool: raw.tool_name, input: { file_path: f } });

    if (stop?.block) {
      out.decision = 'block';
      out.reason = stop.block;
      injected('block', stop.block);
      say(`${MARK} · asked the agent to run the done-checks (${stop.data.blocked}) before stopping`);
    } else if (stop?.unapproved) say(`${MARK} · done-checks in .arcroom.json are new or changed, not asked for: read them with arcroom checks`);
    else if (stop?.data.outcome === 'partial') say(`${MARK} · stopped as partial: done-checks not run or still failing`);
    else if (stop?.data.outcome === 'done') say(`${MARK} · done-checks passed`);

    if (name === 'UserPromptSubmit') {
      // Tool descriptions alone don't change an agent's habits; a per-prompt reminder does.
      // Code answers go stale when the code changes: tie them to the current commit.
      // ponytail: uncommitted edits aren't in the key; add a diff hash if stale code answers show up
      const commit = git(['rev-parse', '--short', 'HEAD'], { cwd: raw.cwd }).stdout?.trim();
      const reminder = commit
        ? `${REMINDER} For questions about this repo's code, include "commit": "${commit}" in inputs so the answer is reused only while the code is unchanged.`
        : REMINDER;
      // Recall: was this task done before? The hook asks, so the agent need not remember to.
      // memories already handed over in this session are not repeated
      const givenFile = sessionFile(session, '.recalled');
      const given = new Set<string>(existsSync(givenFile) ? JSON.parse(readFileSync(givenFile, 'utf8')) : []);
      // recall and the code map (folder summaries, who is editing what) in one lookup, by the warm daemon when it runs
      const prompt = String(raw.prompt ?? '');
      const found: Lookup = raw.cwd ? await lookupFast(prompt, raw.cwd, session, given) : { recall: {} };
      // otherwise a timeout looks the same as "nothing found"
      if (found.offline) say(`${MARK} · memory offline, prompt sent without it`);
      const { stale, weights } = found.recall;
      // everything found shares one budget, most useful first (pack.ts); what does not fit is not handed over
      const kept = new Map<Kind, string>(
        pack(
          [
            found.recall.pointer && { kind: 'recall' as const, text: found.recall.pointer.text, value: found.recall.pointer.value },
            found.recall.playbook && { kind: 'playbook' as const, text: found.recall.playbook.text, value: found.recall.playbook.value },
            found.recall.knowledge && { kind: 'knowledge' as const, text: found.recall.knowledge.text, value: found.recall.knowledge.value },
            found.code && { kind: 'code' as const, text: found.code.text, value: found.code.value },
          ].filter((p): p is Piece => !!p),
          prompt,
          weights,
        ).map((p) => [p.kind, p.text]),
      );
      const pointer = kept.has('recall') ? { ...found.recall.pointer!, text: kept.get('recall')! } : undefined;
      const playbook = kept.has('playbook') ? { ...found.recall.playbook!, text: kept.get('playbook')! } : undefined;
      const knowledge = kept.has('knowledge') ? { ...found.recall.knowledge!, text: kept.get('knowledge')! } : undefined;
      const code = kept.has('code') ? { ...found.code!, text: kept.get('code')! } : undefined;
      if (code) {
        injected('code', code.text, true);
        say(`${MARK} · code map: ${code.summaries} folder summar${code.summaries === 1 ? 'y' : 'ies'}${code.editing ? `, ${code.editing} agent${code.editing > 1 ? 's' : ''} editing nearby` : ''}`);
      }
      if (stale) {
        // its files are gone from this checkout: two such reports retire the steps
        emit('memory.stale', { memo_id: stale });
        say(`${MARK} · skipped stored steps: their files are not in this checkout`);
      }
      if (knowledge) {
        for (const id of knowledge.ids) given.add(id);
        injected('knowledge', knowledge.text, true);
        say(`${MARK} · ${knowledge.ids.length} team fact${knowledge.ids.length > 1 ? 's' : ''} or decision${knowledge.ids.length > 1 ? 's' : ''} for this request`);
      }
      if (playbook) {
        given.add(playbook.memoId);
        injected('playbook', playbook.text, true);
        say(`${MARK} · a playbook from ${playbook.runs} similar runs`);
      }
      if (pointer) given.add(pointer.memoId);
      // what `arcroom wrong` reports when the person says the memory just handed over was wrong
      const last = pointer ?? (playbook && { memoId: playbook.memoId, intent: 'playbook' });
      if (last) writeFileSync(join(ARCROOM_HOME, 'last-recall.json'), JSON.stringify({ memo_id: last.memoId, intent: last.intent }));
      if (pointer || knowledge || playbook) writeFileSync(givenFile, JSON.stringify([...given]));
      if (pointer) {
        injected('recall', pointer.text, true);
        // the turn's outcome credits (or heals) these steps when the turn ends
        if (pointer.kind === 'steps') emit('memory.replayed', { memo_id: pointer.memoId });
        else emit('memory.reused', { memo_id: pointer.memoId, version: pointer.version });
        bump(session, pointer.kind === 'steps' ? 'replayed' : 'reused');
        say(`${MARK} · ${pointer.kind === 'steps' ? 'steps from a past run' : 'a team answer'}${pointer.similar ? ' for a similar task' : ''}: ${pointer.intent.slice(0, 70)}`);
      }
      // a hit is the lookup already done: the reminder would only send the agent to find_task for it again
      // what teammates' agents wrote goes in one fenced block of data (fence.ts); ArcRoom's own reminder stays outside it
      const memory = [pointer?.text ?? playbook?.text, ...[...kept].filter(([k]) => k === 'knowledge' || k === 'code').map(([, t]) => t)].filter(Boolean);
      const context = [pointer || playbook ? '' : reminder, memory.length ? fence(memory.join('\n\n')) : ''].filter(Boolean).join('\n\n');
      out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
      if (!pointer && !playbook) injected('reminder', reminder);
    }

    if (name === 'PreToolUse') {
      const reason = checkLoop(session, raw.tool_name, raw.tool_input);
      if (reason) {
        const blocked = { ...toArcroomEvent(raw), type: 'tool.blocked' };
        blocked.data = { ...blocked.data, reason: 'loop' };
        queue(blocked);
        out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
        injected('deny', reason);
        say(`${MARK} · blocked a repeated ${String(raw.tool_name).replace(OUR_TOOLS, '')} call (same input 3 times in a row)`);
        bump(session, 'blocked');
      } else noteEdit(raw);
    }

    // a done-check the agent ran with Bash (the Stop hook asks for them; it never runs them itself)
    if (name === 'PostToolUse' && raw.tool_name === 'Bash') noteEdit(raw);

    if (name === 'PostToolUse' && String(raw.tool_name).startsWith(OUR_TOOLS)) {
      const tool = raw.tool_name.slice(OUR_TOOLS.length);
      const result = toolResult(raw.tool_response);
      const sign = signFor(tool, raw.tool_input, result);
      if (sign) {
        say(sign.message);
        if (sign.stat) bump(session, sign.stat);
      }
      // Savings: what an answer cost to make (claim -> complete), and every reuse / replay of it.
      if (tool === 'find_task' && result?.match === 'reuse') emit('memory.reused', { memo_id: result.memo_id, version: result.version?.version });
      // what a reused answer cost to make is what this reuse saved (status line)
      if (tool === 'find_task' && result?.match === 'reuse' && result.version?.cost_tokens) bump(session, 'tokens_saved', Number(result.version.cost_tokens));
      if (tool === 'find_task' && result?.match === 'replay') emit('memory.replayed', { memo_id: result.memo_id });
      if (tool === 'split_task')
        for (const p of result?.parts ?? []) {
          if (p.match === 'reuse') emit('memory.reused', { memo_id: p.memo_id, version: p.version?.version });
          if (p.match === 'reuse') bump(session, 'reused');
          if (p.match === 'reuse' && p.version?.cost_tokens) bump(session, 'tokens_saved', Number(p.version.cost_tokens));
          if (p.match === 'replay') emit('memory.replayed', { memo_id: p.memo_id });
        }
      if (tool === 'claim_task' && result?.claimed) markClaim(session, raw.transcript_path, result.memo_id);
      if (tool === 'complete_task' && result?.version) {
        const cost = costSinceClaim(session, raw.transcript_path, result.memo_id);
        emit('memory.cost', { memo_id: result.memo_id, version: result.version, tokens: cost.tokens, model: cost.model });
      }
    }

    if (project) {
      // Session memory: start with what the last run in this project did. Slow or offline API = no note.
      const note = await lastRunNote(session, project).catch(() => undefined);
      if (note) {
        // the last run here may be a teammate's: its ask is their words, so it is fenced like any memory
        out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: fence(note) };
        injected('last_run', note, true);
      }
      // say what leaves the laptop, every session (events.ts keeps it to that)
      say(`${MARK} · on: team memory · sends prompts, file paths and commands (no file contents)${note ? ' · picked up where the last run here left off' : ''}`);
    }

    const reply = toAgent(agent, name, out, session);
    if (Object.keys(reply).length) process.stdout.write(JSON.stringify(reply));
    ensureDaemon(process.argv[1]);
  } catch {
    // ponytail: errors are swallowed so a broken hook never stops a session; add a log file when debugging needs it
  }
}
