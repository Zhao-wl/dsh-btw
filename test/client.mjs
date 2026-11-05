// Client-half test: load the real client.js under a fake module loader and
// assert the registrations and the `/btw …` arbitration it performs.
import assert from 'node:assert/strict';

const calls = [];
const drafts = [];
const requests = [];
let loaded;
let source;
let contribution;
const slotRegistrations = [];
let tabDefinition;

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};
globalThis.document = { baseURI: 'http://127.0.0.1:52072/' };
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 0;
};

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: () => ({}),
  useRef: () => ({ current: null }),
  useEffect: () => undefined,
};

globalThis.fetch = async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) });
  const ndjson = [
    JSON.stringify({ type: 'meta', provider: 'p', model: 'm' }),
    JSON.stringify({ type: 'delta', text: '文件名是 ' }),
    JSON.stringify({ type: 'delta', text: 'config.ts。' }),
    JSON.stringify({ type: 'usage', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 }, contextWindow: 100000 }),
    JSON.stringify({ type: 'done', finish: 'stop' }),
    '',
  ].join('\n');
  return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
};

await import('../client.js');
assert.ok(loaded, 'client.js must register a module');
assert.equal(loaded.id, '@local/dsh-btw');

const moduleExports = loaded.factory((name) => {
  assert.equal(name, 'react', 'only the browser React module may be required');
  return React;
});

assert.deepEqual(moduleExports.inject, [
  'slots',
  'locale',
  'sessions',
  'sidebarRight',
  'sidebarRightTabs',
  'layout',
  'commandUi',
  'inputTriggers',
]);

const composer = {
  setDraft: (text) => drafts.push(text),
  focus: () => undefined,
};

const ctx = {
  effect: (factory) => {
    const dispose = factory();
    assert.equal(typeof dispose, 'function');
    return dispose;
  },
  locale: {
    register: (ns, dicts) => {
      assert.equal(ns, 'btw');
      assert.ok(dicts.zh?.['tab.title']);
      assert.ok(dicts.en?.['tab.title']);
      return () => undefined;
    },
    bind: () => (key) => key,
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabDefinition = definition;
      return () => undefined;
    },
  },
  slots: {
    inject: (owner, callback) => {
      callback();
      return () => undefined;
    },
    register: (options, Component) => {
      slotRegistrations.push({ options, Component });
      return () => undefined;
    },
  },
  commandUi: {
    register: (registered) => {
      contribution = registered;
      return () => undefined;
    },
  },
  inputTriggers: {
    registerSource: (registered) => {
      source = registered;
      return () => undefined;
    },
  },
  sidebarRight: {
    mounted: { getSnapshot: () => 'session-1' },
    openTabIn: (sessionId, kind) => calls.push(['openTabIn', sessionId, kind]),
    openTab: (kind) => calls.push(['openTab', kind]),
  },
  layout: {
    openRightbar: (track, fullscreen) => calls.push(['openRightbar', track, fullscreen]),
  },
  sessions: {
    scope: () => ({
      get: (name) => (name === 'conversation' ? { input: { for: () => composer } } : undefined),
    }),
  },
  get(name) {
    if (name === 'layout') return this.layout;
    if (name === 'sidebarRight') return this.sidebarRight;
    if (name === 'sessions') return this.sessions;
    return undefined;
  },
};

moduleExports.apply(ctx);

// 1) One tab type, opened by kind.
assert.equal(tabDefinition.id, '@local/dsh-btw');
assert.equal(tabDefinition.kind, 'btw');
assert.equal(tabDefinition.keepMounted, true);
assert.equal(tabDefinition.title(), 'tab.title');

// 2) A body and a title, both keyed by the type id and session-scoped.
assert.deepEqual(slotRegistrations.map((entry) => [entry.options.name, entry.options.key]), [
  ['sidebar.right.pane.tab', '@local/dsh-btw'],
  ['sidebar.right.pane.tab.title', '@local/dsh-btw'],
]);
for (const { options } of slotRegistrations) {
  assert.equal(options.inject('session-1').sessionId, 'session-1');
}

// 3) The `/` menu row arms the composer instead of opening anything.
assert.equal(contribution.name, 'btw');
assert.equal(contribution.ui.kind, 'action');
assert.equal(contribution.available({ sessionId: 'session-1' }), true);
contribution.ui.run({ sessionId: 'session-1' });
assert.equal(drafts.at(-1), '/btw ');
assert.equal(calls.length, 0, 'the menu row must not open the sidebar or a tab');

// 4) The trigger source settles empty (never a broken menu group) and falls
//    back to the same composer arming for a bare line.
assert.equal(source.trigger, '/');
assert.equal(source.name, 'btw');
assert.deepEqual(await source.candidates({}, {}), []);
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '普通的一句话'), undefined);
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '/other 命令'), undefined);
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '/btw'), 'handled');
assert.equal(drafts.at(-1), '/btw ');
assert.equal(calls.length, 0, 'a bare /btw must not open the sidebar or a tab');

// 5) `/btw <question>` is claimed rather than sent, and asks immediately.
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '/btw 刚才提到的文件名？'), 'handled');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(calls[0], ['openRightbar', false, false]);
assert.deepEqual(calls[1], ['openTabIn', 'session-1', 'btw']);
assert.equal(drafts.at(-1), '', 'the consumed /btw line leaves the composer');
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'http://127.0.0.1:52072/api/dsh-btw/ask');
assert.deepEqual(requests[0].body, {
  sessionId: 'session-1',
  question: '刚才提到的文件名？',
  history: [],
});

// 6) A later question replays the earlier exchange into its request history.
source.matchEnter({ sessionId: 'session-1' }, '/btw 第二个问题');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(requests.length, 2);
assert.deepEqual(requests[1].body, {
  sessionId: 'session-1',
  question: '第二个问题',
  history: [{ question: '刚才提到的文件名？', answer: '文件名是 config.ts。' }],
});

console.log('client half: all assertions passed');
