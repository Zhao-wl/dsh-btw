/**
 * Host half of `/btw`.
 *
 * A side chat is a DSH **fork subagent**: the built-in `fork` provider seeds a
 * child session with the parent's completed-turn prefix (so it inherits this
 * conversation's context), while `delivery: 'caller'` keeps its result out of
 * the main conversation. The Client then opens that child session in the right
 * sidebar's native conversation tab, which owns rendering, thinking blocks,
 * tool-call rows, the composer and the usage footer.
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
export const inject = ['connection', 'agents', 'subagents'];

/** Tunable values; change them in `cordis.patch.yml`. */
export const Config = z.object({
  provider: z.string().default('fork').description('Subagent provider used for a side chat.'),
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
  const provider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : 'fork';
  if (ctx.subagents.getProvider(provider) === undefined) {
    return json(503, { message: `没有注册名为 "${provider}" 的 subagent provider` });
  }

  const controller = new AbortController();
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  if (request.signal.aborted) abortFromClient();
  else request.signal.addEventListener('abort', abortFromClient, { once: true });

  try {
    const activation = await ctx.subagents.startActivation({
      provider,
      label: typeof config.label === 'string' && config.label !== '' ? config.label : '旁问',
      request: {
        prompt: [{ type: 'text', text: question }],
        parent,
        signal: controller.signal,
      },
      signal: controller.signal,
      delivery: 'caller',
    });

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
