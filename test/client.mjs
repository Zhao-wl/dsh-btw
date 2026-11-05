// Client-half test: fake module loader + fake services, real client.js.
import assert from 'node:assert/strict';

const drafts = [];
const calls = [];
const requests = [];
let loaded;
let contribution;
let source;

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

globalThis.fetch = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ childId: 'child-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

await import('../client.js');
assert.equal(loaded.id, '@local/dsh-btw');

const moduleExports = loaded.factory((name) => {
  throw new Error(`client must not require "${name}"`);
});

assert.deepEqual(moduleExports.inject, [
  'locale',
  'sessions',
  'sidebarRight',
  'layout',
  'commandUi',
  'inputTriggers',
]);

const composer = {
  setDraft: (text) => drafts.push(text),
  focus: () => undefined,
  notify: (level, text) => calls.push(['notify', level, text]),
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
      assert.ok(dicts.zh?.['command.label']);
      assert.ok(dicts.en?.['command.label']);
      return () => undefined;
    },
    bind: () => (key) => key,
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
    openResource: (address) => calls.push(['openResource', address]),
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

// 1) The menu row arms the composer instead of opening an empty chat.
assert.equal(contribution.name, 'btw');
assert.equal(contribution.ui.kind, 'action');
contribution.ui.run({ sessionId: 'session-1' });
assert.equal(drafts.at(-1), '/btw ');
assert.equal(calls.length, 0);

// 2) The trigger source settles empty, so the `/` menu never shows it.
assert.equal(source.trigger, '/');
assert.deepEqual(await source.candidates({}, {}), []);
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '普通的一句话'), undefined);
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '/btw'), 'handled');
assert.equal(drafts.at(-1), '/btw ');
assert.equal(calls.length, 0);

// 3) `/btw <question>` starts a fork subagent and opens its native sidebar chat.
assert.equal(source.matchEnter({ sessionId: 'session-1' }, '/btw 刚才提到的文件名？'), 'handled');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'http://127.0.0.1:52072/api/dsh-btw/side-chat');
assert.deepEqual(requests[0].body, { sessionId: 'session-1', question: '刚才提到的文件名？' });
assert.equal(drafts.at(-1), '');
assert.deepEqual(calls[0], ['openRightbar', false, false]);
assert.deepEqual(calls[1], [
  'openResource',
  'dsh-resource://subagentchat/session/child-1?parent=session-1&mode=continuable',
]);

// 4) A failing host route surfaces one error notice instead of a broken tab.
globalThis.fetch = async () => new Response(JSON.stringify({ message: 'no agent' }), {
  status: 409,
  headers: { 'content-type': 'application/json' },
});
source.matchEnter({ sessionId: 'session-1' }, '/btw 再来一次');
await new Promise((resolve) => setTimeout(resolve, 20));
const notice = calls.find((call) => call[0] === 'notify');
assert.ok(notice, 'a failure must be reported to the user');
assert.equal(notice[1], 'error');

console.log('client half: all assertions passed');
