import { git } from './git.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Agent, AGENTS, fromAgent, toAgent } from './agents.js';
import { ensureDaemon } from './daemon.js';
import { EDIT_TOOLS, noteEdit, onStop, SHELL_TOOLS } from './done.js';
import { OUR_TOOL, TOOL_PREFIX, toArcroomEvent } from './events.js';
import { editClash, noteDir } from './code.js';
import { fence } from './fence.js';
import { redact, rememberSecrets } from './redact.js';
import { ARCROOM_HOME, isOff, keyRefused, loadConfig } from './home.js';
import { type Lookup, lookupFast } from './lookup.js';
import { checkLoop, sessionFile } from './loop.js';
import { cutsOf, type Kind, pack, type Piece } from './pack.js';
import { logHanded } from './handed.js';
import { clashLine, compactReset, noteStory, projectOf, startNotes, takeOpen } from './session.js';
import { hasTask } from './recall.js';
import { laptopHookActs, pluginHookActs } from './scope.js';
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
  `ArcRoom team memory is on and records code changes by itself: for those, do not call the ${TOOL_PREFIX} tools. ` +
  `For a question, lookup or analysis someone could reuse, call ${TOOL_PREFIX}find_task first (reuse: answer from it; ` +
  'none: claim_task, do it, complete_task with the answer). A request with several parts: split_task. ' +
  `Learned something lasting (a fact about this project, or a decision and why)? Save it with ${TOOL_PREFIX}remember.`;

export async function hook(): Promise<void> {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    // Codex, Cursor and OpenCode call this same handler with --agent; their payloads become Claude Code's here
    const flag = process.argv.indexOf('--agent');
    const agent: Agent = flag > 0 && (AGENTS as readonly string[]).includes(process.argv[flag + 1]) ? (process.argv[flag + 1] as Agent) : 'claude';
    const raw = fromAgent(JSON.parse(input), agent);
    if (isOff(raw.cwd)) return; // switched off for this repo by this person (arcroom off): nothing recorded or sent
    if (process.argv.includes('--user') && !laptopHookActs(raw.cwd)) return; // laptop-wide hook: only set-up repos, never twice
    if (process.argv.includes('--plugin') && !pluginHookActs(raw.cwd)) return; // init's hooks already record here
    if (!loadConfig(raw.cwd).apiKey) {
      // the plugin installs without a key: nothing is recorded until one is saved, said once, at session start
      if (raw.hook_event_name === 'SessionStart')
        process.stdout.write(JSON.stringify(toAgent(agent, 'SessionStart', { systemMessage: `${MARK} · not connected yet: run npx arcroom login in a terminal (key from arcroomai.com, Settings → API keys), then start a new session.` }, String(raw.session_id))));
      return;
    }
    if (keyRefused(loadConfig(raw.cwd))) {
      // the key was revoked or its account deleted: nothing runs until a new key (arcroom init); said once, at session start
      if (raw.hook_event_name === 'SessionStart')
        process.stdout.write(JSON.stringify(toAgent(agent, 'SessionStart', { systemMessage: `${MARK} · stopped: the API refused this laptop's key. Run arcroom init with a new key (web app, Settings → API keys).` }, String(raw.session_id))));
      return;
    }
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
    if (name === 'Stop' || name === 'SessionEnd' || name === 'PreToolUse') {
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
    if (name === 'PreToolUse' && EDIT_TOOLS.has(raw.tool_name))
      noteStory(session, { files: [raw.tool_input?.file_path ?? raw.tool_input?.notebook_path, ...(raw.more_files ?? [])].filter((f) => typeof f === 'string') }, raw.cwd);
    // only asks with a task in them: "yes, do T10" or a background notice is not what the session is about
    if (name === 'UserPromptSubmit' && hasTask(String(raw.prompt ?? ''))) noteStory(session, { ask: String(raw.prompt ?? '') });
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
      // first prompt only: is a teammate already on this? (the list kept at session start, no API call)
      const clash = clashLine(prompt, takeOpen(session));
      if (clash) say(`${MARK} · a teammate may already be on this: told the agent to check with them`);
      const found: Lookup = raw.cwd ? await lookupFast(prompt, raw.cwd, session, given) : { recall: {} };
      // otherwise a timeout looks the same as "nothing found"
      if (found.offline) say(`${MARK} · memory offline, prompt sent without it`);
      const { stale, weights } = found.recall;
      // everything found shares one budget, most useful first (pack.ts); what does not fit is not handed over
      const { pointer: fp, playbook: fb, knowledge: fk } = found.recall;
      const pieces = ([
        fp && { kind: 'recall' as const, text: fp.text, value: fp.value, title: `${fp.kind === 'steps' ? 'steps' : 'answer'}: ${fp.intent}` },
        fb && { kind: 'playbook' as const, text: fb.text, value: fb.value, title: `playbook: ${fb.intent ?? ''}` },
        fk && { kind: 'knowledge' as const, text: fk.text, value: fk.value, title: fk.items.map((i) => `${i.kind}: ${i.text}`).join(' · ') },
        found.code && { kind: 'code' as const, text: found.code.text, value: found.code.value, title: 'code map' },
      ] as (Piece | undefined)[]).filter((p): p is Piece => !!p);
      const packed = pack(pieces, prompt, weights);
      const kept = new Map<Kind, string>(packed.map((p) => [p.kind, p.text]));
      // what came in, and what was found but cut for room (arcroom handed): titles and sizes only, on this laptop
      logHanded({
        session,
        cwd: raw.cwd,
        when: 'prompt',
        handed: [
          ...(clash ? [{ kind: 'clash', title: clash.slice(9, 129), chars: clash.length }] : []),
          ...packed.map((p) => ({ kind: p.kind, title: p.title, chars: p.text.length })),
        ],
        cut: cutsOf(pieces, packed),
      });
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
      // what `arcroom wrong` reports when the person says the memory just handed over was wrong: every memory handed over
      // (steps or answer, playbook, each fact and decision), so it can name the one that was wrong
      const handed = [
        ...(pointer ? [{ memo_id: pointer.memoId, kind: pointer.kind, text: pointer.intent }] : []),
        ...(playbook ? [{ memo_id: playbook.memoId, kind: 'playbook', text: playbook.intent ?? 'playbook' }] : []),
        ...(knowledge ? knowledge.items.map((i) => ({ memo_id: i.id, kind: i.kind, text: i.text })) : []),
      ];
      if (handed.length) writeFileSync(join(ARCROOM_HOME, 'last-recall.json'), JSON.stringify({ memo_id: handed[0].memo_id, intent: handed[0].text, handed }));
      if (pointer || knowledge || playbook) writeFileSync(givenFile, JSON.stringify([...given]));
      if (pointer) {
        injected('recall', pointer.text, true);
        // the turn's outcome credits (or heals) these steps when the turn ends
        const match = pointer.match ? { similar: true, match: pointer.match } : {};
        if (pointer.kind === 'steps') emit('memory.replayed', { memo_id: pointer.memoId, ...match });
        else emit('memory.reused', { memo_id: pointer.memoId, version: pointer.version, ...match });
        bump(session, pointer.kind === 'steps' ? 'replayed' : 'reused');
        say(`${MARK} · ${pointer.kind === 'steps' ? 'steps from a past run' : 'a team answer'}${pointer.similar ? ' for a similar task' : ''}: ${pointer.intent.slice(0, 70)}${pointer.match ? ` (match: ${pointer.match})` : ''}`);
      }
      // a hit is the lookup already done: the reminder would only send the agent to find_task for it again
      // what teammates' agents wrote goes in one fenced block of data (fence.ts); ArcRoom's own reminder stays outside it
      // the clash line quotes a teammate's ask, so it goes inside the fence with the rest of their words
      const memory = [clash, pointer?.text ?? playbook?.text,...[...kept].filter(([k]) => k === 'knowledge' || k === 'code').map(([, t]) => t)].filter(Boolean);
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
        say(`${MARK} · blocked a repeated ${String(raw.tool_name).replace(OUR_TOOL, '')} call (same input 3 times in a row)`);
        bump(session, 'blocked');
      } else {
        // two agents on one file: the first edit waits once, with who is on it (the same edit again goes through)
        const clash = EDIT_TOOLS.has(raw.tool_name)
          ? await editClash(loadConfig(raw.cwd), session, raw.cwd, raw.tool_input?.file_path ?? raw.tool_input?.notebook_path).catch(() => undefined)
          : undefined;
        if (clash) {
          out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: clash };
          injected('deny', clash);
          say(`${MARK} · another agent is editing this file: asked yours to check first`);
        } else noteEdit(raw);
      }
    }

    // a done-check the agent ran with Bash (the Stop hook asks for them; it never runs them itself)
    if (name === 'PostToolUse' && SHELL_TOOLS.has(raw.tool_name)) noteEdit(raw);

    if (name === 'PostToolUse' && OUR_TOOL.test(String(raw.tool_name))) {
      const tool = raw.tool_name.replace(OUR_TOOL, '');
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

    // After a compaction the agent only has Claude Code's summary: hand back this session's own asks and edited files,
    // and forget what was handed so far, so team facts and the full code map come again with the next prompt.
    const story = name === 'SessionStart' && raw.source === 'compact' ? compactReset(session) : undefined;
    if (story) {
      injected('compact', story, true);
      say(`${MARK} · handed this session's task back after compaction`);
    }
    let note: string | undefined;
    let openNote: string | undefined;
    if (project) {
      // Session memory: what the last run here did, and what teammates have open here now. Slow or offline API = no note.
      const root = git(['rev-parse', '--show-toplevel'], { cwd: raw.cwd }).stdout?.trim();
      const notes = await startNotes(session, project, branch, root).catch(() => ({ teammates: 0 }) as Awaited<ReturnType<typeof startNotes>>);
      note = notes.lastRun;
      openNote = notes.open;
      if (note) injected('last_run', note, true);
      if (openNote) injected('open_now', openNote, true);
      // say what leaves the laptop, every session (events.ts keeps it to that)
      const ws = loadConfig(raw.cwd).workspace;
      say(
        `${MARK} · on: team memory${ws ? ` in "${ws}"` : ''} · sends prompts, file paths and commands (no file contents)` +
          `${note ? ' · picked up where the last run here left off' : ''}` +
          `${notes.teammates ? ` · ${notes.teammates} teammate session${notes.teammates > 1 ? 's' : ''} open here` : ''}`,
      );
    }
    // Every session-start block goes out in ONE text: a second assignment would drop the first.
    // The session's own story is the person's own words (not fenced); the last run and open work may be teammates'
    // words, so they share one fence.
    const team = [note, openNote].filter(Boolean).join('\n\n');
    const start = [story, team ? fence(team) : ''].filter(Boolean).join('\n\n');
    if (start) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: start };
    if (name === 'SessionStart')
      logHanded({
        session,
        cwd: raw.cwd,
        when: story ? 'compact' : 'start',
        handed: [
          ...(story ? [{ kind: 'compact', title: "this session's asks and edited files", chars: story.length }] : []),
          ...(note ? [{ kind: 'last_run', title: note.split('\n')[0], chars: note.length }] : []),
          ...(openNote ? [{ kind: 'open_now', title: `${openNote.split('\n').length - 1} lines of teammates' open work`, chars: openNote.length }] : []),
        ],
        cut: [],
      });

    const reply = toAgent(agent, name, out, session);
    if (Object.keys(reply).length) process.stdout.write(JSON.stringify(reply));
    ensureDaemon(process.argv[1]);
  } catch {
    // ponytail: errors are swallowed so a broken hook never stops a session; add a log file when debugging needs it
  }
}
