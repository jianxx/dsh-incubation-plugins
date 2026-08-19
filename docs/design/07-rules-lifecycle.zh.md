# 07 rules-lifecycle — 行为规则工件的捕获、生效与收敛

> 状态: design (not started) | Tier: 2 | 包: packages/memory/rules-lifecycle | 依赖: 无
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:把用户的纠偏沉淀为版本化的行为规则工件(行为规则/代码标准/自检清单/反模式/工作流五段),带候选→生效→归档状态机、复发追踪与定期收敛合并,注入有字节预算上限。
**用户问题**:用户每周都在对 agent 重复同一批纠正("别动 vendor/""commit 前先跑 lint");纠正从不沉淀,或沉淀进 CLAUDE.md 后只增不减——几个月后 prompt 被无限积累的规则噪声淹没,真正重要的规则反而被模型忽略,而被纠正过的错误照样复发。

## 动机

- **SSCA**(Self-Improving Coding Agents Through Accumulated Rules)给出已验证的生产闭环:
  被接受的 review comment → 版本化行为规则,写入共享指令文件;规则分五段 ——
  behavioral rules / code standards / self-review checklist / anti-patterns / workflow rules;
  在 35+ 服务平台上数月内从 5 条增长到 18 条;9 类被规则约束过的错误在 74 次 exposure 中
  **零复发**。但论文同时给出明确限制:单调增长会造成 context-window 压力 ——
  **维护/收敛不是可选项**。本工作项把"收敛"做成一等阶段(consolidation + archive),
  而不是事后补丁。
- **SkillOpt**:有界编辑即学习率 —— 每次 consolidation 设 max edit count;
  编辑接受前过 held-out validation gate;被拒绝的编辑进入 negative-feedback memory
  (此处:rejected candidate 保留于 archived 并参与 consolidation prompt,避免重复提议)。
- **AMV-L**:memory 生命周期必须约束 per-request 计算/footprint —— 此处落实为
  **注入 prompt 的字节预算**(默认 2KB),超预算即降级,而不是无限堆叠。
- **MemCon**(仅作 future work 引用):后期可让 RETRIEVE/CONSOLIDATE/FORGET 的控制
  本身被学习;本设计固定为规则化控制,不做学习。
- dsh 现状:有 system-prompt 装配缝、会话事件流、廉价辅助 LLM 调用范式,
  但**没有**版本化、经审、带复发统计的规则工件。本工作项补这一块。

## 现状与缺口

dsh 已具备全部所需接缝(下节逐条引用),缺口 purely 在工件与流程:
无 rules store、无 candidate→active→archived 状态机、无 recurrence 追踪、
无预算化注入器、无 consolidation 审阅闭环。

### 与 dsh-cc-plugins memory 的边界

dsh-cc-plugins(不同仓库,**编译期零依赖、运行时可选集成**,共享原则 1)已提供
通用 CLAUDE.md 式记忆 + dream consolidation:积累的是**事实与偏好**,自然增长、
不经逐条审阅、无复发度量。rules-lifecycle **不是**通用记忆:它是版本化、
逐条经人工审阅(candidate 永不静默生效)、预算约束、带 provenance 与
exposure/recurrence 统计的**规则**工件。两者可共存:memory 回答"这个项目是什么",
rules 回答"这个团队犯过什么错、以后不许再犯"。本插件不读也不写 cc-plugins 的
memory 文件;若未来做集成,只允许在 consolidation prompt 中只读引用,不构成依赖。

相邻记忆项:consolidation 流中的 候选→激活→归档 生命周期机是 27 memory-maintenance
的具名提取候选(那里作用于事实而非规则);26 memory-write-gate 与本插件的
consolidation 互补——它管事实的准入质量,永不门控经人工审阅的规则。

## 设计

### 表面与接缝(verified + cited)

以下均在 deepseek-harness 仓已验证;未验证项只进"风险与开放问题"。

1. **系统提示注入**:`ctx.systemPrompt.section({name, order, text})`,返回 Cordis
   disposer;`text` 可为同步函数,**每次装配同步求值**(assemble 内直接调用、无 await)。
   order 约定:`-100` harness identity、`0` persona、tool guidance 用 100–199。
   出处:`packages/core/system-prompt/src/index.ts`(`PromptSection`、`SystemPrompt.section()`、
   约第 57–60 行 order 约定、第 61/381 行注册 API、`system-prompt/change` 通知)。
   → 本插件注册 `name: 'rules-lifecycle:active'`,`order: 200`(tool guidance 之后)。
2. **会话事件流**:`ctx.on('session/event', (session, event) => …)`,post-commit
   发布、emit 模式、observer 失败被隔离。出处:`packages/core/session/src/index.ts:76`。
   用户消息为 `'user/message': UserMessage`(`packages/core/session/src/types.ts:264`),
   其 `source` 区分生产者(`packages/llm/llm/src/message.ts:100–105` 的
   `MessageSourceMap`:`{kind:'user'}`= 人类键入,`{kind:'plugin', plugin}`= 注入,
   另有 model/tool)。纠偏检测**只看** `source.kind === 'user'`。
   被规约的对象面:`'tool/call'` 载荷为 `{turn, step, callId, name, arguments}`
   (arguments 是模型产出的原始 JSON 串,`types.ts:279`);`'assistant/message'`
   带装配后消息。中断信号:`'turn/end'` 的 `reason.kind === 'aborted'` 且
   `reason.reason.kind === 'user'`(`types.ts:155–177`,`TurnEndReasonMap`)。
3. **插件发廉价 LLM 调用**:范式见 `packages/session/session-title-llm/src/index.ts` —
   `ctx.llm.stream(options)`,`GenerateOptions` 含 `{provider, model, messages, system,
   maxTokens, sessionId, purpose, signal}`;用 `createUserMessage` 构造插件归因消息
   (`source: {kind:'plugin', ...}`),`BlockAssembler` 收块,`@deepseek-ai/dsh-timeout`
   的 `deadline()` 限时;发送前 append 一条 log-only 会话事件
   (`session/title-llm-request` 先例);`provider`/`model` 必须成对配置。
   DeepSeek 为默认 provider(`packages/llm/llm-deepseek/src/index.ts:251` 注册)。
4. **命令面**:`ctx.commands.register({name, description, input: {hint}, recordInput,
   handler})`,handler 返回 `{kind:'success', text}`。
   出处:`packages/feedback/command-feedback/src/index.ts:101`。
   规则文本需要留痕(provenance)→ `recordInput: true`,让 `command/run` 事件携带输入。
5. **遥测**:`session-telemetry/record` waterfall;ledger channel 与会话事件 append
   一一对应 —— 插件只要 append 自己的会话事件,即自动成为 ledger 遥测记录。
   出处:`packages/session/session-telemetry/src/index.ts:43`。符合共享原则 5。
6. **自定义会话事件约束**:`KNOWN_SESSION_EVENT_TYPES` 之外的类型,读路径在缺少
   `ignorable: true` 标记时拒绝解释该日志(`packages/core/session/src/types.ts:433`
   及 `known-event-types.ts` 头注释:仓外插件事件按构造不在表内)。
   → 本插件全部自定义事件必须带 `ignorable: true`,并通过 merge `SessionEventMap`
   声明类型(session-title-llm 即此范式)。

### 数据模型 / 配置(rule entry schema, budgets, thresholds)

> **配置声明（rc.7 起）**：本插件的用户可调旋钮（即下表的注入预算、overflow
> mode、阈值等）通过 settings 命名空间声明（`settingsNamespace` +
> `installSettingsSection`，`packages/settings/settings/src/index.ts:863`）：解析分层为
> schema 默认值 → cordis 组合条目（base）→ `settings.yaml` 用户文档；支持
> `settings/updated` 热更新与 `ctx.settings.describe()` 运行时读取。注册即暴露——
> #2404 移除了 apiproxy 白名单，注册是唯一的暴露控制点——因此 web 设置页与
> `settings.yaml` 都可编辑；cordis `apply(ctx, config)` 第二参数保留为组合默认值层；
> 下文的 `.dsh/rules/*.md` 是规则内容而非配置。

**存储**:`.dsh/rules/{behavioral,code-standards,self-review,anti-patterns,workflow}.md`,
五段一一对应 SSCA 五段。写入走插件内部原子写(temp + rename),不经 tool 表面;
相对 `session.cwd` 解析,随仓库走、可进 git code review。

**Rule entry**(每文件内一个 `<!-- rule: … -->` 元数据块 + 正文):

```md
<!-- rule: AP-003
section: anti-patterns
state: active            # candidate | active | archived
version: 2
author: user             # user | agent-suggested
source: { session: 01J…, ref: "PR#412 review comment" }
matcher: { kind: regex, events: [tool/call], pattern: "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}" }
stats: { exposures: 41, recurrences: 1, lastInjectedAt: 2026-08-15T… }
createdAt: 2026-08-03T…  activatedAt: 2026-08-09T…  archivedAt: null
-->
禁止空 catch 块;至少 log 并 rethrow,或调用 handleError(e)。
```

- `state: candidate → active → archived`;另有终态语义 `archived` 兼收 rejected
  (`source.verdict: rejected` 标记,作为 SkillOpt 式 negative feedback 留存)。
- `matcher` 仅在 activation 时定义,可选;`kind: tool-name | regex`,
  `events` 限定监听的事件类型集合。

**配置**(schemastery schema;默认值均为可调默认,共享原则 3):

| 键 | 默认 | 含义 |
|---|---|---|
| `injectionBudgetBytes` | 2048 | 每次装配注入 active 规则的最大 UTF-8 字节(AMV-L) |
| `overflowMode` | `audit` | `audit`= 仅被动截断渲染;`enforce`= 追加连续未注入降级提案 |
| `capture.suggest` | `audit` | `off` 关闭启发式纠偏探测;`audit` 只排队建议,永不生效 |
| `recurrence.escalation` | `notify` | `notify`(事件 + `/rule status`)/ `steer`(续轮征求强化稿)/ `off` |
| `consolidation.intervalDays` | 7 | 周期触发 |
| `consolidation.thresholdBytes` | 0.8×budget | active 总字节占比触发 |
| `consolidation.thresholdCount` | 24 | active 条数触发(SSCA 18 条已在有效区间,留余量) |
| `consolidation.maxEditsPerRun` | 8 | 单次 consolidation 的最大编辑数(SkillOpt 学习率) |
| `consolidation.provider/model` | 必填成对 | 辅助 LLM 路由;验证与成对要求同 session-title-llm |

**utility 打分**(降级排序用,越低越先被提案 archive):
`u(r) = w_r·recency(lastInjectedAt) + w_e·ln(1+exposures) + w_p·prevented(r)`,
其中 `prevented(r)` = 激活以来 matcher 在场且零复发的天数;`exposures` = 注入次数
(turn 级去重,microcompaction 重建不重复计)。**有未解决 recurrence 的规则不参与降级**
—— archive 一条正在失败的规则等于掩盖问题,它应先走强加流程;`pinned: true` 人工豁免。

### 关键行为流

**状态机(capture → candidate → active → archived)**
- 显式捕获:`/rule add <section> <text>` → 立即成为 candidate,append
  `rules/candidate`(ignorable)。
- 半自动建议(capture.suggest=audit):watcher 见 `source.kind:'user'` 的
  `user/message` 命中纠偏标记(可配词表,默认含 `不对`/`不要这样`/`别`/`should have`/
  `instead`),或 `turn/end`(aborted, user 原因)后紧跟同会话用户消息
  (interrupt-then-rephrase)→ 生成 suggestion 入待审队列,append `rules/suggested`。
  **audit-first:建议永不静默激活**,`/rule review` 列出待审,用户执行
  `/rule activate <id>` 或 `/rule reject <id>`。
- 所有状态迁移均为人工命令;自动面仅限:建议排队、复发计数、渲染截断、降级**提案**。

**注入流**
注册 `rules-lifecycle:active`(order 200)。不变式(verified):section text 同步求值,
故渲染结果在 store 变更时预生成并缓存,provider 只返回缓存串,装配热路径零 I/O。
渲染 = 五段顺序拼接 active 规则,超过 `injectionBudgetBytes` 时按 utility 从低到高
整体截断,尾部追加 `- …(+N rules omitted by byte budget; see /rule status)`。
每 turn 在 `turn/end` 聚合 append `rules/injection {bytes, ruleIds, omittedIds}`
(ignorable;不在装配时 append,避免装配副作用)。`enforce` 模式下,连续 K turn
被截断的规则自动生成 archive 提案进入 `/rule review`。

**recurrence 追踪流**
`session/event` listener(永不 throw,共享原则 2;异常仅经 telemetry 记录)。
对每条带 matcher 的 active 规则:`tool-name` 匹配 `tool/call.name`;`regex` 匹配
`tool/call.arguments` 原始串或 `assistant/message` 文本块。只计激活后的**新**出现:
以 `activatedAtSeq` 为基线,按事件 `seq` 去重。命中 → `stats.recurrences++`、
持久化、append `rules/recurrence {ruleId, seq, session}`(ledger → 遥测自动镜像,
severity 升至 `warn`)。escalation=`notify` 时 `/rule status` 置升级徽标;
`steer`(opt-in)走 `agent/turn-stopping` steer-back:在自然完成时注入带插件归因的
user 消息,要求 agent 草拟强化版规则文本为**新 candidate** —— 仍须人工激活,
steer 消息参与 round 记账故归因标记 `source: {kind:'plugin', plugin:'rules-lifecycle'}`
必须带(共享原则 2)。

**consolidation 流(SkillOpt/SSCA 维护阶段)**
周期或阈值触发。构造 prompt = 全部 active+candidate 正文 + archived 中 rejected 清单
(negative feedback)+ 各规则 stats;经 `ctx.llm.stream` 调用(verified 范式 3,
`purpose: 'rules-consolidation'`,预发送 append `rules/consolidation-request` log-only
事件)。模型产出**编辑提案**(merge/rewrite/archive ops),程序化 held-out gate 机检:
(a) 编辑数 ≤ `maxEditsPerRun`(有界编辑);(b) 不得删除/弱化任何带未解决 recurrence
规则的 matcher 语义;(c) 合并后总字节数不得增加。机检失败 → 提案整体拒绝并记录
rejected 反馈。通过后以 unified diff 文本经 `/rule consolidate` 呈现
(handler 返回 `{kind:'success', text: diff}`,不自造确认通道 —— 审批即用户键入
`/rule consolidate apply`,符合共享原则 1 的"人工门在命令面")。apply 写入 store,
全部受影响规则 `version+1`,append `rules/consolidated`。

### 端到端示例

1. PR#412 review comment:"**don't swallow errors with empty catch blocks**"。
2. 用户:`/rule add anti-patterns 禁止空 catch 块;至少 log 或 rethrow` →
   candidate `AP-003`(author=user, source.ref="PR#412 review comment")。
3. 用户:`/rule activate AP-003 --matcher regex:catch\s*\([^)]*\)\s*\{\s*\}` →
   active;下次装配起注入块出现 `### Anti-patterns\n- [AP-003] 禁止空 catch 块…`。
4. 两个会话后,agent 在一次 Edit 的 `tool/call.arguments` 中写出空 catch →
   watcher 命中,`recurrences: 0→1`,append `rules/recurrence`,`/rule status`
   显示 `AP-003 ⚠ recurrence @seq 517`。
5. 用户据此强化:`/rule add anti-patterns 禁止空 catch;统一调用 handleError(e)…`
   并 activate 为 `AP-003 v2`,matcher 收紧为
   `catch\s*\([^)]*\)\s*\{(?![^}]*handleError)`;此后 watcher 持续观测,零复发即
   `prevented` 累计 —— 复刻 SSCA 的"ruled-against 错误零复发"度量。

## 里程碑切分

**M1:store + 五段 schema + /rule 命令 + 注入器(byte budget)+ 单测**
`.dsh/rules/*.md` 读写(原子写)、entry schema 校验、`/rule add|list|activate|
archive|reject|status`、`rules-lifecycle:active` section 注册与预算截断渲染、
`rules/candidate|activated|archived|injection` 事件(ignorable)。
验证:单测覆盖 store round-trip、状态机非法迁移拒绝、预算截断顺序(utility 低先截)、
装配侧注入块快照;`pnpm new:plugin memory rules-lifecycle` 骨架门禁全绿(原则 6)。

**M2:recurrence 追踪 + 升级路径 + telemetry + 合成会话测试**
matcher 语言(tool-name/regex)、`session/event` watcher(listener 隔离+seq 去重)、
`rules/recurrence` 事件与 notify/steer 升级、启发式 suggest(`capture.suggest`,
audit-first)、exposure 计数与 utility 打分、连续截断 archive 提案(enforce)。
验证:合成会话(临时 SessionStore 上按序 append 事件夹具:纠偏消息、空 catch
tool/call、aborted turn/end)→ 断言建议入队不激活、recurrence 计数与序精确、
escalation 事件 severity=warn 出现在 telemetry 导出。

**M3:consolidation 流(diff 审批)+ utility 打分完善 + docs**
consolidation 触发器、LLM 提案(`purpose` 标记、预发送 log 事件)、机检 held-out
gate(maxEdits / 复发规则保护 / 字节不增)、diff 呈现与 `consolidate apply`、
rejected 反馈回留、README 的 graduation criteria 一节。
验证:MockAdapter 驱动的提案→机检→apply 全链单测(含超 maxEdits 被拒、
触碰复发规则被拒两个负例);docs 与本文档交叉一致。

## 验证计划

- **驱动方式**:M1/M2 用 vitest 单测 + 合成会话夹具(真实 `session/event` 缝,append
  事件触发 watcher,不 mock 事件总线);M3 用 agent-loop 测试既有的 MockAdapter 范式
  (见 `packages/core/agent-loop/tests/` 的用法)模拟 consolidation LLM。
- **可观察通过标准**:(a) 注入块 ≤ 预算且无半个规则(整体截断);(b) 纠偏启发式
  只进建议队列,`rules/active` 集合无任何非人工激活记录;(c) 空 catch 夹具在
  watcher 上产生唯一一条 `rules/recurrence`;(d) telemetry 导出含
  `rules/candidate|activated|recurrence|injection|consolidated` 全序列且 schema 与
  doc 12 的 eval 导出 schema 一致(原则 5);(e) 三次门禁全绿。
- **真实试用**:在本仓自身开发会话启用 ≥ 2 周,观察建议队列精度(采纳/拒绝比)
  与注入字节均值,作为毕业提名的遥测证据。

## 风险与开放问题

1. **启发式纠偏检测的误报面**:标记词会命中"用户在讨论别的内容"(如"这个 API
   不要这样设计"是任务讨论而非行为纠偏);interrupt-then-rephrase 会把
   "打断后追加无关新要求"误判为纠偏。缓释:audit-first(误报成本 = 建议列表噪音,
   无行为后果)+ 词表可配 + `capture.suggest: off` 兜底。开放:是否记录
   建议采纳率并自动降敏(待 M2 遥测数据决定)。
2. **与 09 token-wall 的交互(给出判断)**:规则文件写入**是权威变更** —— 规则文本
   将进入 system prompt,属 instruction supply chain;但其写路径不经 tool 表面
   (插件内部原子写),09 的 tool-call 准入分类天然看不到它。判断:**权威门由本插件
   自有的人工 gate 承担**(candidate→active、consolidate apply 均需显式命令),
   而不是 09 的 tool wall;与 09 的真实交点在两处信任边界 —— (a) candidate 文本源自
   用户消息,持久化与注入前应过外泄分类(用户纠偏里可能粘贴 secret);(b)
   consolidation 请求把规则全文发给 provider,已用 `purpose:'rules-consolidation'`
   标记,供 09/semantic-gateway 按 purpose 挂策略。开放:09 落地前,(a) 的分类器
   调用为可选集成(检测不到 09 即跳过并记录);届时须复用 tool-manifest 唯一注解
   机制声明该分类需求(原则 4)。
3. **辅助 LLM 路由解析**:session-title-llm 的 route 来自其 provider 契约内
   `request.route` 或显式 `provider+model` 对;**通用**插件取"当前会话路由"的
   api(如 `ctx.llm.resolveCallConfig`,见 `packages/host/apiproxy/src/api-proxy.ts:2288`
   内部用法)是否为稳定插件面**未确认**。检查项:确认其从 host 包导出与否;
   若不可得,则 `consolidation.provider/model` 保持必填(session-title-llm 同款策略),
   默认 DeepSeek provider。
4. **exposure 语义近似**:SSCA 的 exposure 是"规则在场时相关场景出现次数",此处
   以注入次数近似;microcompaction/compaction 重建 assembly 不计新 exposure
   (turn 级去重)。该近似可能低估"在场但未命中"场景 —— 接受,因 recurrence
   (命中率)才是硬信号。
5. **MemCon 式学习控制**:RETRIEVE/CONSOLIDATE/FORGET 的学习化控制仅列为
   future work;若未来引入,必须先以本插件 M2 起的遥测(采纳率、零复发天数、
   注入字节)建立 baseline,不允许无 baseline 替换规则化控制。
