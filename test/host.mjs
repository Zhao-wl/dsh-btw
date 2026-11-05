// Host-half test: fake Cordis context + fake subagent activation.
import assert from 'node:assert/strict';
import * as plugin from '../index.js';

let route;
const starts = [];
const live = [];
const parent = { id: 'session-1' };
const ctx = {
  effect: (factory) => {
    const dispose = factory();
    assert.equal(typeof dispose, 'function');
    return dispose;
  },
  connection: {
    fetch: {
      register: (registered) => {
        route = registered;
        return async () => undefined;
      },
    },
  },
  agents: {
    get: (id) => (id === 'session-1' ? parent : undefined),
  },
  subagents: {
    getProvider: (name) => (name === 'fork' ? {} : undefined),
    startActivation: async (spec) => {
      starts.push(spec);
      const activation = {
        childId: 'child-1',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => undefined,
      };
      live.push(activation);
      return activation;
    },
  },
};

plugin.apply(ctx, { provider: 'fork', label: '旁问', maxLive: 6 });

assert.equal(route.path, '/api/dsh-btw/side-chat');
assert.deepEqual(route.methods, ['POST']);
assert.equal(route.requestBody, 'buffered');

const ok = await route.fetch(new Request('http://127.0.0.1:52072/api/dsh-btw/side-chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-1', question: '刚才那个文件叫什么？' }),
}));
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), { childId: 'child-1' });

assert.equal(starts.length, 1);
assert.equal(starts[0].provider, 'fork');
assert.equal(starts[0].label, '旁问');
assert.equal(starts[0].delivery, 'caller');
assert.equal(starts[0].request.parent, parent);
assert.deepEqual(starts[0].request.prompt, [{ type: 'text', text: '刚才那个文件叫什么？' }]);

const noAgent = await route.fetch(new Request('http://127.0.0.1:52072/api/dsh-btw/side-chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'missing', question: 'hi' }),
}));
assert.equal(noAgent.status, 409);

const empty = await route.fetch(new Request('http://127.0.0.1:52072/api/dsh-btw/side-chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-1', question: '   ' }),
}));
assert.equal(empty.status, 400);

// The activation stays registered so the sidebar chat stays warm.
assert.equal(live.length, 1);

console.log('host half: all assertions passed');
