import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, withRoute } from './route.js';

test('a proven model wins; otherwise the kind of work decides', () => {
  assert.deepEqual(routeFor('write migration: users', 'claude-haiku-5-5'), { model: 'haiku', why: 'cheapest model that did these steps before' });
  assert.equal(routeFor('summarise changelog: vite 6')?.model, 'haiku');
  assert.equal(routeFor('patch code: our app')?.model, 'sonnet');
  assert.equal(routeFor('plan rollout: billing v2')?.model, 'opus');
  assert.equal(routeFor('frobnicate the widget'), undefined);
  assert.equal(routeFor('read notes', 'split')?.model, 'haiku', "a split procedure's 'split' model is not a model");
});

test('route is added only where work remains', () => {
  assert.equal(withRoute({ match: 'reuse', intent: 'list x: y' }, 'list x: y').route, undefined);
  assert.equal(withRoute({ match: 'none', intent: 'list x: y' }, 'list x: y').route?.model, 'haiku');
  assert.equal(withRoute({ match: 'replay', intent: 'write x', procedure: { model: 'claude-sonnet-5-5' } }, 'write x').route?.model, 'sonnet');
});
