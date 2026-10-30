import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Hooks run with no console of their own, so on Windows any child started without windowsHide opens a window (30 Oct).
test('every program ArcRoom starts is started with its window hidden', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const missing: string[] = [];
  for (const f of readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const text = readFileSync(join(src, f), 'utf8');
    for (const m of text.matchAll(/\b(spawnSync|spawn|execFileSync|execSync|execFile)\(/g)) {
      const call = text.slice(m.index, text.indexOf(');', m.index) + 2);
      if (!call.includes('windowsHide')) missing.push(`${f}: ${call.split('\n')[0]}`);
    }
  }
  assert.deepEqual(missing, []);
});
