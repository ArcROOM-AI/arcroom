import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { type Agent, AGENTS, CURSOR_HOOKS, opencodePlugin } from './agents.js';
import { stopDaemon } from './daemon.js';
import { onPath } from './git.js';
import { apiUrl, ARCROOM_HOME, DEFAULT_URL, isLocalUrl, keyRefused } from './home.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MARK = '.arcroom/runtime'; // identifies our hook entries in a settings file
// node by its full path, never the word "node": an agent starting a hook inside a repo must not run a node.exe planted there
const NODE = process.execPath;
const nodeCmd = JSON.stringify(NODE);

type HookGroup = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

/** Puts ArcRoom's hook on every event: replaces an earlier ArcRoom entry, keeps everyone else's hooks. */
export function withArcroomHooks(settings: Settings, command: string, anyTool = '*'): Settings {
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    const others = (hooks[event] ?? []).filter((g) => !g.hooks.some((h) => h.command.includes(MARK)));
    const ours: HookGroup = { hooks: [{ type: 'command', command }] };
    if (TOOL_EVENTS.has(event)) ours.matcher = anyTool;
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

export async function init(args: string[]): Promise<void> {
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const agent = (arg('--agent') ?? 'claude') as Agent;
  if (!AGENTS.includes(agent)) {
    console.error(`--agent takes one of: ${AGENTS.join(', ')}`);
    process.exit(1);
  }
  const configFile = join(ARCROOM_HOME, 'config.json');
  const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}; // re-running init reuses saved values
  const choice = initChoice({ argKey: arg('--key'), envKey: process.env.ARCROOM_API_KEY, argUrl: arg('--url'), saved });
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

  // 1. Remember the key for this machine.
  mkdirSync(ARCROOM_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify({ apiKey: key, url }, null, 2), { mode: 0o600 });
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
  const settings = withArcroomHooks(current, `${nodeCmd} "${entry}" hook${project ? ` --project ${project}` : ''}`);
  // never pre-approve a server from the shared .mcp.json by name: a pull request could change what that name runs
  const approved = ((current.enabledMcpjsonServers as string[]) ?? []).filter((n) => n !== 'arcroom');
  if (approved.length) settings.enabledMcpjsonServers = approved;
  else delete settings.enabledMcpjsonServers;
  // Live badge at the bottom of Claude Code ("ArcRoom · live · 2 reused"), unless the project has its own status line.
  const theirs = current.statusLine as { command?: string } | undefined;
  if (!theirs || theirs.command?.includes(MARK)) settings.statusLine = { type: 'command', command: `${nodeCmd} "${entry}" status`, padding: 0 };
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

  console.log(`ArcRoom is on for this project.
  key      ${join(ARCROOM_HOME, 'config.json')}
  hooks    ${file}
  tools    ${local ? 'Claude Code local scope (claude mcp list)' : `${mcpFile} (approve "arcroom" when Claude Code asks)`}
Start a new Claude Code session here to begin capturing runs.`);
}

/** `claude mcp add --scope local arcroom`: false when the claude command is not on PATH or the add failed. */
function addLocalMcp(entry: string): boolean {
  const claude = onPath(process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']);
  if (!claude) return false;
  const run = (args: string[]) =>
    claude.endsWith('.cmd') // an npm install on Windows: a batch file runs through cmd, every argument quoted
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map((a) => `"${a}"`).join(' ')}"`], {
          windowsVerbatimArguments: true,
          encoding: 'utf8',
        })
      : spawnSync(claude, args, { encoding: 'utf8' });
  run(['mcp', 'remove', '--scope', 'local', 'arcroom']); // none yet is fine
  return run(['mcp', 'add', '--scope', 'local', 'arcroom', '--', NODE, entry, 'mcp']).status === 0;
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
  console.log(`ArcRoom is on for ${agent} in this project.
  key      ${join(ARCROOM_HOME, 'config.json')}
${written.map((f) => `  wrote    ${f}`).join('\n')}
${next[agent]}`);
}
