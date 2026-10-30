import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactText, rememberEnv, rememberSecrets, sensitiveFile } from './redact.js';

test('removes common secret formats from text', () => {
  const cases = [
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'ArcRoom ark_q1w2e3r4t5y6u7i8o9p0a1s2d3f4',
    'gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAABCDEFGHIJKLMNOP',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'export PASSWORD="hunter2hunter2"',
    'curl -H "Authorization: Bearer abcdefghijklmnop123"',
  ];
  for (const text of cases) assert.match(redactText(text), /\[REDACTED\]/, text);
  assert.ok(!redactText(cases[5]).includes('hunter2'));
});

test('removes passwords from connection URLs but keeps the rest', () => {
  const out = redactText('postgresql://postgres.abc:%24Secret%40@aws-0.pooler.supabase.com:5432/postgres');
  assert.equal(out, 'postgresql://postgres.abc:[REDACTED]@aws-0.pooler.supabase.com:5432/postgres');
});

test('leaves normal text alone', () => {
  const text = 'ran pnpm build in packages/plugin; 4 tests passed, max_tokens 16000';
  assert.equal(redactText(text), text);
});

test('redacts nested values and whole values under sensitive keys', () => {
  const out = redact({ tool: 'Bash', input: { command: 'ls', env: { API_KEY: 'plainvalue', count: 3 } }, tokens_in: 5 });
  assert.deepEqual(out, { tool: 'Bash', input: { command: 'ls', env: { API_KEY: '[REDACTED]', count: 3 } }, tokens_in: 5 });
});

test('round 3: the secret shapes that used to get through are redacted', () => {
  const leaked = [
    'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234',
    'SECRET_KEY=django-insecure-abcdef123456',
    'ENCRYPTION_KEY=0123456789abcdef',
    'DB_PASS=hunter2hunter2',
    'gitlab glpat-abcdefghijklmnopqrstu',
    'npm npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'hf hf_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws ASIAABCDEFGHIJKLMNOP',
    'google ya29.abcdefghijklmnopqrstuvwxyz',
    'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
    'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdefghijklmnop==;',
    'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abcdef0123456789',
    'mysql -u root -pSuperSecret1 db',
    'psql --password hunter2hunter2',
    'curl -u admin:hunter2hunter2 https://x',
    'Cookie: sid=abcdef123456; other=1',
    'Authorization: Basic YWRtaW46aHVudGVyMg==',
    '{\\"password\\": \\"hunter2hunter2\\"}',
  ];
  for (const text of leaked) assert.match(redactText(text), /\[REDACTED\]/, text);
  for (const secret of ['sk_live_abcd', 'hunter2', 'SuperSecret1', 'sid=abcdef']) for (const t of leaked) assert.ok(!redactText(t).includes(secret), t);
  // a private key cut before its END line is still removed
  assert.equal(redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA'), '[REDACTED]');
  // a list under a sensitive key is dropped whole
  assert.deepEqual(redact({ cookie: ['sid=abc', 'x=y'] }), { cookie: ['[REDACTED]', '[REDACTED]'] });
});

test("this machine's own secret values are removed whatever their shape; ids, paths and config stay", () => {
  rememberEnv({
    MY_SERVICE_TOKEN: 'odd.shape~value!77',
    PATH: 'C:/tools/bin123;D:/x/y/zz9',
    CLAUDE_CODE_SESSION_ID: '3f1c2b7a-1d2e-4f5a-8b6c-9d0e1f2a3b4c',
    SHORT_KEY: 'abc',
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_ASKPASS: 'C:/Program Files/Git/askpass.exe',
    CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile',
  });
  const dir = mkdtempSync(join(tmpdir(), 'arcroom-redact-'));
  try {
    writeFileSync(join(dir, '.env'), 'DB_PASSWORD="pa55-odd-shape"\nWEIRD=Zx81Qp0Lm2Nb7Vc4\nNODE_ENV=production\nAPP_URL=https://example.com/v2/api123\nexport FLAG=true\n');
    writeFileSync(join(dir, '.env.example'), 'EXAMPLE_SECRET=examplevalue123456\n');
    rememberSecrets(dir);
    const text = 'used odd.shape~value!77, pa55-odd-shape and Zx81Qp0Lm2Nb7Vc4 in session 3f1c2b7a-1d2e-4f5a-8b6c-9d0e1f2a3b4c';
    assert.equal(redactText(text), 'used [REDACTED], [REDACTED] and [REDACTED] in session 3f1c2b7a-1d2e-4f5a-8b6c-9d0e1f2a3b4c');
    for (const kept of ['production', 'https://example.com/v2/api123', 'examplevalue123456', 'C:/tools/bin123;D:/x/y/zz9', 'abc', 'Ada Lovelace', 'C:/Program Files/Git/askpass.exe', 'user:inference user:profile'])
      assert.equal(redactText(`x ${kept} y`), `x ${kept} y`, kept);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider key formats are removed; ordinary code is not', () => {
  const secrets = [
    'shpat_' + 'a1'.repeat(16),
    'SK' + 'a1'.repeat(16),
    'key-' + 'b2'.repeat(16),
    'dop_v1_' + 'c3'.repeat(32),
    'lin_api_' + 'Ab1'.repeat(13) + 'x',
    'pypi-AgEIcHlwaS5vcmc' + 'x'.repeat(60),
    'dp.pt.' + 'Ab1'.repeat(15),
    'PMAK-' + 'a'.repeat(24) + '-' + 'b'.repeat(34),
    'dapi' + 'd4'.repeat(16),
  ];
  for (const s of secrets) assert.ok(!redactText(`token ${s} end`).includes(s), s);
  const code = [
    'git checkout 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'const id = "3f1c2b7a-1d2e-4f5a-8b6c-9d0e1f2a3b4c";',
    'import { useEffect } from "react"; // keyboard shortcuts',
    'SELECT key, value FROM settings WHERE skip_count > 10',
    'pnpm -C packages/plugin test --reporter=spec',
  ];
  for (const c of code) assert.equal(redactText(c), c, c);
});

test('secret files are recognised; .env.example is not', () => {
  for (const p of ['/repo/.env', '.env.local', 'C:/u/.ssh/id_rsa', 'certs/server.key', 'cat .env', 'deploy/credentials.json', '~/.npmrc'])
    assert.ok(sensitiveFile(p), p);
  for (const p of ['.env.example', 'src/env.ts', 'keyboard.ts', 'README.md']) assert.ok(!sensitiveFile(p), p);
});
