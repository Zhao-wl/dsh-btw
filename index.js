/**
 * Host half of `/btw` side questions.
 *
 * Serves one streaming route: `POST /api/dsh-btw/ask` with
 * `{ sessionId, question, history }` → NDJSON frames
 * `{type:'meta'}` / `{type:'delta'}` / `{type:'done'}` / `{type:'error'}`.
 *
 * The model call is a raw `llm.stream` (no agent, no turn, no tool schema), so
 * nothing here can enter the session log or the main conversation: the side
 * answer is reconstructed only from what the session already knows.
 *
 * @module @local/dsh-btw
 */
import z from '@deepseek-ai/schemastery';

/** Package/route namespace. */
export const name = 'dsh-btw';

/** Services this plugin cannot run without. */
export const inject = ['connection', 'sessions', 'llm'];

/** Tunable values; change them in `cordis.patch.yml`. */
export const Config = z.object({
  maxTokens: z.natural().default(1200).description('Token ceiling for one side answer.'),
  transcriptMessages: z.natural().default(16).description('How many recent user/assistant messages to replay as context.'),
  transcriptChars: z.natural().default(8000).description('Per-message character clamp in the replayed transcript.'),
  historyTurns: z.natural().default(20).description('How many earlier side questions to replay.'),
  timeoutMs: z.natural().default(180000).description('Hard timeout for one side question.'),
});

/** The side-question instruction. Kept in English for model reliability. */
const SYSTEM = [
  'You are answering ONE side question about an ongoing coding session.',
  '',
  'CONTEXT',
  '- The transcript below is read-only context from the main conversation.',
  '- The main agent is NOT interrupted: it keeps working independently.',
  '- You are a separate, lightweight instance that shares this context.',
  '',
  'CONSTRAINTS',
  '- You have NO tools: you cannot read files, run commands, or search anything.',
  '- Do NOT write tool calls or tool output as text; nothing you write is executed.',
  '- This is a one-off answer: there is no follow-up turn in this exchange.',
  '- Answer only from the context you were given. If it does not contain the answer,',
  '  say so plainly and suggest asking in the main conversation, where tools are available.',
  '- Never say "let me check", "I will now", or promise an action.',
  '',
  "Answer in the user's language, concisely.",
].join('\n');

/** Text of one message's content blocks, or '' when it has no text. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** Render the replayed transcript as plain text lines, newest last. */
function renderTranscript(messages, limit, chars) {
  const lines = [];
  for (const message of messages) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = messageText(message);
    if (text === '') continue;
    if (text.length > chars) text = `${text.slice(0, chars)} …[truncated]`;
    lines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.slice(-limit);
}

/** Render earlier side questions replayed from the client's in-memory history. */
function renderSideHistory(history, limit) {
  const rows = [];
  for (const item of history) {
    const question = typeof item?.question === 'string' ? item.question.trim() : '';
    const answer = typeof item?.answer === 'string' ? item.answer.trim() : '';
    if (question === '' || answer === '') continue;
    rows.push(`Q: ${question}\nA: ${answer}`);
  }
  return rows.slice(-limit);
}

/** Compose the system prompt from the session transcript and earlier side answers. */
function buildSystem(transcript, sideHistory) {
  const sections = [SYSTEM];
  sections.push('', '=== SESSION TRANSCRIPT (read-only) ===');
  sections.push(transcript.length === 0 ? '(empty session; nothing has been said yet)' : transcript.join('\n\n'));
  if (sideHistory.length > 0) {
    sections.push('', '=== EARLIER SIDE QUESTIONS IN THIS SESSION ===');
    sections.push(sideHistory.join('\n\n'));
  }
  return sections.join('\n');
}

/** A JSON error response for a request that never started streaming. */
function jsonError(status, message) {
  return new Response(JSON.stringify({ type: 'error', message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Ask one side question and return a streaming NDJSON response. */
async function handleAsk(ctx, config, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'request body must be JSON');
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (sessionId === '') return jsonError(400, 'missing sessionId');
  if (question === '') return jsonError(400, 'missing question');

  const session = ctx.sessions.get(sessionId);
  if (session === undefined) return jsonError(404, `unknown session "${sessionId}"`);

  const header = session.requestHeader();
  const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined;
  const provider = header?.config?.provider ?? selection?.provider;
  const model = header?.config?.model ?? selection?.model;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return jsonError(409, 'no model is resolved for this session yet');
  }
  const reasoningEffort = header?.config?.reasoningEffort ?? selection?.reasoningEffort;

  const transcript = renderTranscript(session.deriveMessages(), config.transcriptMessages, config.transcriptChars);
  const sideHistory = renderSideHistory(Array.isArray(body?.history) ? body.history : [], config.historyTurns);
  const system = buildSystem(transcript, sideHistory);
  const messages = [{ role: 'user', content: [{ type: 'text', text: question }] }];

  // Two independent cancellations: the browser going away, and a hard timeout.
  const controller = new AbortController();
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  if (request.signal.aborted) abortFromClient();
  else request.signal.addEventListener('abort', abortFromClient, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('side question timed out')), config.timeoutMs);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(sink) {
      const send = (frame) => {
        try {
          sink.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          /* the browser already closed the stream */
        }
      };
      send({ type: 'meta', provider, model });

      // The context window is metadata, not part of the answer: resolve it
      // alongside the stream so the footer can report a context share without
      // delaying the first token.
      let contextWindow;
      const modelInfo = Promise.resolve()
        .then(() => ctx.llm.resolveModelInfo(provider, model))
        .then((info) => {
          contextWindow = info?.context?.contextWindow;
        })
        .catch(() => undefined);

      let usage;
      let finished = false;
      try {
        const options = {
          provider,
          model,
          messages,
          system,
          maxTokens: config.maxTokens,
          signal: controller.signal,
        };
        if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') {
            send({ type: 'delta', text: chunk.text });
          } else if (chunk.type === 'usage') {
            usage = chunk.usage;
          } else if (chunk.type === 'finish') {
            finished = true;
            await Promise.race([modelInfo, new Promise((resolve) => setTimeout(resolve, 250))]);
            if (usage !== undefined) send({ type: 'usage', usage, contextWindow });
            const reason = chunk.reason;
            if (reason.kind === 'error' || reason.kind === 'aborted') {
              send({ type: 'error', message: reason.failure?.message ?? 'the model call did not complete' });
            } else {
              send({ type: 'done', finish: reason.kind });
            }
          }
        }
        if (!finished) {
          await Promise.race([modelInfo, new Promise((resolve) => setTimeout(resolve, 250))]);
          if (usage !== undefined) send({ type: 'usage', usage, contextWindow });
          send({ type: 'done', finish: 'stop' });
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abortFromClient);
        try {
          sink.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      clearTimeout(timer);
      controller.abort(new Error('client disconnected'));
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * Register the side-question route for the plugin's lifetime.
 * @param ctx - host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  ctx.effect(
    () => {
      const dispose = ctx.connection.fetch.register({
        path: '/api/dsh-btw/ask',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleAsk(ctx, config, request),
      });
      return () => {
        void dispose();
      };
    },
    'dsh-btw: /api/dsh-btw/ask',
  );
}
