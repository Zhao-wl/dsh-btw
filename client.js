window.__ModuleLoader__.load({
  id: '@local/dsh-btw',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'btw';
    /** This plugin's tab type identity: the key its body and title register under. */
    const TYPE_ID = '@local/dsh-btw';
    /** The tab kind `sidebarRight.openTab` opens. Only one pane of it per session. */
    const KIND = 'btw';
    /** Exchanges retained for replay and rendering. */
    const THREAD_LIMIT = 20;

    const zh = {
      'tab.title': '旁问',
      'panel.placeholder': '问一个旁问…',
      'panel.send': '发送',
      'panel.stop': '停止',
      'panel.stopped': '已停止',
      'panel.thinking': '正在思考…',
      'panel.usage': '用法：/btw <问题>',
      'footer.turns': '{n} 轮',
      'footer.tps': '{n} tok/s',
      'footer.tokens': '{n} tok',
      'footer.cache': '缓存命中 {n}%',
      'footer.context': '{n}%',
    };
    const en = {
      'tab.title': 'Side question',
      'panel.placeholder': 'Ask a side question…',
      'panel.send': 'Send',
      'panel.stop': 'Stop',
      'panel.stopped': 'Stopped',
      'panel.thinking': 'Thinking…',
      'panel.usage': 'Usage: /btw <your question>',
      'footer.turns': '{n} turns',
      'footer.tps': '{n} tok/s',
      'footer.tokens': '{n} tok',
      'footer.cache': 'cache hit {n}%',
      'footer.context': '{n}%',
    };

    // ── plugin state ────────────────────────────────────────────────────────
    /** Client root context, captured in apply for actions invoked from views. */
    let host;
    /** Namespace-bound translate. */
    let t = (key) => key;

    /** Per-session, memory-only exchanges. A reload drops them by design. */
    const records = new Map();
    const listeners = new Set();
    /** sessionId → AbortController of the running ask. */
    const running = new Map();
    /** sessionId → next exchange id. */
    const counters = new Map();

    function blank() {
      return {
        thread: [],
        queue: [],
        question: '',
        busy: false,
        model: '',
        usage: null,
        totals: { input: 0, output: 0, cacheRead: 0 },
      };
    }

    function record(sessionId) {
      let current = records.get(sessionId);
      if (current === undefined) {
        current = blank();
        records.set(sessionId, current);
      }
      return current;
    }

    function patch(sessionId, next) {
      records.set(sessionId, { ...record(sessionId), ...next });
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useRecord(sessionId) {
      return React.useSyncExternalStore(
        subscribe,
        () => record(sessionId),
        () => record(sessionId),
      );
    }

    function patchEntry(sessionId, entryId, next) {
      const live = record(sessionId).thread;
      patch(sessionId, {
        thread: live.map((entry) => (entry.id === entryId ? { ...entry, ...next } : entry)),
      });
    }

    // ── host transport ─────────────────────────────────────────────────────
    function askUrl() {
      return new URL('api/dsh-btw/ask', document.baseURI).toString();
    }

    /** Put the composed question into the thread now; sending follows. */
    function submit(sessionId) {
      const current = record(sessionId);
      const question = current.question.trim();
      if (question === '') return;
      const id = (counters.get(sessionId) ?? 0) + 1;
      counters.set(sessionId, id);
      const entry = { id, question, answer: '', state: current.busy ? 'queued' : 'streaming', error: '' };
      const thread = [...current.thread, entry].slice(-THREAD_LIMIT);
      if (current.busy) {
        patch(sessionId, { question: '', thread, queue: [...current.queue, id] });
        return;
      }
      patch(sessionId, { question: '', thread });
      void runAsk(sessionId, id);
    }

    /** One model round trip for one already-visible thread entry. */
    async function runAsk(sessionId, entryId) {
      const entry = record(sessionId).thread.find((item) => item.id === entryId);
      if (entry === undefined) return;
      const replay = record(sessionId).thread
        .filter((item) => item.id !== entryId && item.state === 'done' && item.answer !== '')
        .slice(-THREAD_LIMIT)
        .map((item) => ({ question: item.question, answer: item.answer }));
      const controller = new AbortController();
      running.set(sessionId, controller);
      patchEntry(sessionId, entryId, { state: 'streaming' });
      patch(sessionId, { busy: true });
      const startedAt = performance.now();

      try {
        const response = await fetch(askUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, question: entry.question, history: replay }),
          signal: controller.signal,
          credentials: 'same-origin',
        });
        if (!response.ok || response.body === null) {
          let detail = '';
          try {
            detail = (await response.json())?.message ?? '';
          } catch {
            /* not JSON */
          }
          throw new Error(detail !== '' ? detail : `HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let answer = '';
        let failure = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === '') continue;
            let frame;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (frame.type === 'delta' && typeof frame.text === 'string') {
              answer += frame.text;
              patchEntry(sessionId, entryId, { answer });
            } else if (frame.type === 'meta' && typeof frame.model === 'string') {
              patch(sessionId, { model: frame.model });
            } else if (frame.type === 'usage' && frame.usage !== null && typeof frame.usage === 'object') {
              const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
              const out = Number(frame.usage.outputTokens) || 0;
              const totals = record(sessionId).totals;
              patch(sessionId, {
                usage: {
                  ...frame.usage,
                  contextWindow: typeof frame.contextWindow === 'number' ? frame.contextWindow : undefined,
                  tps: Math.round(out / elapsed),
                },
                totals: {
                  input: totals.input + (Number(frame.usage.inputTokens) || 0),
                  output: totals.output + out,
                  cacheRead: totals.cacheRead + (Number(frame.usage.cacheReadTokens) || 0),
                },
              });
            } else if (frame.type === 'error') {
              failure = typeof frame.message === 'string' ? frame.message : 'the model call did not complete';
            }
          }
        }
        if (failure !== null) throw new Error(failure);
        patchEntry(sessionId, entryId, { state: 'done' });
      } catch (error) {
        const aborted = controller.signal.aborted || error?.name === 'AbortError';
        patchEntry(
          sessionId,
          entryId,
          aborted ? { state: 'stopped' } : { state: 'error', error: String(error?.message ?? error) },
        );
      } finally {
        running.delete(sessionId);
        patch(sessionId, { busy: false });
        const next = record(sessionId).queue[0];
        if (next !== undefined) {
          patch(sessionId, { queue: record(sessionId).queue.slice(1) });
          void runAsk(sessionId, next);
        }
      }
    }

    // ── right sidebar plumbing ─────────────────────────────────────────────
    function composerFor(sessionId) {
      try {
        const sessions = host?.get?.('sessions');
        const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
        const conversation = scope?.get?.('conversation');
        const input = conversation?.input?.for?.(scope);
        return input;
      } catch {
        return undefined;
      }
    }

    function clearComposer(sessionId) {
      const input = composerFor(sessionId);
      try {
        input?.setDraft?.('');
        input?.focus?.();
      } catch {
        /* the session may have gone away */
      }
    }

    /** Make sure the right column is shown, then open (or reveal) our tab. */
    function revealTab(sessionId) {
      try {
        host?.get?.('layout')?.openRightbar?.(false, false);
      } catch {
        /* layout is optional */
      }
      const right = host?.get?.('sidebarRight');
      if (right === undefined) return;
      const open = () => {
        try {
          if (typeof right.openTabIn === 'function') right.openTabIn(sessionId, KIND);
          else if (typeof right.openTab === 'function') right.openTab(KIND);
        } catch (error) {
          console.error('[dsh-btw] could not open the sidebar tab', error);
        }
      };
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
        if (onScreen === sessionId || frames > 90) {
          open();
          return;
        }
        requestAnimationFrame(waitForAdoption);
      };
      requestAnimationFrame(waitForAdoption);
    }

    /** Open the panel for a session and hand it an optional inline question. */
    function openPanel(sessionId, question = '') {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const carried = question.trim();
      if (carried !== '') patch(sessionId, { question: carried });
      revealTab(sessionId);
      if (carried !== '') submit(sessionId);
    }

    /** Bare `/btw`: teach the usage instead of opening an empty panel. */
    function showUsage(sessionId) {
      clearComposer(sessionId);
      const input = composerFor(sessionId);
      if (typeof input?.notify === 'function') {
        try {
          input.notify('info', t('panel.usage'));
          return;
        } catch {
          /* fall through to the panel */
        }
      }
      openPanel(sessionId, '');
    }

    // ── markdown (small, dependency-free, host-matched) ────────────────────
    function inline(text, prefix) {
      const nodes = [];
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let index = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: `${prefix}-c${index++}`, className: 'dsh-btw-code' }, token.slice(1, -1)));
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key: `${prefix}-b${index++}` }, token.slice(2, -2)));
        } else if (token.startsWith('*')) {
          nodes.push(h('em', { key: `${prefix}-i${index++}` }, token.slice(1, -1)));
        } else {
          const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
          nodes.push(link === null
            ? token
            : h('span', { key: `${prefix}-l${index++}`, className: 'dsh-btw-link' }, link[1]));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function renderMarkdown(text, prefix) {
      const lines = String(text).split('\n');
      const blocks = [];
      let cursor = 0;
      let key = 0;
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line.trim() === '') {
          cursor += 1;
          continue;
        }
        if (line.startsWith('```')) {
          const language = line.slice(3).trim();
          const body = [];
          cursor += 1;
          while (cursor < lines.length && !lines[cursor].startsWith('```')) body.push(lines[cursor++]);
          cursor += 1;
          blocks.push(h('pre', {
            key: `${prefix}-pre${key++}`,
            className: 'dsh-btw-pre',
            'data-language': language === '' ? undefined : language,
          }, h('code', null, body.join('\n'))));
          continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading !== null) {
          blocks.push(h('div', {
            key: `${prefix}-h${key++}`,
            className: 'dsh-btw-h',
            'data-level': heading[1].length,
          }, inline(heading[2], `${prefix}-h${key}`)));
          cursor += 1;
          continue;
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const items = [];
          while (cursor < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[cursor])) {
            items.push(h('li', { key: `${prefix}-li${key++}` },
              inline(lines[cursor].replace(/^\s*([-*+]|\d+\.)\s+/, ''), `${prefix}-li${key}`)));
            cursor += 1;
          }
          blocks.push(h('ul', { key: `${prefix}-ul${key++}`, className: 'dsh-btw-ul' }, ...items));
          continue;
        }
        if (/^>\s?/.test(line)) {
          const quote = [];
          while (cursor < lines.length && /^>\s?/.test(lines[cursor])) quote.push(lines[cursor++].replace(/^>\s?/, ''));
          blocks.push(h('blockquote', { key: `${prefix}-q${key++}`, className: 'dsh-btw-quote' },
            inline(quote.join('\n'), `${prefix}-q${key}`)));
          continue;
        }
        const paragraph = [];
        while (
          cursor < lines.length
          && lines[cursor].trim() !== ''
          && !lines[cursor].startsWith('```')
          && !/^(#{1,4})\s+/.test(lines[cursor])
          && !/^\s*([-*+]|\d+\.)\s+/.test(lines[cursor])
          && !/^>\s?/.test(lines[cursor])
        ) {
          paragraph.push(lines[cursor++]);
        }
        blocks.push(h('p', { key: `${prefix}-p${key++}`, className: 'dsh-btw-p' },
          inline(paragraph.join('\n'), `${prefix}-p${key}`)));
      }
      return blocks;
    }

    // ── styles: host tokens, copied shapes (bubble / answer / composer) ────
    const CSS = `
.dsh-btw-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary)}
.dsh-btw-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px}
.dsh-btw-column{max-width:var(--dsh-chat-content-width,748px);width:100%;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.dsh-btw-userRow{display:flex;justify-content:flex-end}
.dsh-btw-bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}
.dsh-btw-answer{display:flex;flex-direction:column;gap:12px;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);min-width:0}
.dsh-btw-p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-btw-h{font-weight:600}
.dsh-btw-h[data-level="1"]{font-size:calc(var(--dsh-content-font-size,14px) + 4px)}
.dsh-btw-h[data-level="2"]{font-size:calc(var(--dsh-content-font-size,14px) + 2px)}
.dsh-btw-ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.dsh-btw-quote{margin:0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-btw-pre{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-border-l1);overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;line-height:1.55;white-space:pre-wrap}
.dsh-btw-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.92em;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));border-radius:4px;padding:1px 4px}
.dsh-btw-link{text-decoration:underline;text-underline-offset:2px}
.dsh-btw-pending{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.dsh-btw-error{color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;white-space:pre-wrap}
.dsh-btw-composer{flex:none;display:flex;flex-direction:column;gap:2px;margin:0 12px 6px;padding-top:8px;border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft)}
.dsh-btw-input{box-sizing:border-box;height:auto;min-height:36px;max-height:160px;overflow-y:auto;resize:none;padding:4px 14px 0 14px;border:none;outline:none;background:0 0;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.dsh-btw-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsh-btw-actions{display:flex;justify-content:flex-end;padding:2px 8px 6px}
.dsh-btw-primary{width:34px;height:34px;border:none;border-radius:999px;corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;display:grid;place-items:center;padding:0;transform:translateY(-2px);transition:background-color .1s}
.dsh-btw-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.dsh-btw-primary:disabled{opacity:.4;cursor:default}
.dsh-btw-status{flex:none;display:flex;align-items:center;gap:6px;padding:0 16px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsh-btw-status span+span:before{content:"·";margin-right:6px;color:var(--dsw-alias-label-caption)}
`;

    function SendIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      }, h('path', {
        d: 'M8 12.75V3.75M4.25 7.5L8 3.75L11.75 7.5',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function StopIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 2, fill: 'currentColor' }));
    }

    // ── views ──────────────────────────────────────────────────────────────
    function compact(value) {
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
      return String(value);
    }

    /** The host-style usage footer, fed by this panel's own exchanges. */
    function statusOf(current) {
      const parts = [t('footer.turns').replace('{n}', String(current.thread.length))];
      const usage = current.usage;
      if (usage !== null) {
        if (usage.tps > 0) parts.push(t('footer.tps').replace('{n}', String(usage.tps)));
        const tokens = current.totals.input + current.totals.output;
        if (tokens > 0) parts.push(t('footer.tokens').replace('{n}', compact(tokens)));
        if (current.totals.cacheRead > 0 && current.totals.input > 0) {
          const hit = Math.min(100, Math.round((current.totals.cacheRead / current.totals.input) * 100));
          parts.push(t('footer.cache').replace('{n}', String(hit)));
        }
        if (Number(usage.contextWindow) > 0 && Number(usage.inputTokens) > 0) {
          const percent = Math.min(100, Math.round((Number(usage.inputTokens) / Number(usage.contextWindow)) * 100));
          parts.push(t('footer.context').replace('{n}', String(percent)));
        }
      }
      return h('div', { className: 'dsh-btw-status' },
        ...parts.map((part, index) => h('span', { key: `s-${index}` }, part)));
    }

    function BtwBody(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const current = useRecord(sessionId);
      const scroll = React.useRef(null);
      const stick = React.useRef(true);
      const input = React.useRef(null);

      React.useEffect(() => {
        const element = scroll.current;
        if (element !== null && stick.current) element.scrollTop = element.scrollHeight;
      }, [current.thread, current.busy]);

      // Grow the composer with its text, up to the same ceiling the host uses.
      React.useEffect(() => {
        const element = input.current;
        if (element === null) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
      }, [current.question]);

      const stop = () => running.get(sessionId)?.abort();

      if (sessionId === '') return h('div', { className: 'dsh-btw-panel' });

      const rows = [];
      for (const entry of current.thread) {
        rows.push(h('div', { key: `u-${entry.id}`, className: 'dsh-btw-userRow' },
          h('div', { className: 'dsh-btw-bubble' }, entry.question)));
        if (entry.state === 'queued') continue;
        rows.push(h('div', { key: `a-${entry.id}`, className: 'dsh-btw-answer' },
          entry.answer !== '' ? renderMarkdown(entry.answer, `m-${entry.id}`) : null,
          entry.state === 'streaming' && entry.answer === ''
            ? h('div', { className: 'dsh-btw-pending' }, t('panel.thinking'))
            : null,
          entry.state === 'error' && entry.error !== ''
            ? h('div', { className: 'dsh-btw-error' }, entry.error)
            : null,
          entry.state === 'stopped'
            ? h('div', { className: 'dsh-btw-pending' }, t('panel.stopped'))
            : null,
        ));
      }

      return h('div', { className: 'dsh-btw-panel' },
        h('style', null, CSS),
        h('div', {
          className: 'dsh-btw-scroll',
          ref: scroll,
          onScroll: (event) => {
            const element = event.currentTarget;
            stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          },
        }, h('div', { className: 'dsh-btw-column' }, rows)),
        h('div', { className: 'dsh-btw-composer' },
          h('textarea', {
            className: 'dsh-btw-input',
            ref: input,
            rows: 1,
            value: current.question,
            placeholder: t('panel.placeholder'),
            onChange: (event) => patch(sessionId, { question: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                submit(sessionId);
              }
            },
          }),
          h('div', { className: 'dsh-btw-actions' },
            current.busy
              ? h('button', {
                type: 'button',
                className: 'dsh-btw-primary',
                title: t('panel.stop'),
                'aria-label': t('panel.stop'),
                onClick: stop,
              }, h(StopIcon))
              : h('button', {
                type: 'button',
                className: 'dsh-btw-primary',
                title: t('panel.send'),
                'aria-label': t('panel.send'),
                disabled: current.question.trim() === '',
                onClick: () => submit(sessionId),
              }, h(SendIcon)),
          ),
        ),
        statusOf(current),
      );
    }

    function BtwTitle(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const current = useRecord(sessionId);
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('span', null, t('tab.title')),
        current.busy ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '·') : null,
      );
    }

    return {
      inject: [
        'slots',
        'locale',
        'sessions',
        'sidebarRight',
        'sidebarRightTabs',
        'layout',
        'inputTriggers',
      ],
      apply(ctx) {
        host = ctx;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-btw: dictionaries');
        t = ctx.locale.bind(NS);

        // 1) One tab type, opened by kind; no resource address is involved.
        ctx.effect(
          () => ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: KIND,
            title: () => t('tab.title'),
            keepMounted: true,
          }),
          'dsh-btw: sidebar tab type',
        );

        // 2) The body and the tab title, keyed by the type id.
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TYPE_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, BtwBody));

        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TYPE_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, BtwTitle));

        // 3) `/btw …` never reaches the model: claim the line first. A bare
        //    `/btw` teaches the usage instead of opening an empty panel.
        ctx.effect(
          () => ctx.inputTriggers.registerSource({
            trigger: '/',
            name: 'btw',
            order: 10,
            candidates: () => [],
            matchEnter: (session, line) => {
              const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(String(line ?? '').trim());
              if (match === null) return undefined;
              const sessionId = session?.sessionId;
              if (typeof sessionId !== 'string' || sessionId === '') return undefined;
              const question = (match[1] ?? '').trim();
              if (question === '') {
                showUsage(sessionId);
                return 'handled';
              }
              openPanel(sessionId, question);
              clearComposer(sessionId);
              return 'handled';
            },
          }),
          'dsh-btw: /btw arbitration',
        );
      },
    };
  },
});
