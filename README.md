# @local/dsh-btw — 旁问（`/btw`）

在 DSH Web 里复刻 Claude Code 桌面版的 side chat：`/btw <问题>` 会 **fork 当前会话** 为子会话，并在
右侧栏用 **DSH 原生会话界面** 打开它。因为渲染完全由 host 的 Conversation 负责，思考块、工具调用行、
Markdown、切换模型、输入框、用量/上下文底栏都与主会话一致。

## 行为

- 输入框 `/btw <问题>` 回车 → 右侧栏打开该旁问的原生会话并开始回答；该行不会发送给主对话。
- 裸 `/btw`（或 `/` 菜单里的「旁问」）→ 只把输入框预填成 `/btw `，接着描述问题即可。
- 子会话是 **continuable fork subagent**：继承父会话已完成轮次作为上下文，可以在侧栏里继续追问。
- 结果用 `delivery: 'caller'` 交付，**不会回灌主对话**；主对话历史与上下文不变。
- 历史是真实子会话（落盘、可在 subagent 目录看到），不是内存里的临时面板。

## 原理

```
Client                                    Host
/btw <q>  ──拦截 /btw 行──┐
                           ├─ POST /api/dsh-btw/side-chat {sessionId, question}
                           │        └─ ctx.subagents.startActivation({
                           │             provider: 'fork', delivery: 'caller',
                           │             request: { prompt: [text(q)], parent } })
                           │           → { childId }
                           └─ ctx.sidebarRight.openResource(
                                dsh-resource://subagentchat/session/<childId>
                                  ?parent=<sessionId>&mode=continuable )
```

- 子会话由内置 `@deepseek-ai/dsh-subagent-fork-in-process`（provider 名 `fork`）创建，
  seed 为父会话最后一个 `turn/end` 之前的事件。
- 右栏标签体由内置 `@deepseek-ai/dsh-client-ui-subagent` 的 `subagentchat` tab 提供，
  它用共享的 `conversation.content` 渲染真实会话，因此外观/交互天然与主会话一致。

## 配置

在 `cordis.patch.yml` 的行里改：

```yaml
- insert:
    - id: dsh-btw
      name: '@local/dsh-btw'
      config:
        provider: fork   # subagent provider 名
        label: 旁问       # subagent 目录里的标签
        maxLive: 6       # 同时常驻的旁问数量，超出后释放最旧的（可冷恢复）
```

## 已知边界

- fork 会把父会话**已完成轮次**作为子会话历史带过去，所以侧栏会话里能看到父会话的历史消息
  （DSH 原生 side chat 没有 "只显示 fork 之后" 的过滤）。
- 旁问会出现在 subagent 目录/任务面板中；不进入主对话。
- 需要在主会话已经有运行中的 agent（先在主会话发过消息）时才能发起旁问。
- 侧栏页签本身是会话级存储：在哪个会话打开就只属于那个会话，切回时仍在。
- 旧版自定义面板留下的「旁问」页签会在你回到对应会话时自动关闭；若宿主不提供关闭能力，
  它会显示一行「这是旧版旁问页签」的提示而不是空白占位。
