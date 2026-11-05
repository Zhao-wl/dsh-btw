window.__ModuleLoader__.load({
  id: '@local/dsh-btw',
  factory(require) {
    /** Locale namespace owned by this plugin. */
    const NS = 'btw';

    const zh = {
      'command.label': '旁问',
      'command.description': '基于当前会话开一个旁问，回答不进主对话',
      'error.title': '旁问打开失败',
      'error.model': '当前会话还没有可用的 agent：先在主会话里发一条消息再试',
    };
    const en = {
      'command.label': 'Side question',
      'command.description': 'Open a side chat seeded from this conversation; its answers never enter the main one',
      'error.title': 'Could not open the side chat',
      'error.model': 'This session has no live agent yet: send a message in the main chat first',
    };

    /** Client root context, captured in apply. */
    let host;
    /** Namespace-bound translate. */
    let t = (key) => key;

    /** Absolute URL of the host route, resolved against the app's base. */
    function routeUrl() {
      return new URL('api/dsh-btw/side-chat', document.baseURI).toString();
    }

    /** Resolve the session's composer facade, or undefined on hosts without one. */
    function composerFor(sessionId) {
      try {
        const sessions = host?.get?.('sessions');
        const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
        const conversation = scope?.get?.('conversation');
        return conversation?.input?.for?.(scope);
      } catch {
        return undefined;
      }
    }

    /** Leave `/btw ` in the composer so the next words describe the question. */
    function armComposer(sessionId) {
      const input = composerFor(sessionId);
      try {
        input?.setDraft?.('/btw ');
        input?.focus?.();
      } catch {
        /* the session may have gone away */
      }
    }

    /** Consume the `/btw …` line once the side chat is on its way. */
    function clearComposer(sessionId) {
      const input = composerFor(sessionId);
      try {
        input?.setDraft?.('');
        input?.focus?.();
      } catch {
        /* the session may have gone away */
      }
    }

    function notify(sessionId, message) {
      const input = composerFor(sessionId);
      try {
        input?.notify?.('error', message);
      } catch {
        /* the session may have gone away */
      }
      console.error(`[dsh-btw] ${message}`);
    }

    /** The resource address of the built-in sidebar conversation tab. */
    function chatAddress(parentSessionId, childSessionId) {
      const query = new URLSearchParams({ parent: parentSessionId, mode: 'continuable' });
      return `dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?${query}`;
    }

    /** Reveal the right column, then open the child's native conversation tab. */
    function openChatTab(parentSessionId, childSessionId) {
      try {
        host?.get?.('layout')?.openRightbar?.(false, false);
      } catch {
        /* layout is optional */
      }
      const right = host?.get?.('sidebarRight');
      if (right === undefined) {
        notify(parentSessionId, 'right sidebar service is unavailable');
        return;
      }
      const address = chatAddress(parentSessionId, childSessionId);
      const mounted = right.mounted;
      let frames = 0;
      const waitForAdoption = () => {
        frames += 1;
        let onScreen;
        try {
          onScreen = mounted?.getSnapshot?.();
        } catch {
          onScreen = undefined;
        }
        if (onScreen === parentSessionId || frames > 90) {
          try {
            right.openResource(address);
          } catch (error) {
            notify(parentSessionId, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        requestAnimationFrame(waitForAdoption);
      };
      requestAnimationFrame(waitForAdoption);
    }

    /** Start one fork-subagent side chat and show it in the right sidebar. */
    async function startSideChat(sessionId, question) {
      clearComposer(sessionId);
      try {
        const response = await fetch(routeUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, question }),
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload.childId !== 'string') {
          throw new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`);
        }
        openChatTab(sessionId, payload.childId);
      } catch (error) {
        notify(sessionId, t('error.title') + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    return {
      inject: ['locale', 'sessions', 'sidebarRight', 'layout', 'commandUi', 'inputTriggers'],
      apply(ctx) {
        host = ctx;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-btw: dictionaries');
        t = ctx.locale.bind(NS);

        // 1) The `/` menu row arms the composer; it never opens an empty chat.
        ctx.effect(
          () => ctx.commandUi.register({
            name: 'btw',
            label: () => t('command.label'),
            description: () => t('command.description'),
            available: () => true,
            ui: {
              kind: 'action',
              run: (session) => armComposer(session?.sessionId),
            },
          }),
          'dsh-btw: /btw menu row',
        );

        // 2) `/btw <question>` never reaches the model: claim the line first.
        //    The empty async `candidates` keeps this source out of the `/` menu;
        //    it must return a Promise because the menu awaits it.
        ctx.effect(
          () => ctx.inputTriggers.registerSource({
            trigger: '/',
            name: 'btw',
            order: 10,
            candidates: async () => [],
            matchEnter: (session, line) => {
              const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(String(line ?? '').trim());
              if (match === null) return undefined;
              const sessionId = session?.sessionId;
              if (typeof sessionId !== 'string' || sessionId === '') return undefined;
              const question = (match[1] ?? '').trim();
              if (question === '') {
                armComposer(sessionId);
                return 'handled';
              }
              void startSideChat(sessionId, question);
              return 'handled';
            },
          }),
          'dsh-btw: /btw arbitration',
        );
      },
    };
  },
});
