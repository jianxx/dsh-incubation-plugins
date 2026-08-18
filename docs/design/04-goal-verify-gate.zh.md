# 04 goal-verify-gate — 完成前置验证门

> 状态: design (not started) | Tier: 1 | 包: packages/goals/goal-verify-gate | 依赖: 无(可选集成 03)

## 设计目标与用户问题

**目标**:给 goal 的 complete 转换装上必须实际执行并通过的验证 gate(command 退出码/文件存在与内容/会话事件证据);gate 不过=目标只能停在 active(STALL),永远不能说完成;连续失败按阈值升级为 ASK 交给用户裁决。
**用户问题**:agent 自报"做完了"不需要任何成本——/goal 的完成判定今天完全靠模型自律,用户只能在事后收拾"宣布完成"与现实之间的落差;尤其无人值守的长任务,虚假完成是最贵的失败模式。

## 动机(为什么必要—DONE gate / 反虚假完成 / 三层状态恢复的第三层)

doc 00 的三层状态恢复:事件流可恢复(session log replay,上游已有)→ 执行环境可恢复
(上游已有)→ **目标验证 gate — 本工作项**。没有这一层时,`update_goal` 的
`complete` 只是模型自律:prompt guidance 写着 "Mark complete only when the objective
is actually achieved"(tool-goal/src/index.ts:119),但 harness 对「完成」零机器验证,
模型随时可以一句话把 goal 推进终态 — 这正是 Goal-Autopilot 指证的失败模式:
DONE 必须外化为带 gate 的判定,未通过 executed+passed gate 的目标只能 STALL,
永远不能声称成功。

三层验证栈的落位:01/02 管「单个工具结果/声明像不像真的」,03 管「轨迹合不合法」,
本工作项管「目标层面的完成判定」— 是最外层、也是唯一能拒绝 durable 状态转换的一层。
GODR 的 goal 生命周期诉求(suspend/resume/invalidate/return-point)**大部分已被上游
core ops 满足**(pause = suspend、resume、block ≈ invalidate-with-reason、
edit ≈ return-point 修正、clear),本文档明确不重复建设(见下节)。

gate 失败的反馈必须是**可行动的 corrective feedback**(哪个 gate 挂了、差什么、
怎么修),不是笼统拒绝 — 与 doc 02 同一立场(Prompts-to-Contracts:判定权在代码,
反馈供模型恢复)。

## 现状与缺口

已核实(路径:行号在下节逐项列出):

- `ctx.goals`(GoalService,event-sourced + CAS)已具全量域操作:`create / edit /
pause / resume / complete / block / clear`,durable `goal/change` 事件 +
  实时 `goal/changed` 通知;`goal-round-driver` 驱动续轮并对消息做 round 归因;
  tool-goal 已有 direct-human / goal-round 双权威通道。
- 因此 GODR 生命周期 = 已有;**缺口精确为一点:`complete` 这一个 transition 上
  没有任何可编程 gate**。模型自报完成的边际成本为零。

**明确不写并行 FSM**:不复制 GoalSnapshot/phase 机、不另建 durable store 来独立断定
done-ness。两部 durable 状态机对「完成与否」各说各话是本工作项的头号失败模式,
避免方式就是只做 complete 转换上的 gating(GoalService 的域扩展),done-ness 的
唯一权威仍是 `goal/change` 日志。

## 设计

### 表面与接缝(verified + cited)

1. **完成唯一模型路径 = 工具调用**:模型仅有 `update_goal(action:'complete')`
   一条路,落在 `ctx.goals.complete(agent, ref)`
   (`packages/goal/tool-goal/src/index.ts:307-308`;action 枚举 `:41-43`)。
   `/goal` 斜杠命令语法**没有 complete**(`packages/goal/command-goal/src/index.ts:14`
   USAGE、解析 `:33-43`),人类也不能走命令绕开。→ 拦截缝 = `tools/pre-execute`
   waterfall(`packages/core/tools/src/index.ts:142-152`),decision 类型
   `PreToolDecision = allow | deny {reason} | ask {reason?}`(同文件 `:583-591`):
   `deny` 物化为模型可见的报错结果(reason 即 corrective feedback);`ask` 由 registry
   经 `serviceAsk`(`:1690-1726`)走 approval waterfall,`allowed-once → allow`,
   其余三态 → 不同措辞的 deny;**无 approval 服务时 ask 确定性降级为 deny**。
   入参 `ToolExecution` 携带 `{name, arguments, callId, agent?, signal}`
   (`:314-337`、`:379-384`)— 按 `exec.name==='update_goal'` 且
   `arguments.action==='complete'` 命中,`arguments.goal_id` 直接给出目标。
2. **服务层无 veto 缝**:`ctx.goals.complete`(`packages/goal/goal/src/index.ts
:336-346`)直通 transition,GoalService 没有任何 pre-mutation hook;
   `goal/changed` 是 commit 之后的 emit 通知(`:541-558`,声明见
   `packages/goal/goal/src/domain.ts:104-116`),listener 失败被兜住但无法否决。
   用 cordis 服务同名重注册包裹 `goals` 不可行(服务键单主,重复注册即抛 —
   同约束见 session-telemetry 服务键注释 `:144-146`)。→ v1 拦截层定在工具缝,
   编程直调绕过的缺口列入风险 1。
3. **gate 结果不能搭车 goal/change**:durable payload 严格解码 —
   `decodeSnapshot` 要求字段集精确相等(`packages/goal/goal/src/fold.ts:87-112`,
   "must have exactly ... fields"),`GoalSnapshot` 无 metadata 扩展位
   (`packages/goal/goal/src/types.ts:59-68`);自定义 session event 注册面未开放
   (doc 02 风险 3 同结论)。→ gate 声明与报告由插件自存(见数据模型)。
4. **steer-back 缝**:`agent/turn-stopping` 串行 hook
   (`packages/core/agent/src/runtime-types.ts:261-278`):“a listener that objects
   steers (`agent.steer(...)`) … fresh steering runs another step, none closes the
   turn”;`agent.steer(message: UserMessage): void`(`:127-133`)。steer 续的是
   **同一个 open turn**(turn 尚未关),原 turn 的权威上下文(direct-human 或
   goal-round)保留,模型被 steer 后仍可合法调用 complete。归因形状照 tool-goal
   既有先例:`createUserMessage({ content, source: { kind: 'plugin',
plugin: 'goal-verify-gate', form: 'notice', summary } })`
   (`packages/goal/tool-goal/src/index.ts:313-324` 的 deferContext 用法 —
   我们用 `agent.steer` 直接注入)。`kind:'plugin'` 不授予任何 goal 权威
   (`packages/goal/tool-goal/src/authority.ts:65-74`),也不会被 round driver 误收为
   新 round(round 准入要求 `source.kind==='goal'` 且精确匹配 `roundsStarted+1`,
   `packages/goal/goal-round-driver/src/index.ts:48-58`、`:174-178`)—
   **steer-back 不吃 round 预算**,归因纪律满足 doc 00 原则 2。
5. **遥测缝**:`session-telemetry/record` waterfall +
   `SessionTelemetryRecord{channel, severity, attributes, body}`
   (`packages/session/session-telemetry/src/index.ts:35-46`、`:64-86`);
   发送口 = `ctx.sessionTelemetry.emit()`(服务键注册 `:148-151`,sink emit 为
   非阻塞 enqueue `:94-104`)。本插件全部走 **ops channel**,
   `attributes = { telemetry.op: 'goal-verify-gate/<事件>', session.id, agent.id }`,
   goal/gate 明细放 `body`(不动 attributes 词汇纪律)。未挂载 backend 时跳过
   (`ctx.get('sessionTelemetry')` 判空)。
6. **ASK 缝(stall 升级)**:`ApprovalRequest = { agent, toolName, callId?,
reason?, signal? }`(`packages/interaction/user-approval/src/index.ts:153-174`),
   `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
   (`packages/interaction/user-approval/src/types.ts:29`)。ASK 由 registry 代发,
   插件只需在 pre-execute 返回 `{ kind: 'ask', reason }` — reason 必须自带
   gate 失败摘要与决策选项说明(UI 只呈现这段文本)。ask/outcome 由
   ApprovalService 自己落 session 审计(`:188-190` 注释)。
7. **会话事件观察缝**(session-event-required gate 的证据面):`session/event`
   observer,`tool/call {turn, step, callId, name, arguments}` /
   `tool/result {turn, step, message, error?, meta?}` / `turn/end {turn, reason}`
   (`packages/core/session/src/types.ts:243-297`、`:155-177`;doc 02 已核读)。
8. **状态存放落点**:`.dsh/` 项目目录是上游既有约定
   (`packages/skill/skill-filesystem/src/index.ts:246` 的
   `<projectRoot>/.dsh/skills`)。gate 声明是 **goal 生命周期附属物**,
   以 goalId 键控存 `<session.header.cwd>/.dsh/goal-verify-gate/goals/<goalId>.json`:
   goalId 跨 resume/fork 稳定(replay 产出同一 id),session header cwd 为已校验
   绝对路径(`packages/core/session/src/index.ts:112-115`、header 属性 `:436-446`)。
   goal `clear` 时删除对应文件。cwd 缺失的会话:command/file 类 gate 拒绝声明并
   warn(风险 3)。
9. **命令落点**:core `/goal` 不可扩展(未知输入被解析成 create 目标,
   command-goal `:33-43`),`commands.register` 同名冲突即抛
   (`packages/interaction/commands/src/index.ts:77-82`、`:245`)。→ 注册独立命令
   `/goal-gate <add|list|remove|reset>`,不改上游语法。

### 数据模型 / 配置(gate declaration schema, modes, stall policy)

```ts
type GateMode = "off" | "audit" | "enforce";

interface GateSpec {
  id: string; // kebab-case, per-goal 唯一,遥测引用之
  kind: string; // registry 键;内置见「内置 gate 清单」
  mode?: GateMode; // 缺省回落全局 mode
  config: JsonObject; // kind 专属参数
}

interface GateReport {
  gateId: string;
  kind: string;
  passed: boolean;
  detail: string; // 可行动描述:exit code、缺失路径、未命中正则…
  durationMs: number;
  attemptedAt: number;
}

interface GoalGateState {
  // .dsh/goal-verify-gate/goals/<goalId>.json
  goalId: string;
  gates: GateSpec[];
  consecutiveFailedCompletions: number;
  lastAttempt?: {
    at: number;
    allPassed: boolean;
    reports: GateReport[];
    forced: boolean;
  };
} // steerBack 计数为进程内 per-(goalId, round),不落盘

interface Config {
  // schemastery,照上游插件惯例
  mode?: GateMode; // 全局默认 'audit'(与 doc 02 一致)
  gateTimeoutMs?: number; // 单 gate 超时,默认 120_000
  stall?: {
    afterConsecutiveFails?: number /* 默认 3, min 1 */;
    escalateViaAsk?: boolean; /* 默认 true */
  };
  steerBack?: {
    enabled?: boolean /* 默认 true */;
    maxPerGoalRound?: number /* 默认 2 */;
    completionPatterns?: string[]; /* 中英双语完成措辞正则,带保守默认库 */
  };
}
```

mode 解析(SafetySentry 连续谱,doc 00 原则 3):`gate.mode > config.mode(默认
audit)`。`off` = 该 gate 完全不执行;`audit` = 执行、放行、记遥测(为毕业标准
(d) 攒误拦数据);`enforce` = 失败即 deny。整体 `config.mode==='off'` 时插件
全面短路(拦截/steer/命令解析全部静默)。

### 关键行为流(complete 拦截流;turn-end premature-completion steer-back 流;stall→ASK 升级流)

**A. complete 拦截流**(`tools/pre-execute` listener,整体 try/catch 永不 throw;
自身异常 = fail-open `next()` + warn 遥测 — gate runner 的 bug 与「gate 不满足」
严格分两支,同 doc 02 原则):

1. 命中 `update_goal` + `action==='complete'` → 取 `exec.agent`、`arguments.goal_id`;
   读 `<goalId>.json`:无 gates → `next()`。
2. 顺序执行适用 gates(尊重 `exec.signal`;command gate 在 `session.header.cwd`
   以限定超时 spawn,失败/超时都折算为不通过的 report)。
3. 全过 → 写 `lastAttempt{allPassed:true}`、清零 consecutive 计数、发
   `goal-verify-gate/complete-allowed` 遥测 → `next()`。
4. 有失败:
   - 任一失败 gate 处于 `enforce` → consecutive+1,写盘,发
     `goal-verify-gate/gate-fail`(warn,body 带各 GateReport);
     - **stall 检查**:consecutive ≥ `stall.afterConsecutiveFails` 且
       `escalateViaAsk` 且全局非 off → 返回 `{ kind:'ask', reason }`(reason =
       gate 失败摘要 + 「批准 = 本次强制完成;拒绝 = 目标保持 active 继续修;
       放弃目标请用 /goal pause|clear」三选项说明);registry 的 `serviceAsk`
       把 `rejected/cancelled/unavailable` 各自翻成带区分的 deny 文案。
     - 未达阈值 → `{ kind:'deny', reason }`(reason 逐条列出 failed gates 的
       `detail` + 修复指引 + 当前 consecutive/阈值)。
   - 失败全是 `audit` 档 → `next()` 放行 + 同结构遥测(severity warn,
     `mode:'audit'` 标注,便于统计误拦率)。
5. 强制完成(ask→allowed-once)只豁免**这一次**调用;模型仍须持 fresh revision
   重试(CAS 是 GoalService 的事)。force 成功由后续 `goal/changed` 观察确认,
   phase 变为 terminal 后清理该 goal 的 store 文件。

**B. turn-end premature-completion steer-back 流**(`agent/turn-stopping` listener,
整体 try/catch 永不 throw — 抛异常会把 STALL 变成 crash,doc 00 原则 2):

1. 条件全满足才介入:本插件非 off;`ctx.goals.get(agent)` 存在且
   `phase==='active'`;该 goal 有 gates;本 turn 内**未**放过任何 complete attempt
   (进程内记录 `turn → allowed attempt seq`);本 turn 最终 assistant 文本命中
   `completionPatterns`。
2. cap 检查:`steerCount(goalId, roundsStarted) < maxPerGoalRound` →
   `agent.steer(createUserMessage({ content: <下述文案>, source: { kind:'plugin',
plugin:'goal-verify-gate', form:'notice', summary }}))`,计数+1,发
   `goal-verify-gate/steer-back` 遥测(info)。文案要点:列出该 goal 的 gates,
   要求「要么调用 update_goal complete 让 gates 跑起来,要么撤回完成措辞并说明
   剩余工作」。
3. 任一条件不满足(无 goal / 无 gates / 已 cap / 未命中措辞)→ 直接返回,turn 正常关。

**C. stall→ASK 升级流**:见 A.4;升级事实发 `goal-verify-gate/stall-escalated`
(warn,body = `{ goalId, consecutive, outcome }`)。用户强制完成后该 goal 的
store 文件随 terminal phase 清理;拒绝则计数保留,后续 attempt 继续走 A.4
(不重复 ASK 骚扰:`ask` 仅在「上一次 ask 之后又发生了 ≥1 次 deny」时再发)。

### 内置 gate 清单

1. `command-exit-zero` `{ command: string; timeoutMs?; cwd? }` — 在
   `session.header.cwd`(或显式 cwd)spawn,捕获 exit code 与 stderr 尾部;
   timeout 固定折算为 failed report。信任边界:command 由 **声明 gate 的人**
   提供(人类或创建期配置),不是模型运行时现编 — steer/deny 文案禁止诱导模型
   自己改 command。
2. `file-exists` `{ path }` — 相对 `session.header.cwd` resolve;只读 stat。
3. `file-matches` `{ path; pattern }` — 读文件(上限 1 MiB,超出按 unreadable
   处理)跑正则;用于「报告里必须包含某结论/某记号」。
4. `session-event-required` `{ name?: string; minSuccesses?: number = 1 }` —
   消费 `session/event`:自 goal create 的事件 seq 起,≥N 个 `isError===false`
   的 `tool/result`(可按 tool 名过滤,如对 bash/test 类工具)。
   证据窗口不随 goal edit 重置。
5. `trace-report`(M3,**runtime-optional 集成 03**)`{ minScore }` — 从 03
   trace-contracts 的运行时注册表读该 goal turn 的最新 trace report 分数;03 缺席
   或尚无报告时按 kind 级 `audit` 降级(不 deny)并 warn 遥测。跨包零编译依赖,
   只靠 kind registry 的运行时查找(见风险 5)。

未来 kind 经导出的浅 registry API 挂接:
`registerGateKind(kind, { run(spec, ctx): Promise<GateReport> })`,签名在 M1 冻结。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 标准)

- **M1 — gate registry + complete 拦截 + 三个文件/命令类 gate + 存储 + 单测**:
  kind registry、`tools/pre-execute` 拦截器、mode 解析、`command-exit-zero`/
  `file-exists`/`file-matches` 实现、`<cwd>/.dsh/goal-verify-gate/goals/<goalId>.json`
  读写与 terminal-phase 清理(挂 `goal/changed` 观察)、`gate-run`/`gate-fail`/
  `complete-allowed` 遥测。
  **验证**:mock pipeline(参照 `packages/core/tools/tests/invariant.spec.ts` 的
  `ctx.waterfall` 直驱法)— enforce 下 exit-1 命令 → `deny` 且 reason 含 gate id
  与 exit code;audit 下同样失败 → `allow` + 一条 warn 遥测;off → 全静默;
  gate runner 自身抛错 → fail-open + warn;存储文件 round-trip 与 clear 清理各一例。
- \*\*M2 — session-event-required + stall→ASK + turn-end steer-back + /goal-gate 命令
  - 遥测补全**:observer 计数、consecutive 跟踪与 ask 升级、completionPatterns
    默认库(中英双语)与 steer 注入、`/goal-gate add|list|remove|reset`。
    **验证\*\*:合成会话 — 连续失败达阈值后下一次 complete 返回 `ask`(无 approval
    backend 的部署确定性降级为 deny,照 `serviceAsk` 既有行为断言);turn-stopping
    触发注入的消息 `source.kind==='plugin'` 且 attribution 完整;同 round 第三次
    steer 不再注入(cap);listener 注入异常被吞且 turn 正常关闭;`/goal-gate add`
    落盘后,同 session 内 complete 拦截生效。
- **M3 — trace-report kind(03 运行时可选)+ 指标聚合 + 文档**:registry 运行时
  查找 03、缺席降级逻辑、ops 遥测的聚合视图脚本(误拦率、steer 命中、stall 次数)、
  README(含 graduation criteria 一节,勾选项含「premature-completion 拦截次数」
  遥测证据)。
  **验证**:03 缺席环境 `trace-report` gate 按 audit 降级并 warn;有 03 桩实现时
  分数阈值两侧各一例 deny/allow;README graduation criteria 全列出。

每个 M 独立可合入:M1 只加拦截面,M2 只加策略与人机面,M3 只加可选集成与观测面;
不改名既有 API,不触碰上游仓库文件。

## 验证计划

- **层一(纯函数)**:mode 解析矩阵;三个 gate runner(command 用临时脚本
  exit 0/1/超时;file gate 用临时目录);completionPatterns 命中/误命中用例表
  (含中英混排);store 序列化 round-trip 与损坏 JSON 的拒绝加载。
- **层二(mock pipeline 集成)**:按上游 invariant.spec.ts 姿势构造 ctx +
  waterfall,断言 allow/deny/ask 三支路与 consecutive 计数跨调用累积;
  fail-open(自身异常)单独一例。
- **层三(合成会话)**:`SessionEvent` 流喂 session-event-required observer;
  turn-stopping 全场景(介入/不介入/cap/异常吞没)。
- **层四(实跑观察)**:全局 `audit` 跑真实 profile ≥ 若干会话,人工抽查
  gate-fail 遥测的误拦率与 steer-back 是否骚扰(毕业标准 d 的数据来源)。
- 门禁命令:`pnpm typecheck && pnpm test`(worktree 内先
  `bash scripts/link-worktree-deps.sh`,见 CLAUDE.md)。

## 风险与开放问题

1. **编程绕过**:任何宿主代码直调 `ctx.goals.complete()`(或经其
   `@Remote('complete')` 导出)不受 `tools/pre-execute` 管辖;上游目前仅此一条
   模型路径,但不设防将来。检查项:`grep -rn "\.complete(" packages --include="*.ts"`
   在上游盘点直调点;中期向上游提案 GoalService 原生 gate 注点
   (pre-complete waterfall),届时本插件拦截器整体迁移而下层 gate 逻辑不变。
2. **`update_goal` 未来新增 action 或新 goal 工具面**:拦截条件写死
   `name+action` 组合,上游变形即静默漏接。检查项:M1 验收时对上游
   tool-goal 的 action 枚举做快照断言(常量比对测试)。
3. **session cwd 可得性**:`SessionOptions.cwd` 类型为可选
   (`packages/core/agent/src/index.ts:87-95`)。无 cwd 会话声明 command/file gate
   时应拒绝并 warn;检查项:实战 profile(ACP/CLI)是否恒设 cwd,若不恒设,
   M1 需要 fallback 策略(如进程 cwd + 显式审计标注)。
4. **steer 计数进程内易失**:resume/fork 后 per-round steer 计数归零,极端下
   同一 round 可能多收一次 steer(影响是轻微骚扰,不是正确性问题);gate 声明与
   consecutive 计数均落盘,主功能不丢。接受该取舍,不为此引持久化。
5. **03 trace-contracts 尚未成文**(`docs/design/` 目前仅 00/02):其 report
   artifact 形状、运行时暴露口未定。缓解:M3 前 `trace-report` kind 不进码;
   集成点收敛为一个运行时 lookup 函数,03 评审时核对两侧接口。检查项:
   03 doc 成型后补对接清单。
6. **ASK 三态不可表达**:`ApprovalOutcome` 只有 allowed-once 与三个非授权态,
   「abandon」无法做成第三按钮 → 设计内诚实处理:reason 文本写明放弃路径
   (`/goal pause|clear`)。检查项:上游若扩展 outcome 枚举则升级交互。
7. **强制完成的 CAS 缝隙**:ask→allow 只豁免 gate,模型随后若持 stale revision
   调用仍会被 GoalService 拒(`GOAL_STALE_REVISION`)— deny/ask 文案须提示
   先 `get_goal` 取新 revision(tool-goal guidance 本就如此要求),M2 会话测试
   覆盖此顺序。

---

_Verified seams(路径:行号均已在 2026-08-17 核读)_:
`packages/goal/tool-goal/src/index.ts:41-43 / :307-308 / :313-324`;
`packages/goal/tool-goal/src/authority.ts:65-74 / :101-108`;
`packages/goal/goal/src/index.ts:336-346 / :541-558`;
`packages/goal/goal/src/types.ts:59-68`;
`packages/goal/goal/src/fold.ts:87-112`;
`packages/goal/goal/src/domain.ts:104-116`;
`packages/goal/goal-round-driver/src/index.ts:48-58 / :174-178`;
`packages/goal/command-goal/src/index.ts:14 / :33-43`;
`packages/core/tools/src/index.ts:142-152 / :314-337 / :379-384 / :583-591 / :1690-1726`;
`packages/core/agent/src/runtime-types.ts:127-143 / :261-278`;
`packages/core/session/src/index.ts:112-115 / :436-446`;
`packages/core/session/src/types.ts:155-177 / :243-297`;
`packages/session/session-telemetry/src/index.ts:35-46 / :64-86 / :94-104 / :144-151`;
`packages/interaction/user-approval/src/index.ts:153-174 / :188-190`;
`packages/interaction/user-approval/src/types.ts:29`;
`packages/interaction/commands/src/index.ts:77-82 / :245`;
`packages/skill/skill-filesystem/src/index.ts:246`。
