// End-to-end test of the host half with a fake Cordis context and a fake model stream.
import assert from 'node:assert/strict';
import * as plugin from '../index.js';

const captured = [];
let route;

const session = {
  requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' } }),
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: '帮我看一下 config.ts' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我读一下这个文件。' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"config.ts"}' },
      ],
    },
    { role: 'tool', content: [{ type: 'text', text: 'TOOL RESULT SHOULD NOT APPEAR' }] },
    { role: 'assistant', content: [{ type: 'text', text: '这个文件导出了三个常量。' }] },
  ],
};

const ctx = {
  effect: (factory) => {
    const dispose = factory();
    assert.equal(typeof dispose, 'function', 'effect must return a disposer');
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
  sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }),
    stream: async function* (options) {
      captured.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '它叫 ' };
      yield { type: 'text-delta', index: 0, text: 'config.ts。' };
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  },
  get: () => undefined,
};

plugin.apply(ctx, {
  maxTokens: 512,
  transcriptMessages: 16,
  transcriptChars: 8000,
  historyTurns: 20,
  timeoutMs: 5000,
});

assert.equal(route.path, '/api/dsh-btw/ask');
assert.deepEqual(route.methods, ['POST']);
assert.equal(route.requestBody, 'buffered');

const request = new Request('http://127.0.0.1:52072/api/dsh-btw/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'session-1',
    question: '刚才那个配置文件叫什么？',
    history: [{ question: '我们在聊什么？', answer: '在聊配置文件。' }],
  }),
});

const response = await route.fetch(request);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);

const frames = (await response.text())
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

assert.equal(frames[0].type, 'meta');
assert.equal(frames[0].provider, 'test-provider');
assert.equal(frames[0].model, 'test-model');
assert.deepEqual(
  frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''),
  '它叫 config.ts。',
);
assert.equal(frames.at(-1).type, 'done');
assert.equal(frames.at(-1).finish, 'stop');
const usageFrame = frames.find((frame) => frame.type === 'usage');
assert.ok(usageFrame, 'the host reports token usage for the panel footer');
assert.deepEqual(usageFrame.usage, { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 });
assert.equal(usageFrame.contextWindow, 100000);

// The model call follows the main session's route, sends no tool schema, and
// keeps only user/assistant text in context.
const options = captured[0];
assert.equal(options.provider, 'test-provider');
assert.equal(options.model, 'test-model');
assert.equal(options.reasoningEffort, 'low');
assert.equal(options.maxTokens, 512);
assert.equal(options.tools, undefined, 'side questions must not declare tools');
assert.equal(options.sessionId, undefined, 'side questions must not attach to the session');
assert.deepEqual(options.messages, [
  { role: 'user', content: [{ type: 'text', text: '刚才那个配置文件叫什么？' }] },
]);
assert.match(options.system, /帮我看一下 config\.ts/);
assert.match(options.system, /这个文件导出了三个常量/);
assert.match(options.system, /EARLIER SIDE QUESTIONS/);
assert.match(options.system, /在聊配置文件/);
assert.doesNotMatch(options.system, /TOOL RESULT SHOULD NOT APPEAR/);
assert.doesNotMatch(options.system, /tool-call|read\("config/);
assert.match(options.system, /NO tools/);

// Error path: an unknown session is a JSON 404, not a stream.
const missing = await route.fetch(
  new Request('http://127.0.0.1:52072/api/dsh-btw/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', question: 'hi' }),
  }),
);
assert.equal(missing.status, 404);
assert.equal((await missing.json()).type, 'error');

// Error path: an empty question is rejected before any model work.
const empty = await route.fetch(
  new Request('http://127.0.0.1:52072/api/dsh-btw/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1', question: '   ' }),
  }),
);
assert.equal(empty.status, 400);

console.log('host half: all assertions passed');
