import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { type Agent, AGENTS, CURSOR_HOOKS, opencodePlugin } from './agents.js';
import { stopDaemon } from './daemon.js';
import { git, onPath, projectOf } from './git.js';
import { api, apiUrl, ARCROOM_HOME, DEFAULT_URL, isLocalUrl, keyRefused } from './home.js';
import { userSettings } from './scope.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MARK = '.arcroom/runtime'; // identifies our hook entries in a settings file
// node by its full path, never the word "node": an agent starting a hook inside a repo must not run a node.exe planted there
const NODE = process.execPath;
const nodeCmd = JSON.stringify(NODE);

type HookGroup = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

// After a tool, only a shell run (a done-check passing) and ArcRoom's own tools matter, so Claude Code launches the hook
// once per tool call instead of twice: each launch is a window flash on Windows (Git Bash, no console of its own).
export const AFTER_TOOLS = 'Bash|PowerShell|mcp__arcroom__.*';

/** Puts ArcRoom's hook on every event: replaces an earlier ArcRoom entry, keeps everyone else's hooks. */
export function withArcroomHooks(settings: Settings, command: string, anyTool = '*', afterTool = anyTool): Settings {
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    const others = (hooks[event] ?? []).filter((g) => !g.hooks.some((h) => h.command.includes(MARK)));
    const ours: HookGroup = { hooks: [{ type: 'command', command }] };
    if (TOOL_EVENTS.has(event)) ours.matcher = event === 'PostToolUse' ? afterTool : anyTool;
    hooks[event] = [...others, ours];
  }
  return { ...settings, hooks };
}

type CursorHooks = { version?: number; hooks?: Record<string, { command: string }[]>; [key: string]: unknown };

/** Cursor's .cursor/hooks.json with ArcRoom on its six lifecycle events, keeping everyone else's hooks. */
export function withCursorHooks(current: CursorHooks, command: string): CursorHooks {
  const hooks = { ...current.hooks };
  for (const event of CURSOR_HOOKS) hooks[event] = [...(hooks[event] ?? []).filter((h) => !h.command.includes(MARK)), { command }];
  return { ...current, version: current.version ?? 1, hooks };
}

/** Codex's config.toml with an [mcp_servers.arcroom] table (an earlier one replaced, everything else kept). */
export function withCodexMcp(toml: string, entry: string, node = NODE): string {
  const others = toml.replace(/\n?\[mcp_servers\.arcroom\][\s\S]*?(?=\n\[|$)/, '').trimEnd();
  const ours = `[mcp_servers.arcroom]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}, "mcp"]\n`;
  return (others ? `${others}\n\n` : '') + ours;
}

/**
 * Keeps the files init wrote out of commits, in this clone only (.git/info/exclude, never committed): they hold this
 * laptop's paths, so a `git add -A` would break a teammate's setup. A file the repo already tracks is left alone.
 */
export function keepOutOfGit(files: string[], cwd: string): string[] {
  const root = git(['rev-parse', '--show-toplevel'], { cwd }).stdout?.trim();
  const path = git(['rev-parse', '--git-path', 'info/exclude'], { cwd }).stdout?.trim();
  if (!root || !path) return [];
  const exclude = isAbsolute(path) ? path : join(cwd, path);
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8').split(/\r?\n/) : [];
  // git answers with the real path; a symlinked folder (macOS /var) or a short name (Windows RUNNER~1) would read as outside
  const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);
  const add = files
    .map((f) => '/' + relative(real(root), real(f)).replaceAll('\\', '/'))
    .filter((rel) => !rel.startsWith('/..') && !have.includes(rel) && git(['ls-files', '--error-unmatch', rel.slice(1)], { cwd: root }).status !== 0);
  if (!add.length) return [];
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, (have.length && have[have.length - 1] !== '' ? '\n' : '') + add.join('\n') + '\n');
  return add;
}

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

/**
 * The key and API URL init uses. Re-running init reuses what was saved, except a key the API refused (otherwise a new
 * key could never get in) and a local URL left from development (it moves to the live API and says so).
 */
export function initChoice(o: { argKey?: string; envKey?: string; argUrl?: string; saved: { apiKey?: string; url?: string } }) {
  const refused = !!o.saved.apiKey && keyRefused({ apiKey: o.saved.apiKey, url: o.saved.url ?? DEFAULT_URL });
  const key = o.argKey ?? o.envKey ?? (refused ? undefined : o.saved.apiKey);
  const dropLocal = !o.argUrl && !!o.saved.url && isLocalUrl(o.saved.url);
  const url = o.argUrl ?? (dropLocal ? DEFAULT_URL : o.saved.url ?? DEFAULT_URL);
  const notes = [
    ...(refused && !o.argKey && !o.envKey ? ['The saved key was refused by the API. Paste a new key (web app, Settings → API keys).'] : []),
    ...(dropLocal ? [`The saved API was ${o.saved.url}; using ${DEFAULT_URL} now (arcroom init --url ${o.saved.url} keeps a local API).`] : []),
  ];
  return { key, url, notes };
}

/**
 * The config after init saves `key` in `repo`. A key for another workspace than the laptop's working default becomes this
 * repo's own, and every other repo keeps sending where it did (a freelancer's two clients); otherwise it is the default.
 */
export function keysAfterInit(saved: any, repo: string, key: string, url: string, workspace?: string): any {
  const other = !!saved.apiKey && saved.apiKey !== key && !keyRefused({ apiKey: saved.apiKey, url }) && !!saved.workspace && !!workspace && saved.workspace !== workspace;
  const repos = { ...(saved.repos ?? {}) };
  if (other) repos[repo] = { apiKey: key, workspace };
  else delete repos[repo];
  const next = other ? { ...saved, url, repos } : { ...saved, apiKey: key, url, ...(workspace ? { workspace } : {}), repos };
  if (!Object.keys(next.repos).length) delete next.repos;
  if (other) console.log(`This repo sends to "${workspace}"; other repos on this laptop keep sending to "${saved.workspace}".`);
  else if (saved.workspace && workspace && saved.workspace !== workspace) console.error(`Note: this laptop's default is now "${workspace}" (was "${saved.workspace}").`);
  return next;
}

export async function init(args: string[]): Promise<void> {
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const agent = (arg('--agent') ?? 'claude') as Agent;
  if (!AGENTS.includes(agent)) {
    console.error(`--agent takes one of: ${AGENTS.join(', ')}`);
    process.exit(1);
  }
  const configFile = join(ARCROOM_HOME, 'config.json');
  const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}; // re-running init reuses saved values
  const repo = projectOf(process.cwd());
  const mine = saved.repos?.[repo]; // this repo's own key, when it has one
  const forRepo = mine ? { ...saved, apiKey: mine.apiKey, workspace: mine.workspace } : saved;
  const choice = initChoice({ argKey: arg('--key'), envKey: process.env.ARCROOM_API_KEY, argUrl: arg('--url'), saved: forRepo });
  let key = choice.key;
  const url = choice.url;
  if (arg('--key'))
    console.error('Note: a key typed on the command line stays in your shell history. Next time run arcroom init and paste it when asked, or set ARCROOM_API_KEY.');
  for (const note of choice.notes) console.error(note);
  try {
    apiUrl(url);
  } catch (e) {
    console.error(`${(e as Error).message}.`);
    process.exit(1);
  }
  if (!key) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    key = (await rl.question('ArcRoom API key: ')).trim();
    rl.close();
  }
  if (!key?.startsWith('ark_')) {
    console.error('That is not an ArcRoom key (it starts with ark_).');
    process.exit(1);
  }

  // 1. Check the key with the API, then remember it for this machine: a typo or a revoked key must not end in "ArcRoom is on".
  let workspace: string | undefined = forRepo.apiKey === key ? forRepo.workspace : undefined;
  try {
    const me = await api({ apiKey: key, url }, '/v1/me');
    workspace = me.workspace;
    console.log(`Connected to workspace "${me.workspace}"${me.email ? ` as ${me.email}` : ''}.`);
  } catch (e) {
    if (/invalid api key/.test((e as Error).message)) {
      console.error('The API refused this key. Make a new one in the web app (Settings → API keys) and run arcroom init again.');
      process.exit(1);
    }
    console.error(`Could not check the key (${(e as Error).message}); saved it anyway. Run arcroom doctor once you are online.`);
  }
  mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
  const cfg = keysAfterInit(saved, repo, key, url, workspace);
  cfg.setUp = [...new Set([...(cfg.setUp ?? []), repo])]; // laptop-wide hooks (--everywhere) act only in repos set up here
  writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  stopDaemon(); // the next hook event starts the updated one

  // 2. Copy the hook runtime to a stable place (npx's own copy is temporary).
  const runtime = join(ARCROOM_HOME, 'runtime');
  cpSync(dirname(fileURLToPath(import.meta.url)), runtime, {
    recursive: true,
    filter: (src) => !src.includes('.test.'),
  });
  writeFileSync(join(runtime, 'package.json'), '{ "type": "module" }\n');

  // 3. Wire Claude Code's hooks in this project to it, and pre-approve our MCP server (local file: paths are per machine).
  const entry = join(runtime, 'index.js').replaceAll('\\', '/');
  const file = join(process.cwd(), '.claude', 'settings.local.json');
  const current: Settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // The website's project for this folder (from "Connect a machine"); re-running init keeps the one set before.
  const project = arg('--project') ?? JSON.stringify(current.hooks ?? {}).match(/--project ([0-9a-f-]{36})/)?.[1];
  if (project && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project)) {
    console.error('--project takes the project id the website shows.');
    process.exit(1);
  }
  if (agent !== 'claude') return initOther(agent, entry, project);
  const settings = withArcroomHooks(current, `${nodeCmd} "${entry}" hook${project ? ` --project ${project}` : ''}`, '*', AFTER_TOOLS);
  // never pre-approve a server from the shared .mcp.json by name: a pull request could change what that name runs
  const approved = ((current.enabledMcpjsonServers as string[]) ?? []).filter((n) => n !== 'arcroom');
  if (approved.length) settings.enabledMcpjsonServers = approved;
  else delete settings.enabledMcpjsonServers;
  // Live badge at the bottom of Claude Code ("ArcRoom · live · 2 reused"), unless the project has its own status line.
  // It runs a command on every redraw, a window flash each time on Windows, so there it is only on with --status.
  const theirs = current.statusLine as { command?: string } | undefined;
  const status = process.platform !== 'win32' || args.includes('--status');
  if (status && (!theirs || theirs.command?.includes(MARK))) settings.statusLine = { type: 'command', command: `${nodeCmd} "${entry}" status`, padding: 0 };
  else if (!status && theirs?.command?.includes(MARK)) delete settings.statusLine;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

  // 4. Register the MCP server (find_task / claim_task / complete_task) for this project: in Claude Code's local scope
  // (this person, this folder) rather than the shared .mcp.json. An entry an earlier init wrote there is taken out.
  const mcpFile = join(process.cwd(), '.mcp.json');
  const mcpConfig = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, 'utf8')) : {};
  const local = addLocalMcp(entry);
  if (local) {
    if (String(mcpConfig.mcpServers?.arcroom?.args?.[0] ?? '').replaceAll('\\', '/').includes(MARK)) {
      delete mcpConfig.mcpServers.arcroom;
      writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2) + '\n');
    }
  } else {
    // no claude command found: the shared file, which Claude Code asks about before running
    mcpConfig.mcpServers = { ...mcpConfig.mcpServers, arcroom: { command: NODE, args: [entry, 'mcp'] } };
    writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2) + '\n');
  }

  const kept = keepOutOfGit([file, ...(local ? [] : [mcpFile])], process.cwd());
  // 5. --everywhere: the same hook and tools for every folder on this laptop (Claude Code's user settings and user scope),
  // acting only in repos set up here, so other clones and worktrees of this repo are covered too.
  const everywhere = args.includes('--everywhere');
  if (everywhere) {
    const user = userSettings();
    const mine = existsSync(user) ? JSON.parse(readFileSync(user, 'utf8')) : {};
    writeJson(user, withArcroomHooks(mine, `${nodeCmd} "${entry}" hook --user`, '*', AFTER_TOOLS));
    claudeCli(['mcp', 'remove', '--scope', 'user', 'arcroom']);
    claudeCli(['mcp', 'add', '--scope', 'user', 'arcroom', '--', NODE, entry, 'mcp', '--user']);
  }
  console.log(`ArcRoom is on for this project.
  key      ${join(ARCROOM_HOME, 'config.json')}
  hooks    ${file}
  tools    ${local ? 'Claude Code local scope (claude mcp list)' : `${mcpFile} (approve "arcroom" when Claude Code asks)`}${kept.length ? `\n  git      kept out of commits in this clone: ${kept.join(', ')}` : ''}${everywhere ? `\n  laptop   ${userSettings()}: every clone and worktree of a repo set up here` : ''}
Start a new Claude Code session here to begin capturing runs. Check it any time: arcroom doctor`);
}

/** Runs the claude command; null when it is not on PATH. */
function claudeCli(args: string[]): number | null {
  const claude = onPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']);
  if (!claude) return null;
  const run = (args: string[]) =>
    claude.endsWith('.cmd') // an npm install on Windows: a batch file runs through cmd, every argument quoted
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map((a) => `"${a}"`).join(' ')}"`], {
          windowsVerbatimArguments: true,
          windowsHide: true,
          encoding: 'utf8',
        })
      : spawnSync(claude, args, { encoding: 'utf8', windowsHide: true });
  return run(args).status;
}

/** `claude mcp add --scope local arcroom`: false when the claude command is not on PATH or the add failed. */
function addLocalMcp(entry: string): boolean {
  if (claudeCli(['mcp', 'remove', '--scope', 'local', 'arcroom']) === null) return false; // none yet is fine
  return claudeCli(['mcp', 'add', '--scope', 'local', 'arcroom', '--', NODE, entry, 'mcp']) === 0;
}

/** A hooks map without ArcRoom's entries (Claude Code and Codex group them; Cursor lists commands); empty events go. */
function withoutOurHooks(hooks: Record<string, any[]> | undefined): Record<string, any[]> | undefined {
  if (!hooks) return hooks;
  const ours = (h: any) => String(h?.command ?? '').includes(MARK) || (h?.hooks ?? []).some((x: any) => String(x?.command ?? '').includes(MARK));
  const next = Object.fromEntries(Object.entries(hooks).map(([event, list]) => [event, (list ?? []).filter((h) => !ours(h))]).filter(([, list]) => list.length));
  return Object.keys(next).length ? next : undefined;
}

/**
 * `arcroom uninstall [--all]`: takes out of this project what init put in for every agent (hooks, status line, MCP entries,
 * the OpenCode plugin), keeping everyone else's settings, and stops the uploader. --all also removes ~/.arcroom (the key,
 * the queue, the runtime). Returns what it changed.
 */
export function uninstall(
  cwd: string,
  all = false,
  removeLocalMcp = () => claudeCli(['mcp', 'remove', '--scope', 'local', 'arcroom']),
  removeUserMcp = () => claudeCli(['mcp', 'remove', '--scope', 'user', 'arcroom']),
): string[] {
  const changed: string[] = [];
  const edit = (file: string, change: (v: any) => any) => {
    if (!existsSync(file)) return;
    const before = JSON.parse(readFileSync(file, 'utf8'));
    const after = change(structuredClone(before));
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    if (!Object.keys(after).length) rmSync(file);
    else writeFileSync(file, JSON.stringify(after, null, 2) + '\n');
    changed.push(file);
  };
  const ourServer = (s: any) => JSON.stringify(s ?? '').replaceAll('\\\\', '/').includes(MARK);
  const hooksOf = (v: any) => {
    const hooks = withoutOurHooks(v.hooks);
    if (hooks) v.hooks = hooks;
    else delete v.hooks;
    if (String(v.statusLine?.command ?? '').includes(MARK)) delete v.statusLine;
    return v;
  };
  edit(join(cwd, '.claude', 'settings.local.json'), hooksOf);
  edit(join(cwd, '.codex', 'hooks.json'), hooksOf);
  edit(join(cwd, '.cursor', 'hooks.json'), (v) => {
    const hooks = withoutOurHooks(v.hooks);
    if (hooks) v.hooks = hooks;
    else delete v.hooks;
    return Object.keys(v).length === 1 && v.version !== undefined ? {} : v;
  });
  for (const file of [join(cwd, '.mcp.json'), join(cwd, '.cursor', 'mcp.json')])
    edit(file, (v) => {
      if (ourServer(v.mcpServers?.arcroom)) delete v.mcpServers.arcroom;
      if (v.mcpServers && !Object.keys(v.mcpServers).length) delete v.mcpServers;
      return v;
    });
  edit(join(cwd, 'opencode.json'), (v) => {
    if (ourServer(v.mcp?.arcroom)) delete v.mcp.arcroom;
    if (v.mcp && !Object.keys(v.mcp).length) delete v.mcp;
    return Object.keys(v).length === 1 && v.$schema ? {} : v;
  });
  const toml = join(cwd, '.codex', 'config.toml');
  if (existsSync(toml)) {
    const before = readFileSync(toml, 'utf8');
    const after = before.replace(/\n?\[mcp_servers\.arcroom\][\s\S]*?(?=\n\[|$)/, '').trimEnd();
    if (after !== before.trimEnd()) {
      if (after) writeFileSync(toml, after + '\n');
      else rmSync(toml);
      changed.push(toml);
    }
  }
  const plugin = join(cwd, '.opencode', 'plugins', 'arcroom.js');
  if (existsSync(plugin)) rmSync(plugin), changed.push(plugin);
  if (removeLocalMcp() === 0) changed.push('Claude Code local MCP entry "arcroom"');
  if (all) {
    edit(userSettings(), hooksOf);
    if (removeUserMcp() === 0) changed.push('Claude Code user MCP entry "arcroom"');
  }
  stopDaemon();
  if (all && existsSync(ARCROOM_HOME)) {
    rmSync(ARCROOM_HOME, { recursive: true, force: true });
    changed.push(ARCROOM_HOME);
  }
  return changed;
}

/** Steps 3 and 4 for Codex, Cursor and OpenCode: their own hook and MCP files, in this project. */
function initOther(agent: Agent, entry: string, project?: string) {
  const cwd = process.cwd();
  const command = `${nodeCmd} "${entry}" hook --agent ${agent}${project ? ` --project ${project}` : ''}`;
  const written: string[] = [];
  if (agent === 'codex') {
    // same events and payloads as Claude Code; its matchers are regular expressions
    const hooksFile = join(cwd, '.codex', 'hooks.json');
    writeJson(hooksFile, withArcroomHooks(readJson(hooksFile), command, '.*'));
    const configFile = join(cwd, '.codex', 'config.toml');
    writeFileSync(configFile, withCodexMcp(existsSync(configFile) ? readFileSync(configFile, 'utf8') : '', entry));
    written.push(hooksFile, configFile);
  } else if (agent === 'cursor') {
    const hooksFile = join(cwd, '.cursor', 'hooks.json');
    writeJson(hooksFile, withCursorHooks(readJson(hooksFile), command));
    const mcpFile = join(cwd, '.cursor', 'mcp.json');
    const mcp = readJson(mcpFile);
    writeJson(mcpFile, { ...mcp, mcpServers: { ...mcp.mcpServers, arcroom: { type: 'stdio', command: NODE, args: [entry, 'mcp'] } } });
    written.push(hooksFile, mcpFile);
  } else {
    const configFile = join(cwd, 'opencode.json');
    const config = readJson(configFile);
    writeJson(configFile, {
      $schema: 'https://opencode.ai/config.json',
      ...config,
      mcp: { ...config.mcp, arcroom: { type: 'local', command: [NODE, entry, 'mcp'], enabled: true } },
    });
    const pluginFile = join(cwd, '.opencode', 'plugins', 'arcroom.js');
    mkdirSync(dirname(pluginFile), { recursive: true });
    writeFileSync(pluginFile, opencodePlugin(entry, project, NODE));
    written.push(configFile, pluginFile);
  }
  const next: Record<string, string> = {
    codex: 'Trust this project in Codex, then approve the ArcRoom hooks once with /hooks.',
    cursor: 'Restart Cursor. Cursor adds context only after a tool call, so team memory reaches the agent on its first tool use.',
    opencode: "Restart OpenCode. Experimental: per-prompt recall rides OpenCode's experimental system-prompt hook, so it may change with OpenCode.",
  };
  const kept = keepOutOfGit(written, cwd);
  console.log(`ArcRoom is on for ${agent} in this project.
  key      ${join(ARCROOM_HOME, 'config.json')}
${written.map((f) => `  wrote    ${f}`).join('\n')}${kept.length ? `\n  git      kept out of commits in this clone: ${kept.join(', ')}` : ''}
${next[agent]}
Check it any time: arcroom doctor`);
}
