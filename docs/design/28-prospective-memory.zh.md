# 28 prospective-memory — 前瞻记忆/延迟意图(Tier 2)

> 状态: design (not started) | Tier: 2 | 包: packages/memory/prospective-memory | 依赖: 24(意图评测集,仅 M4);上游 schedule 工具(rc.7 已有)
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给 agent 一个一等公民的"延迟意图"对象——带触发条件、过期时间、武装状态与抑制策略的持久意图记录,在会话内事件/工件状态/时间三臂上成熟触发,触发时先评估抑制(过早/过时/重复)再行动。
**用户问题**:"测试跑完了就告诉我"、"发布会后提醒我把那条临时规则删掉"——今天的 agent 只有两种失败方式:要么现在就做(把'等测试跑完'变成'立刻轮询占用上下文'),要么干脆忘掉。没有带过期与抑制的延迟意图对象,agent 的承诺和它的上下文一样短命。

## 动机

前瞻记忆(prospective memory)研究的直接结论是:**即使是专门构建的系统也做不好这件事**。
PM-Bench(2607.12385)报告 purpose-built 系统 Set-F1 仅 65.1%,且失败模式集中在两端——
**过早执行**(前置条件看似满足实则未满足,cue 一出现就动手)与**过时执行**(世界已经
变了还按旧意图行动)。这决定了本设计的重心:抑制(suppression)不是事后补丁,而是
设计中心;触发臂要刻意简单,评估器要刻意保守。

PMMC(2608.00962)提供触发器设计的概念输入:在巩固(consolidation)阶段把意图编译为
可判定的"问题程序"(question-program),而不是把原始自然语言意图留到触发时刻再解释。
对应到本设计:意图落盘时就把自然语言 trigger/action 尽量结构化为简单模式(见"触发臂"),
触发时刻只做模式匹配 + 抑制评估,不做开放解释。

以上均为基准/论文结果,按共享设计原则呈现为设计输入,不承诺 ROI。

## 现状与缺口

已具备(deepseek-harness,均经核实,引用见「表面与接缝」):

- durable 提醒记录:一次性 At/After + 周期 Every 的 `schedule_*` 工具。
- 工具执行三段决策面:pre-execute `{allow|deny|ask}`、execute + post-execute——
  事件模式臂的监听点。
- `agent/turn-stopping` 自然完成串行钩子——回合边界评估点。
- `session-telemetry/record` 运维遥测通道。

缺口:

- 无延迟意图对象:没有 {触发条件, 动作, 过期, 武装状态, 抑制策略} 的持久记录。
- **无任何 on-time 保证的执行机制**:`ctx.jobs` 是进程内契约,`ctx.interval`/`ctx.timeout`
  effect-scoped 自动清理——没有任何东西能在无人运行的会话之间触发(见下"诚实持久性")。
- 无抑制语义:过早/过时/重复触发没有分类、没有记录、没有用户可见面。
- `schedule_*` 只是提醒不是调度器(见下),把"提醒到达"当作"条件满足"正是 PM-Bench
  过早执行失败模式的复刻。

## 设计

### 表面与接缝(verified + cited)

以下来源仓库根:`$DSH` = 上游 `deepseek-harness` 仓库根(引用均为其仓内相对路径)。

| 接缝 | 已核实表面 | 出处 |
|---|---|---|
| durable 提醒记录 | v1 `ScheduleRecord = OneShotScheduleRecord (After \| At) \| EveryScheduleRecord`;create/list/delete 值类型 `ScheduleCreateValue`/`ScheduleListValue`/`ScheduleDeleteValue` | `$DSH/packages/schedule/schedule/src/types.ts:52-74`、`:199-211` |
| 工具 pre-execute 决策 | `PreToolDecision = { kind: 'allow' } \| { kind: 'deny'; reason } \| { kind: 'ask'; reason? }` | `$DSH/packages/core/tools/src/index.ts:588-591` |
| 工具 execute + post-execute | `PostToolDecision`(accept/block + additionalContexts)决策面 | `$DSH/packages/core/tools/src/index.ts:597-601` |
| 回合自然结束钩子 | `agent/turn-stopping`(serial;scope-filtered;payload `{agent, turn, signal}`) | `$DSH/packages/core/agent/src/runtime-types.ts:272-278` |
| listener 异常语义 | turn 循环 catch:非 LlmError 压平为 `UNKNOWN` code 的 error turn——**listener 必须永不 throw**(原则 2 的 crash 依据) | `$DSH/packages/core/agent-loop/src/agent.ts:304-315` |
| 续轮 steering | `agent.steer(message: UserMessage)` | `$DSH/packages/core/agent/src/runtime-types.ts:133` |
| jobs 契约边界 | "The contract is in-process"——JobStart 传回调与确切 Agent 对象,durable 后端必须重塑 identity/restart/ownership | `$DSH/packages/jobs/jobs/README.md:40` |
| timer 契约边界 | `ctx.interval`/`ctx.timeout` 等 mixin,Disposable、effect-scoped 自动清理 | `$DSH/vendor/timer/src/index.ts:4-15` |
| 观测 | 自定义 session 事件类型对插件封闭(未知类型遭持久层拒收);遥测统一走 `session-telemetry/record` 运维通道 | `$DSH/packages/session/session-persistence-jsonl/src/format.ts:244` |
| 配置 | `settingsNamespace` + `installSettingsSection`(注册即暴露,热更新 `settings/updated`) | `$DSH/packages/settings/settings/src/index.ts:863` |

设计决策:

1. **意图存储是本插件自带的持久层,不是 `ctx.jobs`**——后者契约是进程内的
   (`packages/jobs/jobs/README.md:40`),重启即丢,与"延迟"语义正交。
2. **时间臂完全委托上游 `schedule_*`**;本插件不造第二个计时器。必须原样引用其边界:
   > schedule_* 是提醒,不是调度器:它只负责未来把一条通知投递进会话;不保证在无人运行时触发、不包含动作执行。
3. 事件模式臂挂在 tools/post-execute + turn-stopping;监听器全部只读 + 记账,
   永不 throw;需要行动时经 `agent.steer()` 注入带 `[prospective:<intentId>]` 归因前缀的
   续轮消息(原则 2:steer 消息参与 round 记账,归因必须显式)。

### 意图记录

存储:durable JSONL/JSON,落在仓库/工作区本地 `.dsh/prospective/intents.jsonl`
(追加 + 定期 compaction;原子写沿用 06 的 tmp+rename 模式)。每条记录:

```jsonc
{
  "intentId": "uuid",
  "version": 1,
  "trigger": {
    "kind": "event-pattern",        // 见"触发臂"
    "pattern": { "tool": "shell.run", "argGlob": "*pnpm test*", "resultPredicate": "exitCode==0" }
  },                                 // 或 { "kind": "artifact-state", "check": {...} }
                                     // 或 { "kind": "time", "scheduleId": "..." }
  "action": "跑完测试后把结果摘要发给用户",   // 自然语言(必填)
  "structured": null,                // 可选结构化动作(仅 M0 支持 steer 消息一种)
  "expiry": "2026-09-01T00:00:00Z",  // 过期即 disarm,不再评估
  "armed": true,
  "createdBy": "user",               // user | model | plugin
  "provenance": { "session": "...", "turn": 12, "seq": 345 },
  "suppression": {                   // 触发时评估,见"抑制"
    "precondition": "exitCode==0 && durationMs>60000",  // 可选:模式之外的额外前置
    "staleCheck": "referenced-file-exists",             // 可选:过时探针
    "dedupeWindowMs": 300000
  },
  "history": [ /* armed/disarmed/fired/suppressed 事件 */ ]
}
```

### 触发臂(刻意简单)

1. **event-pattern(事件模式)**:tools/post-execute 与 turn-stopping 上匹配
   `{tool 名, 参数 glob, 结果谓词}` 三元组。模式刻意保持哑匹配——不做语义解释;
   复杂判断交给抑制阶段的 precondition。命中 ≠ 触发,先进抑制评估。
2. **artifact-state(工件状态)**:turn-stop 时执行廉价只读探针——文件存在/内容
   正则、git 状态(经 `ctx.shell.run` 只读命令,如 `git log -1 --format=%H`)。
   同样:探针为真 ≠ 触发,先进抑制评估。
3. **time(时间)**:不新建计时机制。意图落盘时调用上游 `schedule_create`
   (一次性 At/After,`packages/schedule/schedule/src/types.ts:52-74`),把返回的
   schedule id 记入 trigger。当该提醒**投递进会话**时,插件不直接行动,而是重新
   评估完整条件(事件臂/artifact 臂的当前状态 + 过期 + 抑制)后决定行动或抑制——
   这是对上文 schedule 边界脚注的直接工程后果:提醒只是"醒来看一眼"的 cue,
   不是"条件已满足"的证明。

### 诚实持久性(prominent)

**本插件没有 on-time 保证,也不假装有。** `ctx.jobs` 是进程内契约
(`packages/jobs/jobs/README.md:40`),`ctx.interval`/`ctx.timeout` effect-scoped
自动清理(`vendor/timer/src/index.ts:4-15`)——基于时间的触发在无会话运行时不可能
发生;`schedule_*` 也只承诺把通知投递进(未来的某个)会话。因此语义是
**at-least-once + 迟到抑制**:一个在无人运行期间成熟(matured)的意图,在下一次
会话启动或下一个 turn-stop 被评估,由抑制策略决定它仍然有效还是已经过时。
用户面的所有文案必须呈现这一语义;任何"准时触发"的 UI 措辞都是缺陷。

### 抑制(设计中心)

每次命中按序评估,任一命中即拦截并落 `memory.intent.suppressed` 遥测事件:

| 类别 | 判定 | 动作 |
|---|---|---|
| premature(过早) | 模式命中但 `precondition` 不满足(如退出码 0 但耗时可疑地短——测试根本没跑) | 不触发,保持 armed,记录命中计数;连续 N 次 premature → 转 needs-user |
| stale(过时) | 已过 expiry,或 `staleCheck` 探针失败(引用的文件已删、规则已被手动清理) | disarm,终态记录,一次性通知用户"意图因过时被丢弃" |
| duplicate-fire(重复) | 同一意图在 dedupe 窗口内再次命中 | 拦截,计数 |

`memory.*` 遥测键约定属于 doc 24 的范畴,本文只约定本插件事件:
`memory.intent.armed` / `memory.intent.fired` / `memory.intent.suppressed`
(reasonClass: premature|stale|duplicate) / `memory.intent.expired`,全部经
`session-telemetry/record` 运维通道(不新增 session 事件类型,原则 5)。

### 用户面与配置

- slash 命令:`/prospective list`(armed/disarmed/终态分组)、`/prospective cancel <id>`、
  `/prospective history <id>`。武装默认仅显式用户动作(model 创建的意图落盘为
  `armed: false`,待用户 `/prospective arm <id>`——"不自主武装"是缺省)。
- 审计:全部 armed/fired/suppressed 走遥测(见上)。

配置(标准 配置声明(rc.7 起) 小节;`settingsNamespace` +
`installSettingsSection`,`packages/settings/settings/src/index.ts:863`;解析分层
schema 默认值 → cordis 组合条目 → `settings.yaml`,热更新 `settings/updated`,
运行时 `ctx.settings.describe()`;注册即暴露):

```yaml
prospective-memory:
  maxActiveIntents: 64        # 超出拒绝新建(用户面提示)
  sweepCadenceTurns: 10       # 每 N 个 turn-stop 做一次全量扫(artifact/time 臂)
  defaultExpiryDays: 7        # 未显式给 expiry 的意图的缺省过期
```

## 里程碑切分

**M0 — 记录 schema + store + 事件模式臂**
intent schema + `.dsh/prospective/` store(原子写、启动加载、compaction)+
tools/post-execute 与 turn-stopping 上的事件模式匹配(命中 → 抑制评估 → steer 行动,
steer 消息带 `[prospective:<id>]` 前缀);premature/duplicate 两类抑制;
`/prospective list|cancel`;遥测四事件。单测:schema 校验、模式匹配表、抑制判定表、
监听器 throw 隔离(注入抛错的相邻 listener 断言本插件不受影响)。
**验证**:会话内造一条 "pnpm test 成功后告诉我" 意图,人工跑测试,
断言 steer 续轮发生且 history/遥测记录 fired。

**M1 — artifact-state 臂**
turn-stop 廉价只读探针(文件/git),stale 抑制 + staleCheck;sweep 节流
(sweepCadenceTurns)。单测:探针只读性(全部经 mock `ctx.shell` 断言 command
白名单)、stale 判定。

**M2 — time 臂 via schedule_* + 恢复对账**
`schedule_create` 集成(schedule id 回填 trigger)、提醒投递 → 重新评估 →
行动/抑制;重启/新会话启动时的 reconciliation 扫描(成熟未处理的意图补评估)。
**验证**:设 1 分钟后的 At 提醒,关掉会话再开,断言补评估路径与"迟到抑制"文案。

**M3 — 抑制调优**
premature 连续计数转 needs-user、dedupe 窗口、expiry/默认过期、
`maxActiveIntents` 上限与用户提示;不自主武装缺省的完整用户面。

**M4 — PM-Bench 式打分(依赖 doc 24)**
在 doc 24 的意图评测包上按 Set-F1 + 过早/过时失败分布打分
(评测轨道本身属于 doc 12/24 的范畴,本文只消费)。

## 风险与开放问题

- R1 **事件模式臂的接缝覆盖度**:post-execute 能看到解析后的工具结果,但部分
  工具结果可能以投影(content)而非结构化 value 返回;`resultPredicate` 对哪些
  工具可用需 M0 逐工具盘点,不可用的退化为 turn-stop 探针。
- R2 **steer 行动的时序**:turn-stopping 串行触发,steer 注入发生在下一请求前,
  但若意图行动本身需要工具调用,它占用的是用户回合的预算——归因前缀 + 遥测是
  唯一追责面;是否需要"意图回合"独立记账,开放。
- R3 **多会话并发**:两个会话同时评估同一意图文件——store 的并发写(追加式 JSONL
  + compaction rename)需要文件锁或 last-writer-wins 约定,开放(M0 先单会话假设)。
- R4 **schedule 记录生命周期**:意图 cancel 时需联动 `schedule_delete`;上游提醒
  已投递但意图文件丢失(用户手动删)的孤儿场景,只能是记录性处理,开放。
- R5 **model 创建意图的质量**:自然语言 trigger → 简单模式的编译(PMMC 概念)在
  M0 只做用户显式给定模式;model 自主编译列为开放问题,且受"不自主武装"缺省约束。
- R6 **PM-Bench 数字的适用性**:65.1% 是其基准上的系统上界,不是本插件预期;
  M4 打分前不得引用为预期值。

## 边界与不做的范围

- 不做调度器/动作执行器:时间触发完全委托 `schedule_*`(脚注语义);
  意图"行动"只有一种形态——带归因的 steer 续轮消息。
- 不做跨机器/云持久:store 是工作区本地文件;无人值守 on-time 交付明确不在范围。
- 不做语义触发解释:trigger 保持哑模式;复杂判断进抑制 precondition,且 precondition
  本身也限定为同一小谓词语言。
- 记忆内容的读侧治理(谁能读到哪条记忆)属于 doc 13;出口审计属于 doc 09;
  记忆打包与 `memory.*` 键约定属于 doc 24——本文不重叠。
- 证伪线:若 doc 24 的意图集显示抑制主导(多数武装意图在触发时刻已过时),
  本特性收窄为仅显式用户武装,永不自主武装——缺省即按此实现,M3 只是确认而非放宽。
