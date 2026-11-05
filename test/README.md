# Host-half test

`host.mjs` drives the plugin's `apply()` with a fake Cordis context and a fake
model stream, then asserts:

- the route registers as `POST /api/dsh-btw/ask` with a buffered body;
- frames arrive as NDJSON: `meta` → `delta`* → `done`;
- the model call inherits the session's provider / model / reasoning effort;
- `tools` is absent (a side question can never call a tool);
- `sessionId` is not attached to the raw call (nothing lands in the session log);
- only user/assistant **text** is replayed: tool-call and tool-result blocks are dropped;
- earlier side questions from the client are replayed into the system prompt;
- an unknown session is a JSON 404 and an empty question a JSON 400.

Run it with the bundled Node:

```powershell
& "C:\Users\zhaowenlong\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "D:\Projects\Research\Temp\btw-plugin\test\host.mjs"
```

`import z from '@deepseek-ai/schemastery'` needs a resolvable module at test
time. This checkout uses a **test-only stub** at
`D:\Projects\Research\Temp\node_modules\@deepseek-ai\schemastery\` (every
schemastery expression is a chainable no-op). Keep that stub **outside** the
plugin directory: a `node_modules` inside the package would shadow the real
schemastery for the installed plugin.

The real Harness resolves the actual package from its installation; the stub
only exists so the pure plugin logic can run under plain Node.
