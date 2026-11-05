# @local/dsh-btw — 旁问（`/btw`）

把 Claude Code 的 `/btw` 语义搬进 DSH Web：**基于当前会话上下文问一个一次性问题，回答不进主对话、不打断主回合、不能调用工具**。

## 形态

- 右侧常驻分栏（`sidebarRight` 的 tab 类型 `btw`，每个会话一个「旁问」页签）。
- 触发：
  - 输入框输入 `/btw <问题>` 回车 → 打开右栏并直接提问（该行不会发送给模型）；
  - 裸 `/btw` 或 `/` 菜单里的「旁问」→ 只把输入框预填成 `/btw `，接着描述问题即可，不会打开面板、不弹提示。
- 模型：跟随主会话当前请求的 provider / model / reasoning effort。
- 历史：仅内存，保留最近 20 轮用于回放，刷新页面即清空。
- 排版：与主会话一致（用户气泡、Markdown 回答、composer 卡片、圆形发送/停止按钮），
  底部状态栏显示这次旁问自己的用量：轮数、tok/s、tokens、缓存命中、上下文占用。
- 发送即上屏：消息立即清空输入框并出现在对话里；回答过程中再问会排队，前一轮结束后自动发出。

## 实现要点

- 客户端：`sidebarRightTabs.register` 注册 tab 类型 + `sidebar.right.pane.tab` / `.title` keyed slot 渲染；
  `inputTriggers.registerSource` 用 `matchEnter` 认领 `/btw …` 整行并返回 `'handled'`。
- 服务端：`ctx.connection.fetch.register` 暴露 `POST /api/dsh-btw/ask`，用 `ctx.llm.stream` 发起独立模型请求
  （不建 agent、不写 session log、不传 tools），以 NDJSON 流式返回；流结束时补一帧 `usage`
  给底栏使用（token 数 + 上下文窗口）。
- 上下文：`session.deriveMessages()` 中最近 16 条 user/assistant 文本 + 客户端回放的更早旁问，拼成 system prompt；
  工具调用/工具结果块全部剔除，避免 provider 因缺失工具声明而报错。

## 配置

在 `cordis.patch.yml` 的行里改：

```yaml
- insert:
    - id: dsh-btw
      name: '@local/dsh-btw'
      config:
        maxTokens: 1200
        transcriptMessages: 16
        transcriptChars: 8000
        historyTurns: 20
        timeoutMs: 180000
```

## 已知边界

- 旁问是全新请求前缀，不复用主会话 prompt cache，成本高于 Claude Code 的同功能（那边能命中缓存前缀）。
- 无法阻止或打断主回合（也不需要）。
- 客户端读不到主回合正在流式生成的那部分内容；上下文只到已提交的会话消息。
