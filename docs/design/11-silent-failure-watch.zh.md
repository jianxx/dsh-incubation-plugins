# 11 silent-failure-watch — 无崩溃失败类的运行时检测与离线复现

> 状态: design (not started) | Tier: 3 | 包: packages/observability/silent-failure-watch | 依赖: 无(schema 供 12 消费)
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:为"进程没崩、日志每行合法、但叙述早已偏离现实"的失败类提供在线只读探测器(结果无视/输出编造/上下文污染/计划漂移/job 空转),附离线 fault-injection 复现 → 干预 → 确认回路,全部产出结构化遥测旗标。
**用户问题**:危险的不是 agent 崩了,而是它没崩却一直在错:工具报错被默默跳过、根本没跑过的测试被写进总结、定时任务空转几周——用户翻日志时每一行都"看起来正常",等下游出事早已无法定位是哪一步开始说谎的,更无法验证"修好之后同样的坑不再犯"。

## 动机(为什么 pass/fail 日志漏掉最危险的生产 bug 类)

agent 生产环境最常见的严重失败不是 crash,而是**继续产出看似合理叙述的失败**:
tool 报错被无视、从未发生的文件/测试结果被断言、上下文被重试风暴污染、
定时任务空转——session log 每一行都"合法",没有异常、没有 veto,只有叙述与现实
缓慢分叉 (*When Errors Become Narratives* 的生产运行时纵向分类:fail-plausible
outputs、context pollution、plan drift、governance-check mismatch)。ToolFailBench
把这拆成可计数的独立质量轴:Tool-Skip / Result-Ignore / Output-Fabrication /
Unnecessary-Tool-Use,配 CTUR metric——最强模型 CTUR 也只有 86.33%,说明
tool-faithfulness 是必须独立观测的运行时属性,不能被端到端 pass/fail 吸收。

本包做两层:**在线**(durable 事件流上的只读探测器,产出结构化 flag,永不干预)
和**离线**(录制会话 + fault injection 的 reproduce → intervene → confirm 回路,
AgentCheck doctrine:silent DATA-QUALITY fault 远多于 crash;确定性 diff 为主、
LLM-judge 为辅)。OAT(在 SUCCESS trace 上无监督训练 step 级归因)定位为
未来/离线方向,不进运行时路径。

## 现状与缺口

上游 dsh 已具备:durable `session/event` 流(merge-extensible,逐事件持久化)、
`session-telemetry/record` waterfall 与 ledger 1:1 镜像、插件命令注册、
以及 `packages/test-support` 的 llm-replay / llm-mock-server / agent-loop-testkit
(可被离线脚本使用)。缺口:没有任何组件观测"结果存在但被无视""叙述与事件不符"
这类跨 step/turn 的属性;也没有把故障注入闭环做成可重复的工程回路。

## 设计

### 表面与接缝(verified + cited)

**事件流**(`@deepseek-ai/dsh-session`,源在
`deepseek-harness/packages/core/session/src/`):

- `SessionEventMap` 是 **declaration-merge 可扩展**的接口(types.ts:236–344,
  "merge-extensible, append-only source of truth"),事件名即接口键。envelope
  `SessionEvent = { type, seq(会话内单调), time(epoch ms), data, ignorable? }`
  (types.ts:415–434);`append` 校验全 JSON、deep-freeze(types.ts:291 注释 /
  index.ts:605–655)。
- 精确 payload:
  - `tool/call`:`{ turn, step, callId: CallId, name: string, arguments: string }`,
    arguments 是**模型产出的原始 JSON 字符串**(types.ts:279)。
  - `tool/result`:`{ turn, step, message: ToolResultMessage, error?: { name, code },
    meta?: JsonValue }`(types.ts:291–297);`ToolResultMessage.content =
    [ToolResultBlock]`,`ToolResultBlock = { type:'tool-result', toolCallId: CallId,
    content: ContentBlock[], isError? }`(`packages/llm/llm/src/types.ts:88–93`,
    `message.ts:152`)。call↔result 用 `callId`/`toolCallId` 配对。
  - `assistant/message`:`{ turn, step, message: AssistantMessage, usage? }`
    (types.ts:273);`TextBlock = { type:'text', text }`(types.ts:54–57)。
  - `user/message`(types.ts:257–264):三类来源——人类输入、合成
    `agent.inject()`(**含 cron notifications**)、goal continuation round,
    `source` 字段区分 → 定时任务运行的锚点。
  - `turn/start` / `turn/end { reason: TurnEndReason }`(merge-extensible
    `TurnEndReasonMap`,types.ts:155–177)、`step/start` / `step/end`。
- 订阅:`ctx.on('session/event', (session, event) => …)`
  (core/session/src/invariant.ts:223;接口声明 core/session/src/index.ts:76);
  observer 经 `invokeContainedSessionObservers` 收容(index.ts:641–646)。
- **重入禁令**:`append` 在发布期重入会 throw("session append cannot reenter
  while another append is being published",index.ts:622–624)→ 探测器在监听器里
  **只缓冲**,flag 延后在下一个事件边界(或 `turn/end`/`step/end`)再 append。

**遥测**:`session-telemetry/record` 是 cordis Events 上的 waterfall
(session/session-telemetry/src/index.ts:24–44);ledger 记录与会话事件
**1:1 镜像**,`SessionTelemetryRecord { channel:'ledger'|'ops', time, severity,
attributes, body }`(同文件 56–87)。结论:flag 落 session log
即自动进入 ledger 遥测,不自造导出通道(overview 原则 5)。

**命令**:`inject=['commands']`,在 `apply` 里
`ctx.effect(() => ctx.commands.register({ name, description, handler }))`
(session-query/session-log-export/src/index.ts:7–26;`CommandDefinition` 见
interaction/commands/src/index.ts:27–56;命令名 `[a-z][a-z0-9_-]*`)。

**插件形状与配置**:`export const name` + `export const inject` +
`apply(ctx, config?)`,config 即第二参数(test-support/llm-replay/src/index.ts
:772–809 先例)→ 采样/节流就是本包 Config 字段,无需新机制。

**离线 testkit**:

- `mountAgentLoopTestDependencies(ctx, { tools? })` 挂载 LlmRuntime /
  SessionStore / SystemPrompt / ToolRuntime / AgentRegistry
  (test-support/agent-loop-testkit/src/index.ts:18–49)。
- 工具桩:`ctx.tools.register(definition: ToolDefinition): () => void`
  (core/tools/src/index.ts:1037)→ 同名包装工具即 fault 注入点。
- llm-replay:输入 = **持久化 session.jsonl**。`parseSessionLog(text): SessionEvent[]`
  (第 0 行 header + 逐行 `decodeStorageRecord`,llm-replay/src/index.ts:167–177,
  chunk-rows.ts:339);`deriveReplayScript(events)` 以 `assistant/chunk` 在
  `finish` 处切分出每次模型调用的 `chunks` 条目(206+);`ReplayEntry =
  chunks | throw | hang`(36–42,throw/hang 无法从 log 重建,必须 override);
  `ReplayConfig { file, overrideFile?, childFiles?, providers?, paceMs? }`
  (84–121),`ReplayOverrideDoc = ReplayEntry[] | { patches }`(271–284);
  `installLlmReplay(ctx, config): ReplayHandle { dispose, assertConsumed }`
  (129–138, 697)。条目**按录制调用序弹出**、按 first-call 顺序绑定 live
  session(144–156,688+);`resolveScriptedEntry` 支持 FROM_REQUEST 模板
  从 live 请求取文本(379–385)。推论:注入 tool fault 后,模型仍按旧剧本
  回放 → 天然复现 "narrative 继续、现实已分叉" 的场景。
- llm-mock-server:`startMockLlmServer`,HTTP 层 24 种行为
  (`connection_reset/stall/rate_limit/malformed_json/…`,llm-mock-server/src
  /index.ts:16–44)——模型 transport 级 fault 的补充手段。

### 数据模型 / 配置(flag event schema[source-of-truth]、各 detector 配置)

> **配置声明（rc.7 起）**：本插件的用户可调旋钮（此处即各 detector 的
> 启用/采样/阈值默认值）通过 settings 命名空间声明（`settingsNamespace` +
> `installSettingsSection`，`packages/settings/settings/src/index.ts:863`）：解析分层为
> schema 默认值 → cordis 组合条目（base）→ `settings.yaml` 用户文档；支持
> `settings/updated` 热更新与 `ctx.settings.describe()` 运行时读取。注册即暴露——
> #2404 移除了 apiproxy 白名单，注册是唯一的暴露控制点——因此 web 设置页与
> `settings.yaml` 都可编辑；cordis `apply(ctx, config)` 第二参数保留为组合默认值层；
> 下文的 flag 事件 schema 是遥测词汇而非配置。

**flag 事件**——本 schema 是 source-of-truth,doc 12 eval-harness 按
`schema` 版本消费;事件经 declaration merging 并入 `SessionEventMap`,
payload 全 JSON:

```ts
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap { 'watch/flag': WatchFlag }
}

export interface WatchFlag {
  schema: 1                      // 版本门:12 端按此选择解析器
  detector: 'result-ignore' | 'output-fabrication' | 'context-pollution'
          | 'plan-drift' | 'job-drift'
  category: 'tool-skip' | 'result-ignore' | 'output-fabrication'
          | 'unnecessary-tool-use' | 'context-pollution' | 'plan-drift'
          | 'job-drift'          // ToolFailBench-flavored,预留扩展
  sessionId: string
  trialId?: string               // 离线回路 / doc 12 注入;在线缺省
  turn: number; step?: number
  evidence: { seqs: number[]; callIds?: string[] }  // 证据 = 事件 seq(窗口可多个)
  severity: 'info' | 'warn' | 'error'
  mode: 'audit'                  // 常量:本包永不 intervene
  detail: string                 // ≤120 字符机器摘要(CONTEXT_SUMMARY_MAX_CHARS 惯例)
}
```

命名 `watch/flag`(非 `silent-failure/*`)与控制面汇率兼容;`evidence.seqs`
引用 monotonic seq,消费端可直接 join 回 session log。

**配置**(全部走 `apply(ctx, config)` 第二参数;采样=per-detector `sampleRate`
0..1,节流=`maxFlagsPerTurn` 硬顶 + 同证据去重):

```ts
export interface Config {
  enabled?: boolean            // 默认 true;纯 AUDIT,无 enforce 档
  trialId?: string
  maxFlagsPerTurn?: number     // 默认 20
  detectors?: {
    resultIgnore?:      { enabled?; lookaheadSteps?: number /* N,默认 3 */;
                          minTokenChars?: number; sampleRate?: number }
    outputFabrication?: { enabled?; extraPatterns?: string[]; sampleRate?: number }
    contextPollution?:  { enabled?; windowSteps?: number; repeatThreshold?: number;
                          pasteChars?: number; sampleRate?: number }
    planDrift?:        { enabled?: boolean; windowTurns?: number;
                          goalPathHints?: string[]; sampleRate?: number }
    jobDrift?:         { enabled?: boolean; kRuns?: number; sampleRate?: number }
  }
}
```

### 在线探测器清单(每个:信号/成本/误报姿态 表格化)

| detector | 信号定义(输入事件 → 判定) | 成本(O/事件) | 误报姿态 |
|---|---|---|---|
| result-ignore | `tool/result` 后取 result 文本的关键 token/id(去停用词,`minTokenChars` 过滤),在后续 N 个 step 的 `assistant/message` 文本中检索;全缺 ⇒ flag,evidence = 该 result seq + 覆盖窗口 seqs。`isError`/空结果直接跟踪"是否被承认"。 | 每 result 一次 token 化 + N 次子串检索;滑动窗口,O(N×文本长),有界 | 高误报面:总结性语言合法地不复读 token。默认 `severity:'info'`,`sampleRate` 可降;先按"error 结果被无视"子类收紧(faithful 更强) |
| output-fabrication | `assistant/message` 文本命中最小 claim 模式集(`已写入/创建了 <path>`、`测试通过`、`已提交/PR #\d+`);在同 turn 后续事件里查无对应 `tool/call`(写类工具/todolist/目标 gate)⇒ flag,evidence = claim 的 message seq。**与 doc 02 的边界**:02 是 tool RESULT 的 admission 时 enforcement + turn 级 claim audit;11 是跨 turn drift 遥测,永不拦截。M1 自带最小模式集;02 稳定后迁共享 lib(详见风险节)。 | 每条 assistant 文本一轮正则,O(模式数) | claim 可被"口头计划"误伤 → 只对完成时态/断言形态匹配;`warn` 起步,报告驱动调参 |
| context-pollution | 三指示器:① `windowSteps` 内相同 (name, canonicalized arguments) 的 `tool/call` ≥ `repeatThreshold`(retry storm);② 单条 `user/message` 文本 > `pasteChars` 且与近期内容高重合(大段粘回);③ 同 turn 内 assistant 文本语言/领域突变(script/语种 charset 跳变)。各自独立 flag。 | 窗口哈希计数,O(窗口);重合度用抽样 shingle | 合法重试(轮询、编译-修错循环)是高误报面 → `repeatThreshold` 保守默认 5+,只 `info`;③ 只发 `info` |
| plan-drift(**proxy**) | 有 goal 时(04 域;当前由 `goalPathHints` 手工供 paths):连续 `windowTurns` 内所有 `tool/call.arguments` 均不触 goal-adjacent path ⇒ flag。明确标 proxy:无 goal 语义也可跑,纯路径亲和启发式。 | 每 call 一次 path 前缀匹配 | 探索/阅读阶段天然离 path 远 → 只 `info`,只在连续窗口触发;04 落地后改读其 gate paths(运行时可选集成,编译期零依赖,overview 原则 1) |
| job-drift | 以 `user/message` 的 cron 类 source 为 job 运行锚点;同一 job 连续 `kRuns` 次运行间无状态改变类 `tool/call`、且携带 diff 的 `tool/result.meta` 为空 diff ⇒ flag(空转检测)。 | 每 job 运行 O(窗口内事件) | 只 `info`;`kRuns` 默认 3;cron source 的确切形态未验证(风险节 Q3),在此之前仅对可识别锚点生效 |

探测器输出**只有结构化 flag 事件**(evidence 用事件 seq/callId),不产叙述文本;
叙述渲染留给 `/watch report` 与 12。

**`/watch report`**:`inject=['commands']` 注册 `watch`,handler 渲染本会话近期
flag(按 turn 分组、detector×severity 统计、最新 K 条含 evidence seq 链接
`turn:step`);`rawInput` 支持 `turns=N`/`detector=x` 过滤。CommandResult
`kind:'success', text:…`(session-log-export 先例)。

### 离线 replay+fault-injection 回路

位置:`packages/observability/silent-failure-watch/scripts/`(tsx 运行,
package.json `scripts.watch-replay` 入口)。输入 = 持久化 session.jsonl
(与 `ReplayConfig.file` 同格式,`parseSessionLog` 可解析即验收标准)。

**ReplayEnvelope 注记(已对照 rc.7 核实)**:上游提交 `7e95a00c8a`
(`fix(llm): align replay state with assembled content and degrade unusable
state`)把持久化的 replayState 变为带版本的 v2 `ReplayEnvelope`
(`packages/llm/llm-pi-ai/src/replay.ts`、`packages/llm/llm/src/assembler.ts`);
外来的/畸形的/版本不符的状态现在降级为 provider-neutral 的转换,并带
`onReplayDegrade` 诊断(`packages/llm/llm-pi-ai/src/context.ts:87-148`),
而不是以 `INVALID_REPLAY_STATE` 硬失败。对本文档的后果:max-tokens 后续接
(max-tokens-then-continue)的 fixture 不再令 replay 硬失败;在 rc.5 时代树上
录制的 `session.jsonl` fixture 仍是合法输入。`llm-replay` test-support API 本身
未变——已用 `git diff e3e27afa2e master -- packages/test-support/llm-replay`
核实(仅版本号变更),「表面与接缝」中引用的 API 面按原样成立。

**`watch-replay run --session s.jsonl --fault <class> --at-call k --tool <name>`**:
根 cordis ctx → `mountAgentLoopTestDependencies` →
`installLlmReplay(ctx, { file })` → `ctx.tools.register` 同名包装工具
(内部计数,第 k 次调用注入 fault)→ 装载本插件(带 `trialId`)→
跑完后 `ReplayHandle.assertConsumed()` → 产出 rerun session log。

**fault 类**(tool 层;模型层 `throw/hang` 由 `overrideFile` patches 原生支持,
作为手段之一不在四类内):

1. `stale-value`:返回同参数上一次调用的结果快照(陈旧值)。
2. `empty-result`:`ToolResultBlock.content = []`。
3. `permission-flip`:返回 `isError: true` 的拒绝体(逼真度依赖真实 denial
   的 `error.code` 词汇,见风险 Q2)。
4. `timeout`:hang 至 AbortSignal 后 throw(模拟超时路径)。

**`watch-replay diff`**(确定性为主,AgentCheck doctrine):replay 不校验请求
相等(按序弹出 + FROM_REQUEST),因此 fault 之后模型仍按旧叙述走——
**全文 diff 无意义**,diff 语言收窄为三个确定性断言:
(a) **detector-eval**:rerun log 的 flag 集 ⊇ 该 fault 的期望 flag 集
(对应 detector 必须命中,给出 seq);
(b) **canary 断言**:为 fault 注入的唯一 canary token,在 result-ignore ground
truth 下应在后续 assistant 文本中缺席;
(c) **prefix 等值**:fault 点之前按序事件与原 log 逐字段相等。
LLM-judge 为辅(可选 `--judge`,独立配置模型,门禁不依赖):评最终叙述
是否与 fault 后的真实状态一致(低分 = silent failure 成立)。

**mitigation-confirm**:`watch-replay confirm --mitigation <plugin-module|config-json>`
重跑同 fault 并断言 silent 叙述不再完整走完——出现干预证据(doc 02 enforce 的
deny/steer 事件、或本插件 flag 在更早 seq 命中且后续输入被修正)。这是
reproduce → intervene → confirm 的工程闭环;候选修复通过可选依赖在离线时
装载,运行时仍零编译期依赖。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 标准)

**M1 — schema + 两个探测器 + 合成会话测试**
`pnpm new:plugin observability silent-failure-watch` 脚手架;`watch/flag` 经
declaration merge 进 `SessionEventMap`;result-ignore 与 output-fabrication 探测器
+ per-detector `sampleRate`/`maxFlagsPerTurn`;录制侧零干预路径。
验证: 合成 `SessionEvent` 序列单测(金样 flag 集,含 evidence seq 精确断言);
schema JSON round-trip;重入纪律测试(监听器内不 append,延后 flush 有据);
门禁全绿(build/typecheck/test/check:exports/check:spec-deps)。

**M2 — 剩余探测器 + 采样节流 + /watch report**
context-pollution(三指示器)、plan-drift proxy(config 供 hints)、job-drift
(可识别锚点生效);`/watch report` 命令注册与渲染。
验证: 每探测器一组合成场景单测 + 节流上限断言;命令输出金样;
`turns`/`detector` 过滤参数测试;session-telemetry mounted 下 watch/flag 以
ledger 记录出现(1:1 镜像)的集成测试。

**M3 — 离线 CLI + 4 类 fault + mitigation-confirm + docs**
`watch-replay run/diff/confirm`;4 fault 类;`--judge` 可选;README
(graduation criteria 一节) + 本目录文档对齐。
验证: 一个录制 fixture 会话 × 4 fault 类,各自期望 flag 集确定性命中;
`confirm` 模式配合造假 mitigation(如提前 ack 的测试插件)断言 silent 叙述
被打断;`assertConsumed` 未消费检查生效;门禁全绿。

## 验证计划

- **单测**:探测器纯函数化(event 序列 → flag 序列),合成会话全金样。
- **集成**:testkit + llm-replay 构造"剧本无视 tool 结果"的会话,result-ignore
  必命中;空转 job、重试风暴合成场景覆盖其余三探测器。
- **遥测兼容**:挂 session-telemetry 最小 sink,断言 watch/flag 以 ledger
  record 出现、`session-telemetry/record` waterfall 可正常改写。
- **离线回路**:M3 的 4×fixture 矩阵 + mitigation-confirm 断言,确定性部分
  进门禁;LLM-judge 只出报告不进门禁。
- **回读 doc 12**:schema `schema:1` 冻结后,12 端以 fixture flag 事件做
  consumer 契约测试(12 立项时补)。

## 风险与开放问题

- **启发式探测器的误报经济学**:全 AUDIT、永不干预 ⇒ 误报的直接代价是
  报告噪音与遥测体量,不是错误拦截。姿态:`info` 起步、`sampleRate` +
  `maxFlagsPerTurn` 双层节流、`/watch report` 人工校准回路;12 端按
  detector×severity 统计后再收紧。最危险的是 result-ignore 的全量匹配版,
  M1 先用"error 结果未被承认"子类。
- **与 02 pattern 库的去重路径**:02(claim-contracts)= tool RESULT 的
  admission 时 enforcement + turn 级 claim audit;11 = 跨 turn drift 遥测,
  永不拦截。两者 claim 模式形态重叠但消费不同。决策:M1 自带最小模式集
  (完成时态断言 + 工件类型白名单),**显式声明为临时副本**;02 落地后把
  模式库提升为共享(候选:并入 doc 01 tool-manifest 旁注或独立 patterns 包),
  11 改为依赖该库;过渡期两份并存但 schema 字段名一致。
- **开放问题(未确认项与精确检查)**:
  1. **envelope `ignorable` 的写方路径**:`Session.append(type, data)` 公开
     签名不带 ignorable,仅 seed 校验中读取(index.ts:205–245)。检查
     core/session 是否另有带 opts 的 writer;未确认前 `watch/flag` 以
     required 事件处理——不识别该 type 的旧读端会按规范 refuse,离线
     工具链需同步升级(可接受,均为本仓/上游内)。
  2. **permission-flip 逼真度**:真实拒绝产生的 `tool/result.error.code`
     词汇未验证(`dsh-permission-rules` 源码不在 checkout,types.ts:336–343
     注明)。M3 前从 dsh-cc-plugins 侧跑一次真实 denial 录成 fixture,再定
     fault 的 error 文本。
  3. **cron/job 运行的锚点形态**:`user/message` 文档列举 "cron
     notifications"(types.ts:257–264)但未确认 schedule 包注入的确切
     `source.kind` 结构。检查 `packages/schedule/schedule` 的注入实现;
     在此之前 job-drift 只对可识别锚点生效。
  4. **goal path hints 来源**:04(goal-verify-gate)未建,plan-drift 的
     goal-adjacent paths 暂由 config 手工供给;04 落地后改运行时可选读取
     (编译期零依赖)。
  5. **replay 无 request-equality 校验**(按序弹出 + FROM_REQUEST 模板,
     llm-replay/src/index.ts:379–385、688+ 已确认)→ diff 语义只能是
     flag 集 + canary + prefix 等值,不做全文比对;若上游将来加入请求校验,
     离线回路需适配(在 README 记录)。
