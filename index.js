/**
 * Host half of `/btw`.
 *
 * A side chat is a **lightweight subagent**: the built-in `spawn` provider
 * starts a fresh child with its own (usually the `minimal`) agent preset, so
 * the side chat does not carry the main session's whole plugin composition.
 * Only recent user/assistant text is handed over as read-only context. The
 * Client then opens the child in the right sidebar's native conversation tab,
 * which owns rendering, thinking blocks, tool rows and the composer.
 *
 * delivery:'caller' keeps every side-chat result out of the main conversation.
 *
 * This plugin contributes exactly one route:
 *   POST /api/dsh-btw/side-chat { sessionId, question } -> { childId }
 *
 * @module @local/dsh-btw
 */
import z from '@deepseek-ai/schemastery';

/** Package/route namespace. */
export const name = 'dsh-btw';

/** Services this plugin cannot run without. */
export const inject = ['connection', 'agents', 'sessions', 'subagents'];

/** Tunable values; change them in `cordis.patch.yml`. */
export const Config = z.object({
  provider: z.string().default('spawn').description("Subagent provider: 'spawn' (fresh, preset-driven) or 'fork' (seeded with the parent's log)."),
  agentPreset: z.string().default('minimal').description("Agent preset for the child; empty keeps the provider's default. 'minimal' mounts only the basic built-ins."),
  contextMessages: z.natural().default(16).description('Recent user/assistant messages handed to the side chat as text context.'),
  contextChars: z.natural().default(6000).description('Per-message character clamp for that text context.'),
  label: z.string().default('旁问').description('Label shown for the side-chat child in the subagent catalog.'),
  maxLive: z.natural().default(6).description('How many side-chat activations stay resident before the oldest is released.'),
});

/** A JSON response. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Text of one message's content blocks. */
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

/** Recent user/assistant text of the parent session, newest last. */
function recentContext(session, limit, chars) {
  if (session === undefined) return [];
  let messages;
  try {
    messages = session.deriveMessages();
  } catch {
    return [];
  }
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

/** One user text prompt: read-only context (when any) plus the question. */
function buildPrompt(contextLines, question) {
  if (contextLines.length === 0) return [{ type: 'text', text: question }];
  const context = [
    'Read-only context from the main conversation so far (tool calls are omitted):',
    '',
    contextLines.join('\n\n'),
    '',
    '---',
    '',
    'Side question: ' + question,
  ].join('\n');
  return [{ type: 'text', text: context }];
}

/** Start one side-chat child and answer with its session id. */
async function handle(ctx, config, live, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { message: 'request body must be JSON' });
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (sessionId === '') return json(400, { message: 'missing sessionId' });
  if (question === '') return json(400, { message: 'missing question' });

  const parent = ctx.agents.get(sessionId);
  if (parent === undefined) {
    return json(409, { message: '当前会话没有运行中的 agent：先在主会话里发一条消息再试' });
  }
  const provider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : 'spawn';
  if (ctx.subagents.getProvider(provider) === undefined) {
    return json(503, { message: `没有注册名为 "${provider}" 的 subagent provider` });
  }

  const controller = new AbortController();
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  if (request.signal.aborted) abortFromClient();
  else request.signal.addEventListener('abort', abortFromClient, { once: true });

  const session = ctx.sessions.get(sessionId);
  const prompt = buildPrompt(recentContext(session, config.contextMessages, config.contextChars), question);
  const agentPreset = typeof config.agentPreset === 'string' ? config.agentPreset.trim() : '';
  const spec = {
    provider,
    label: typeof config.label === 'string' && config.label !== '' ? config.label : '旁问',
    request: {
      prompt,
      parent,
      signal: controller.signal,
      ...(agentPreset === '' ? {} : { agentPreset }),
    },
    signal: controller.signal,
    delivery: 'caller',
  };

  try {
    let activation;
    try {
      activation = await ctx.subagents.startActivation(spec);
    } catch (error) {
      // A provider that owns its composition (fork) may refuse a preset.
      if (agentPreset === '' || !(error instanceof Error) || !/preset/i.test(error.message)) throw error;
      delete spec.request.agentPreset;
      activation = await ctx.subagents.startActivation(spec);
    }

    // Keep the newest activations resident so their sidebar chat stays warm;
    // release the oldest beyond the configured bound (it cold-resumes later).
    live.set(activation.childId, activation);
    while (live.size > config.maxLive) {
      const oldest = live.keys().next().value;
      if (oldest === undefined) break;
      const stale = live.get(oldest);
      live.delete(oldest);
      try {
        await stale.dispose();
      } catch {
        /* already gone */
      }
    }

    return json(200, { childId: activation.childId });
  } catch (error) {
    return json(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    request.signal.removeEventListener('abort', abortFromClient);
  }
}

/**
 * Register the side-chat route for the plugin's lifetime.
 * @param ctx - host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  /** childId → live activation, newest last. */
  const live = new Map();

  ctx.effect(
    () => () => {
      for (const activation of live.values()) {
        try {
          void activation.dispose();
        } catch {
          /* already gone */
        }
      }
      live.clear();
    },
    'dsh-btw: side-chat activations',
  );

  ctx.effect(
    () => {
      const dispose = ctx.connection.fetch.register({
        path: '/api/dsh-btw/side-chat',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handle(ctx, config, live, request),
      });
      return () => {
        void dispose();
      };
    },
    'dsh-btw: /api/dsh-btw/side-chat',
  );
}
