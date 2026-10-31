import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARCROOM_HOME = mkdtempSync(join(tmpdir(), 'arcroom-uninstall-home-'));
const { uninstall } = await import('./init.js');

test('uninstall takes out only what init put in, for every agent, and --all deletes ~/.arcroom', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-uninstall-'));
  const ours = 'node "C:/Users/u/.arcroom/runtime/index.js" hook';
  const write = (rel: string, v: unknown) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof v === 'string' ? v : JSON.stringify(v));
  };
  write('.claude/settings.local.json', {
    permissions: { allow: ['Bash(npm test)'] },
    statusLine: { type: 'command', command: `${ours} status` },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: ours }] }, { hooks: [{ type: 'command', command: 'theirs.sh' }] }], SessionStart: [{ hooks: [{ type: 'command', command: ours }] }] },
  });
  write('.cursor/hooks.json', { version: 1, hooks: { stop: [{ command: `${ours} --agent cursor` }] } });
  write('.cursor/mcp.json', { mcpServers: { arcroom: { command: 'node', args: ['C:/Users/u/.arcroom/runtime/index.js', 'mcp'] }, other: { command: 'x' } } });
  write('.codex/config.toml', 'model = "o4"\n\n[mcp_servers.arcroom]\ncommand = "node"\nargs = ["C:/Users/u/.arcroom/runtime/index.js", "mcp"]\n');
  write('opencode.json', { $schema: 'https://opencode.ai/config.json', mcp: { arcroom: { type: 'local', command: ['node', 'C:/Users/u/.arcroom/runtime/index.js', 'mcp'] } } });
  write('.opencode/plugins/arcroom.js', '// ours');
  writeFileSync(join(process.env.ARCROOM_HOME!, 'config.json'), '{}');

  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-home');
  const changed = uninstall(dir, true, () => null, () => null);
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(settings, { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] } });
  assert.equal(existsSync(join(dir, '.cursor/hooks.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')), { mcpServers: { other: { command: 'x' } } });
  assert.equal(readFileSync(join(dir, '.codex/config.toml'), 'utf8'), 'model = "o4"\n');
  assert.equal(existsSync(join(dir, 'opencode.json')), false);
  assert.equal(existsSync(join(dir, '.opencode/plugins/arcroom.js')), false);
  assert.equal(existsSync(process.env.ARCROOM_HOME!), false);
  assert.equal(changed.length, 7);
  assert.deepEqual(uninstall(dir, false, () => null, () => null), []); // nothing left to take out
});
