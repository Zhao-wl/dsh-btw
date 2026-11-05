// Host-half test: fake Cordis context + fake subagent activation.
import assert from 'node:assert/strict';
import * as plugin from '../index.js';

let route;
const starts = [];
const live = [];
const parent = { id: 'session-1' };
const session = {
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: '帮我看一下 config.ts' }] },
    { role: 'assistant', content: [
      { type: 'text', text: '这个文件导出了三个常量。' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
    ] },
    { role: 'tool', content: [{ type: 'text', text: 'TOOL RESULT SHOULD NOT APPEAR' }] },
  ],
};

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
  agents: { get: (id) => (id === 'session-1' ? parent : undefined) },
  sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
  subagents: {
    getProvider: (name) => (name === 'spawn' ? {} : undefined),
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

plugin.apply(ctx, {
  provider: 'spawn',
  agentPreset: 'minimal',
  contextMessages: 16,
  contextChars: 6000,
  label: '旁问',
  maxLive: 6,
});

assert.equal(route.path, '/api/dsh-btw/side-chat');
assert.deepEqual(route.methods, ['POST']);

const ok = await route.fetch(new Request('http://127.0.0.1:52072/api/dsh-btw/side-chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-1', question: '刚才那个文件叫什么？' }),
}));
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), { childId: 'child-1' });

assert.equal(starts.length, 1);
const spec = starts[0];
assert.equal(spec.provider, 'spawn');
assert.equal(spec.label, '旁问');
assert.equal(spec.delivery, 'caller');
assert.equal(spec.request.parent, parent);
assert.equal(spec.request.agentPreset, 'minimal', 'the child must run the light preset');

const prompt = spec.request.prompt[0].text;
assert.match(prompt, /最近|context|conversation/i);
assert.match(prompt, /帮我看一下 config\.ts/);
assert.match(prompt, /这个文件导出了三个常量/);
assert.doesNotMatch(prompt, /TOOL RESULT SHOULD NOT APPEAR/, 'tool results are not context');
assert.match(prompt, /刚才那个文件叫什么？/);

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

// A provider that refuses the preset is retried without it.
const forkCtx = {
  ...ctx,
  subagents: {
    getProvider: (name) => (name === 'fork' ? {} : undefined),
    startActivation: async (spec) => {
      starts.push(spec);
      if (spec.request.agentPreset !== undefined) throw new Error('agentPreset is not supported by this provider');
      return { childId: 'child-2', result: Promise.resolve({}), dispose: async () => undefined };
    },
  },
};
plugin.apply(forkCtx, {
  provider: 'fork',
  agentPreset: 'minimal',
  contextMessages: 16,
  contextChars: 6000,
  label: '旁问',
  maxLive: 6,
});
const retried = await route.fetch(new Request('http://127.0.0.1:52072/api/dsh-btw/side-chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-1', question: '再来一次' }),
}));
assert.equal(retried.status, 200);
assert.deepEqual(await retried.json(), { childId: 'child-2' });
assert.equal(starts.at(-1).request.agentPreset, undefined);

console.log('host half: all assertions passed');
