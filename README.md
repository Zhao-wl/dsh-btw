# @local/dsh-btw — 旁问（`/btw`）

在 DSH Web 里复刻 Claude Code 桌面版的 side chat：`/btw <问题>` 会在右侧栏打开一个**原生会话**，
渲染、思考块、工具调用、输入框、用量底栏都由 host 的 Conversation 负责，和主会话同一套代码。

旁问默认跑在**轻量 agent preset（`minimal`）**上，只挂基础内置插件，不会继承主会话那套很重的组合
（例如实验性 agent-team 之类），所以启动和出字都更快。

## 行为

- 输入框 `/btw <问题>` 回车 → 右侧栏打开该旁问的原生会话并开始回答；该行不会发送给主对话。
- 裸 `/btw`（或 `/` 菜单里的「旁问」）→ 只把输入框预填成 `/btw `，接着描述问题即可。
- 旁问是 continuable 子会话：可以在侧栏里继续追问。
- 结果用 `delivery: 'caller'` 交付，**不会回灌主对话**。
- 父会话上下文以**最近若干条 user/assistant 文本**的形式注入首条提示（工具调用/结果不注入）。

## 原理

```
Client                                    Host
/btw <q>  ──拦截 /btw 行──┐
                           ├─ POST /api/dsh-btw/side-chat {sessionId, question}
                           │        └─ ctx.subagents.startActivation({
                           │             provider: 'spawn',            ← 全新轻量 agent
                           │             request: { prompt: [上下文+问题],
                           │                        parent,
                           │                        agentPreset: 'minimal' },
                           │             delivery: 'caller' })
                           │           → { childId }
                           └─ ctx.sidebarRight.openResource(
                                dsh-resource://subagentchat/session/<childId>
                                  ?parent=<sessionId>&mode=continuable )
```

- `spawn` provider（`@deepseek-ai/dsh-subagent-spawn-in-process`）创建零父上下文的新 agent，
  并按 `agentPreset` 挂载组合；`minimal` 由 `@deepseek-ai/dsh-web-app/presets/minimal.patch.yml` 声明。
- 右栏标签体由内置 `@deepseek-ai/dsh-client-ui-subagent` 的 `subagentchat` tab 提供。

## 配置

在 `cordis.patch.yml` 的行里改：

```yaml
- insert:
    - id: dsh-btw
      name: '@local/dsh-btw'
      config:
        provider: spawn        # spawn = 轻量；fork = 继承父会话完整日志（重，但上下文完全一致）
        agentPreset: minimal   # 走 minimal 组合；置空则用 provider 默认
        contextMessages: 0     # 0 = 首条提问只有问题本身（默认）；>0 才会复制最近 N 条消息
        contextChars: 2000     # contextMessages > 0 时的单条截断字符数
        label: 旁问             # subagent 目录里的标签
        maxLive: 6             # 同时常驻的旁问数量
```

首条提问默认**只包含你的问题**，不会把历史对话整段塞进去。想要少量上下文就把 `contextMessages`
调到 1–3；注意它是以文本形式出现在首条用户消息里的（spawn 子会话没有别的注入通道）。

想换回“完整上下文”模式：`provider: fork`、`agentPreset: ""` 且 `contextMessages: 0`。fork 会把父会话
已完成轮次作为子会话历史（更慢、更大，但上下文完全一致）。

## 已知边界

- `minimal` 组合只有基础工具；旁问不会拿到主会话里的全部工具/技能。
- 注入的上下文是**文本形式**的首条用户消息，所以在侧栏会话里能看到那段上下文文本。
- 旁问会出现在 subagent 目录/任务面板中；不进入主对话，也不进主会话列表。
- 需要在主会话已经有运行中的 agent（先在主会话发过消息）时才能发起旁问。
- 侧栏页签是会话级存储：在哪个会话打开就只属于那个会话，切回时仍在。
- 旧版自定义面板留下的「旁问」页签会在你回到对应会话时自动关闭。
