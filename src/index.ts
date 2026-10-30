#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeSetup, forgetBlind, gitRoot, repoKey, writeSetup } from './blind.js';
import { daemon } from './daemon.js';
import { doctor, print } from './doctor.js';
import { approveChecks, checksHash, isApproved, loadChecks, readApprovals } from './done.js';
import { syncTree } from './tree.js';
import { api, ARCROOM_HOME, loadConfig, setOff } from './home.js';
import { hook } from './hook.js';
import { init } from './init.js';
import { mcp } from './mcp.js';
import { readStats, statusText } from './signs.js';
import { sessionUsage, tokensOf } from './usage.js';

const [cmd, ...args] = process.argv.slice(2);

// A command someone typed that fails prints one line, not a stack trace (the hook, daemon and MCP server keep their own handling).
if (!['hook', 'daemon', 'mcp', 'status'].includes(cmd))
  process.on('uncaughtException', (e) => {
    console.error(`arcroom${cmd ? ` ${cmd}` : ''}: ${e.message}`);
    process.exit(1);
  });

if (cmd === 'init') await init(args);
else if (cmd === 'hook') await hook();
else if (cmd === 'daemon') await daemon();
else if (cmd === 'mcp') await mcp();
else if (cmd === 'doctor') {
  if (!print(await doctor())) process.exitCode = 1;
} else if (cmd === 'whoami') {
  const me = await api(loadConfig(), '/v1/me');
  console.log(`${me.email ?? 'shared key (no person)'} in workspace "${me.workspace}" (key ${me.key_label ?? 'unlabelled'}, made ${me.key_created_at})`);
} else if (cmd === 'status') {
  // Claude Code status line: gets the session JSON on stdin, prints one line. Must be fast and never fail.
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let session = '';
  let used = 0;
  try {
    const raw = JSON.parse(input);
    session = raw.session_id ?? '';
    if (session) used = tokensOf(sessionUsage(session, raw.transcript_path));
  } catch {}
  console.log(statusText(session ? readStats(session) : readStats('none'), used));
} else if (cmd === 'rule') {
  // arcroom rule [--tag <tag>] [--max-hits N] [--idle-days D]   (no limits = remove the rule)
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const num = (name: string) => (opt(name) === undefined ? null : Number(opt(name)));
  const res = await api(loadConfig(), '/v1/rules', { tag: opt('--tag') ?? null, max_hits: num('--max-hits'), idle_days: num('--idle-days') });
  console.log(res.rule ? `rule set: ${JSON.stringify(res.rule)}` : 'rule removed');
} else if (cmd === 'wrong' || cmd === 'share') {
  // arcroom wrong [memo id] [reason]: the memory just handed over (or the one named) was wrong
  // arcroom share [memo id]: share your new steps with the team before their second pass
  const lastFile = join(ARCROOM_HOME, 'last-recall.json');
  const named = /^[0-9a-f-]{36}$/i.test(args[0] ?? '') ? args.shift() : undefined;
  const last = named ? { memo_id: named, intent: named } : existsSync(lastFile) ? JSON.parse(readFileSync(lastFile, 'utf8')) : undefined;
  if (!last) console.log('no memory was handed over yet; pass its id (see the Memory page)');
  else if (cmd === 'share') {
    await api(loadConfig(), '/v1/memory/share', { memo_id: last.memo_id });
    console.log(`shared with the team: ${last.intent}`);
  } else {
    const r = await api(loadConfig(), '/v1/memory/wrong', { memo_id: last.memo_id, reason: args.join(' ') || null });
    const what = r.deleted
      ? 'deleted (2 people said wrong)'
      : r.steps_broken
        ? 'steps broken, the last good version takes over'
        : r.answer_thrown_away
          ? 'answer thrown away'
          : `noted (${r.reports} of 2 reports delete it)`;
    console.log(`reported wrong: ${last.intent} · ${what}`);
  }
} else if (cmd === 'code') {
  // arcroom code [status|sync|on|off]: the Code wing for the repo you are in (paths and git hashes, never code)
  const s = codeSetup(process.cwd());
  const sub = args[0] ?? 'status';
  if (!s) console.log('not inside a git repo');
  else if (sub === 'off' || sub === 'on') {
    writeSetup(s.root, { code: sub === 'off' ? 'off' : undefined });
    forgetBlind(s.root); // the person here chose it: this laptop stops holding the repo to Blind
    console.log(`Code wing ${sub} for ${s.root} (commit .arcroom.json so the team gets the same setting)`);
  } else if (s.mode !== 'standard') console.log(`Code wing is ${s.mode} for this repo${s.mode === 'off' ? ': arcroom code on turns it on' : ''}`);
  else if (sub === 'sync') {
    const r = await syncTree(loadConfig(), s);
    console.log(`sent ${r.nodes} folders and files (repo ${repoKey(s)})`);
  } else {
    const repos: any[] = await api(loadConfig(), '/v1/code/tree');
    const me = repos.find((x) => x.repo === repoKey(s));
    console.log(
      me
        ? `${me.repo}: ${me.folders} folders, ${me.files} files, ${me.editing} agent(s) editing now, default branch ${me.default_branch}`
        : 'this repo has not sent its tree yet: arcroom code sync',
    );
  }
} else if (cmd === 'off' || cmd === 'on') {
  // arcroom off | on: ArcRoom for the repo you are in, on this laptop only (nothing traced or sent while off)
  const root = gitRoot(process.cwd()) ?? process.cwd();
  setOff(root, cmd === 'off');
  console.log(cmd === 'off' ? `ArcRoom is off for ${root}: nothing from it is recorded or sent` : `ArcRoom is on again for ${root}`);
} else if (cmd === 'checks') {
  // arcroom checks [approve <code>]: the done-checks in this folder's .arcroom.json, and whether they may run.
  // Approving needs the code printed next to the exact commands shown, so a later change to the file is never approved.
  const checks = loadChecks(process.cwd());
  const list = checks.map((c) => `  ${JSON.stringify(c)}`).join('\n');
  const code = checksHash(checks).slice(0, 8);
  if (!checks.length) console.log('no doneChecks in .arcroom.json here');
  else if (args[0] === 'approve' && !process.stdin.isTTY)
    // an agent's shell has no terminal: approving stays a step the person takes themselves (N14)
    console.log('not approved: run arcroom checks approve yourself, in a terminal (not through an agent)');
  else if (args[0] === 'approve') {
    const done = approveChecks(process.cwd(), args[1] ?? '');
    console.log(done ? `approved for ${process.cwd()} (after editing files, the agent is asked to run them with its Bash tool before it stops):\n${list}` : 'not approved: run arcroom checks, read the commands, then arcroom checks approve <the code it prints>');
  } else if (isApproved(process.cwd(), checks, readApprovals())) console.log(`${list}\napproved`);
  else
    console.log(`${list}\nnot approved: once approved, the agent is asked to run these with its Bash tool after it edits files (each run goes through its permission prompt).
To allow them: arcroom checks approve ${code}`);
} else if (cmd === 'decide') {
  // arcroom decide "<what was chosen>" [--why ...] [--over "A, B"] [--context ...] [--by ...] [--source <url>] [--replaces <memo id>]
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const text = args[0];
  if (!text || text.startsWith('--')) console.log('usage: arcroom decide "<what was chosen>" [--why ...] [--over "A, B"] [--context ...] [--by ...] [--source <url>] [--replaces <memo id>]');
  else {
    const over = opt('--over')?.split(',').map((o) => o.trim()).filter(Boolean);
    const url = opt('--source');
    const r = await api(loadConfig(), '/v1/memory/remember', {
      kind: 'decision',
      text,
      why: opt('--why') ?? null,
      ...(over ? { options: [text, ...over] } : {}),
      ...(opt('--context') ? { context: opt('--context') } : {}),
      ...(opt('--by') ? { decided_by: opt('--by') } : {}),
      ...(url ? { source: { kind: /\/pull\//.test(url) ? 'pr' : /\/issues\//.test(url) ? 'issue' : 'other', url } } : {}),
      ...(opt('--replaces') ? { replaces: opt('--replaces') } : {}),
    });
    console.log(`${r.saved ? 'decision saved' : 'decision already saved; detail updated'}${r.replaced ? ', the earlier one is replaced' : ''} (${r.memo_id})`);
  }
} else console.log('usage: arcroom init [--project <id>] (asks for the key; or set ARCROOM_API_KEY) [--url <arcroom api url>] | arcroom whoami | arcroom doctor | arcroom rule [--tag t] [--max-hits n] [--idle-days d] | arcroom wrong [memo id] [reason] | arcroom share [memo id] | arcroom decide "<choice>" [--why ...] [--over "A, B"] | arcroom code [status|sync|on|off] | arcroom checks [approve] | arcroom off | arcroom on');
