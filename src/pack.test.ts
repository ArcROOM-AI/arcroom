import assert from 'node:assert/strict';
import test from 'node:test';
import { pack, type Piece, route } from './pack.js';

const piece = (kind: Piece['kind'], value: number, chars: number): Piece => ({ kind, value, text: kind[0].repeat(chars) });

test('route: a "why" wants decisions, "who is editing" the code map, a change the steps', () => {
  assert.equal(route('why did we pick Postgres?').knowledge, 1.4);
  assert.equal(route('who is editing the api folder').code, 1.4);
  assert.equal(route('fix the bug in todo.js').recall, 1.2);
  assert.deepEqual(route('hello there'), {});
});

test('pack: best first, within one budget; the last that does not fit is clipped, a tiny rest is dropped', () => {
  const got = pack([piece('code', 0.5, 900), piece('recall', 0.9, 1200), piece('knowledge', 0.7, 900)], 'tell me', {}, 2400);
  assert.deepEqual(got.map((p) => p.kind), ['recall', 'knowledge', 'code']);
  assert.equal(got.reduce((n, p) => n + p.text.length, 0), 2400);
  assert.ok(got[2].text.endsWith('…'));
  assert.deepEqual(pack([piece('recall', 0.9, 2300), piece('code', 0.5, 900)], 'x', {}, 2400).map((p) => p.kind), ['recall']);
});

test('pack: learned weights and the route reorder pieces', () => {
  const pieces = [piece('recall', 0.7, 100), piece('knowledge', 0.6, 100)];
  assert.equal(pack(pieces, 'tell me')[0].kind, 'recall');
  assert.equal(pack(pieces, 'tell me', { recall: 0.6 })[0].kind, 'knowledge'); // steps here rarely helped
  assert.equal(pack(pieces, 'why do we do this')[0].kind, 'knowledge');
});
