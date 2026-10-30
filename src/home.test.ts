import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { apiUrl, homeFrom, isOff } from './home.js';

test('the API key never goes over plain http to another machine', () => {
  assert.equal(apiUrl('https://api.arcroom.ai/'), 'https://api.arcroom.ai');
  assert.equal(apiUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(apiUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.throws(() => apiUrl('http://203.0.113.5:8787'), /must start with https/);
  assert.throws(() => apiUrl('http://localhost.evil.com'), /must start with https/);
  assert.throws(() => apiUrl('ftp://x'), /must start with https/);
});

test('a repo cannot move ArcRoom\'s folder into itself', () => {
  const home = join(homedir(), '.arcroom');
  const repo = resolve('/work/repo');
  assert.equal(homeFrom(undefined, repo), home);
  assert.equal(homeFrom('./.x', repo), home); // relative: ignored
  assert.equal(homeFrom(join(repo, '.x'), repo), home); // inside the repo: ignored
  assert.equal(homeFrom(resolve('/tmp/arcroom-test'), repo), resolve('/tmp/arcroom-test')); // elsewhere: honoured
});

test('a repo switched off covers its subfolders and nothing else', () => {
  const repo = resolve('/work/repo');
  assert.equal(isOff(join(repo, 'src'), [repo]), true);
  assert.equal(isOff(repo, [repo]), true);
  assert.equal(isOff(resolve('/work/repo-two'), [repo]), false);
  assert.equal(isOff(resolve('/work'), [repo]), false);
  assert.equal(isOff(undefined, [repo]), false);
});
