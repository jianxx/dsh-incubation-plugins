# 05 long-run-protocol — 长跑会话协议

> 状态: design (not started) | Tier: 1 | 包: packages/session/long-run-protocol | 依赖: 无(可选集成 04)
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:为跨多小时、跨多个上下文窗口的任务提供一份会话协议——initializer 落地 init 脚本 + progress.md 工件、每轮收尾强制"增量进展 + 可合并的干净状态"、上下文焦虑时换窗不换事(fork reset + 结构化 handoff 续接)。
**用户问题**:长任务跑到后半段,agent 开始上下文焦虑:压缩后的历史让它把"干了不少"误读成"干完了",或在原地反复重述旧消息;用户回来时面对的是一团既讲不清进度、也无法被任何新会话接续的状态,只能推倒重来。

## 动机(为什么必要 — 一次性打完 + 提前完工两类失败)

Effective Harnesses for Long-Running Agents 指证了长跑会话的两类结构性失败:
(one-shotting)初始 agent 试图一口气干完整个任务,context 中途写爆后被迫在残缺的
上下文里硬撑;(premature completion)压缩/分轮之后,模型把"已经干了不少"误读成
"已经干完了",草草宣布完工。该文的处方正是本文档的三个支柱:**initializer agent**
(落地 init 脚本 + progress log + 首次 commit)、**增量轮次**(每轮只推进一步,禁止
one-shotting)、**每轮留下可合并的干净状态**(progress 更新 + workspace 无随意脏改)。

Harness Design for Long-Running App Dev 补上第二块:把"compression(压缩)"与
"reset(重置)"分开 — 当上下文出现焦虑症状(模型反复误引旧消息、注意力漂移、
溢出恢复频发),**context reset + 结构化 handoff 工件优于原地压缩**:压缩保留的
是带噪摘要,reset 丢弃叙事、只传递验证过的状态(goal/done/next/blockers/证据指针)。
该文的 Planner/Generator/Evaluator 角色分裂在本设计中不自造:Evaluator 的角色由
04 goal-verify-gate(运行时可选集成)承担 — 05 只管"过程协议",不管"完成判定"。

dsh 上游有全部底层原料(append-only session log + `sessions.fork` + 恢复面 +
compaction 插件),缺的是把它们**装订成一份协议**:progress 工件模式与 schema、
轮末检查的机器强制(enforce 档)、reset=fork+handoff 的完整闭环、以及度量。

## 现状与缺口

已核实(路径:行号在"表面与接缝"逐项列出):

- 会话是 durable append-only log;`ctx.sessions.fork(source, boundary?)` 已存在,
  以一个 **inclusive 事件 seq 前缀**作为子会话 seed,并拒绝在 open turn 内截断。
  但"何时 fork(boundary 怎么选)、fork 后用什么续接上下文、谁驱动用户切换到子会话"
  上游均无协议 — fork 只是原语。
- compaction 上游已有两插件(`compaction-basic`、`compaction-tool-result-pruner`),
  做的是**同一会话内的 surface 原位替换**(durable log 不动)。没有任何"换窗 +
  handoff 工件"通道。
- `agent/turn-stopping` 串行 hook 已提供"自然收尾时刻拦截缝"(04 已核)。
- **缺口三件**:①progress/handoff 工件的模式与落盘约定;②轮末检查
  (progress 更新了吗、状态干净吗)与 steer-back 强制;③fork-reset 的
  边界选择 + handoff 续接 + 切换引导;④配套遥测(rounds/resets/拦截类别)。

**明确不做**:不做跨 issue 调度与编排(06 的事,见"与 06 的边界");不做
Planner/Generator/Evaluator 多重角色(Evaluator 由 04 承担);不改上游 `/compact`
行为 — reset 与 compaction 共存互补(见"reset vs compaction 的边界")。

## 设计

### 表面与接缝(verified + cited)

1. **fork 缝**:`ctx.sessions` 服务键已注入 `Context`
   (`packages/core/session/src/index.ts:38-40`);签名为
   `fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`
   (同文件 `:1081`)。`boundary` = 源日志的 **inclusive 事件 seq**(非字节/消息数),
   省略则取源当前末事件(`:1100-1105`);child seed = `events.slice(0, boundary+1)`
   (`:1137`),即 **durable 事件前缀原样携带**。截断点不得落在 open turn 内:
   seed 前缀末段若最后一个 `turn/start`/`turn/end` 是 `turn/start`,抛
   `SessionForkError('OPEN_TURN')`(`:1128-1135`)。子会话 header 自动带
   `{cwd, parentSession, seedLength}`(`:1087-1094`;header 字段定义
   `packages/core/session/src/types.ts:61-80`)— fork 血缘天然可溯。
2. **可见上下文来源**:agent 发请求时从 log 投影 — `this.session.deriveMessages()`
   (`packages/core/agent-loop/src/agent.ts:341`),surface 逐节点投影规则
   `deriveEventMessage` 见 `packages/core/session/src/surface.ts:83`。→ fork 后子会话的初始可见上下文
   = seed 前缀的事件投影;**seed 事件不触发 `session/event` firehose**
   (构造 seed 不发布,`index.ts:450-472` firstLiveSeq 注释)。因此 handoff 文本
   不能指望"写进子会话 log 再被看见"(未驱动会话的 surface append 未验证,
   见风险 R1),应走 resume 时的注入缝(第 6 条)。
3. **系统提示缝**:`ctx.systemPrompt.section({name, order, text})` 返回精确
   disposer(`packages/core/system-prompt/src/index.ts:381-390`);`PromptSection =
   { name, order, text | (AssembleContext)=>string, complete? }`(`:53-75`);
   同名重复注册即抛、scoped 覆盖 global(按 name)、空 text 在渲染时被丢弃
   (`renderPrompt` `:212-217`)。elementprovider 每次组装执行,`AssembleContext`
   经声明合并携带 `agent?`(`packages/core/agent/src/runtime-types.ts:16-20`),
   调用侧恒填 `{agent, scope: agent}`(`packages/core/agent/src/dispatch.ts:175`,
   调用点 `agent-loop/src/agent.ts:230`)→ **全局注册一个 provider,按
   `context.agent?.session.id` 判断是否处於长跑模式**,无需 scoped 与 global 的
   互顶。order 取惯例空档 200–299(工具指引 100–199 之后,identity/persona 之前
   不插)。
4. **命令缝**:`ctx.commands.register(definition)`(`packages/interaction/commands/src/
   index.ts:245-252`),`CommandDefinition = { name, description, input?, recordInput?,
   handler }`(`:40-55`),name 必须匹配 `[a-z][a-z0-9_-]*`(`:25`);handler 收
   `CommandInvocation { commandId, agent, rawInput, signal }`(`:28-37`,带权威
   `agent.session`),返回 `{ kind:'success', text?, sourceEventSeq? } |
   { kind:'error', text }`(`:192-218`)。
5. **轮末拦截缝**:`agent/turn-stopping`,`@mode serial`,payload
   `{ agent, turn, signal }`(`packages/core/agent/src/runtime-types.ts:261-278`);
   **只在自然收尾触发** — turn 已得出 `turnEnds` 且 steering inbox 为空
   (`packages/core/agent-loop/src/agent.ts:295-296`);listener 抛异常 → turn 以
   error.conclusion(`:304-315`),**所以 listener 永不 throw**(doc 00 原则 2,
   全程 try/catch 收口)。steer 续的是**同一个 open turn**(steer 后 inbox 非空,
   循环走 `next-step` 而不是关 turn,`:299-300`)→ "每轮 cap" 按 `turn` 键计数。
   测试钉定注:上游 PR #2535 增加了 web e2e 测试,断言完整 `turn/end` reason 等于
   `{kind:'completed'}`(仅测试收紧;运行时事件/payload/触发条件均无变化)——
   该 reason 形态已被上游测试钉定;只依赖文档化形态。
6. **steer/inject 归因缝**:`agent.steer(message: UserMessage): void`
   (`runtime-types.ts:127-133`)注入下一步 steering;`agent.inject(...)` 排队
   下一个 pre-step 的 model-facing context、不唤醒 driver(`:135-143`)。
   message 由 `createUserMessage({ content, source })` 构造
   (`packages/llm/llm/src/message.ts:192-199`),source 用
   `{ kind:'plugin', plugin:'long-run-protocol', form:'notice'|'recall' }`
   (MessageSourceMap `:100-105`、form 枚举 `:88-94`)。doc 04 已核:
   `kind:'plugin'` 不会被 goal-round-driver 准入为新一轮(round 准入要求
   `source.kind==='goal'` 且序号精确)— **steer-back 不吃 round 预算**,
   归因纪律满足 doc 00 原则 2。
7. **resume 注入缝**:`agent/session-start`(emit,payload `{agent, source}`,
   `runtime-types.ts:207-217`),注释明示 "Use `agent.inject()` to seed
   model-facing context";`SessionStartSource` 含 `'resume'`(`:61`)。子会话被
   host 恢复时 source==='resume' 且 `session.header.parentSession` 命中本地
   lineage 记录 → 注入 handoff。
8. **fs 缝**:`ctx.fs: FileSystem`(`packages/fs/fs/src/index.ts:45-47`),用到
   `resolve / processPath / stat / readText / writeText`(`:116 / :126 / :152 /
   :176 / :222`),按沙箱后端实例化,不直拼 `node:fs`。
9. **遥测缝**(观测统一,doc 00 原则 5):服务键 `ctx.sessionTelemetry`
   (`packages/session/session-telemetry/src/index.ts:22-24`),发送口
   `SessionTelemetryBackend.emit(record)`(抽象 `:166`),record 为
   `{ channel:'ledger'|'ops', time, severity, attributes, body }`(`:64-86`);
   `session-telemetry/record` waterfall(`:26-47`)是红action扩展点,不是发送口。
   **本插件全部走 `channel:'ops'`**,attributes =
   `{ telemetry.op: 'longrun/<event>', session.id }`(op 词汇纪律照对端注释 `:76`),
   明细放 body;`ctx.get('sessionTelemetry')` 判空后使用。
10. **上下文压力缝**:`ctx.tokenMeter.measure(session)` →
    `TokenMeasurement { totalTokens, surfaceTokens, ... }`
    (`packages/llm/token-meter/src/index.ts:74`,measure `:116`;类型
    `token-meter/src/types.ts:22-36`)。模型容量解析照 compaction-basic 先例:
    `session.requestHeader()?.config` 取路由 {provider, model}
    (`packages/compaction/compaction-basic/src/index.ts:55`),再
    `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`(同文件
    `:293`)。fill% = totalTokens / contextWindow。
11. **shell 缝(可选)**:`ctx.shell: ShellExecutor`(`packages/shell/shell/src/
    index.ts:41-43`),`resolve(request): ShellExecSpec` + `run(spec)`
    (`:85, :93`)— workspace-dirty 检查与 init.sh 首次 commit 经它,服务缺失时
    降级为 warn(风险 R4)。
12. **事件面关闭**:自定义 session event 类型对 downstream 插件封闭 —
    `known-event-types.ts` 头部注释:"Downstream (out-of-repo) plugin events are
    outside this list by construction; a registration surface for them is deferred"
    (`packages/core/session/src/known-event-types.ts:7-15`)→ 本插件**不新增任何
    session 事件**,状态机走 `.dsh/` 文件,审计走 telemetry ops(与 doc 02/04
    同结论)。`tools/pre-execute` 的 decision 类型与 ask-registry 内解析结论
    照 doc 04(`packages/core/tools/src/index.ts:582-591`),本插件不经由此缝。

### 数据模型 / 配置(progress/handoff schema, thresholds, modes)

工作目录错位在任何项目根(`session.header.cwd`)下的相对位置:

```text
.dsh/longrun/
  init.sh        # 可复现环境检查脚本(可执行模板:版本/assert/依赖快速自检)
  progress.md    # progress log = handoff 工件(单一事实来源)
  state.json     # 插件私有:血缘与配置落点(见下)
```

`progress.md`(versioned markdown,版本在 frontmatter;模型是主要写入方,
插件只写初始脚手架 + 读取):

```markdown
---
schema: longrun/v1
goal: <一句话目标>
round: 0
updatedAt: <ISO8601>
---
## Goal
## Plan
## Done       # - [x] 条目 + 证据指针(commit hash / 文件路径 / session seq 链接)
## Next       # 立即下一步 1-3 条
## Blockers
## Evidence   # 跑动链接:测试命令、关键输出摘录、相关 seq 区间
```

**解析容忍**:缺节 → 视为空;未知节原样保留(重写时不动);frontmatter 缺
`schema` 或版本未知 → 按 v1 解析并 telemetry warn("partial write 容忍",
对应 initializer 写到一半被 kill 的场景)。插件从**不重写**模型维护的内容;

`state.json`(插件私有,小 JSON):

```json
{ "active": { "sessionId": "...", "goal": "...", "initedAt": "..." },
  "handoffs": [{ "childSessionId": "...", "parentSessionId": "...",
                 "boundary": 123, "reason": "manual|auto-suggest", "at": "..." }] }
```

配置(schemastery,三档可调,doc 00 原则 3):

```ts
mode?: 'off' | 'audit' | 'enforce'   // 默认 'audit';off = 只留命令,关一切拦截
workspaceDirtyPolicy?: 'off'|'warn'|'enforce' // 默认 'warn'
maxSteerbacksPerTurn?: number        // 默认 2;按 turn 键计数
autoSuggestFillPercent?: number      // 默认 75;0 = 关
```

遥测 op 词汇(`telemetry.op` attributes 值;bodys 放明细):
`longrun/init`、`longrun/round-check {turn, verdict, categories[], steeredBack}`、
`longrun/cap-exhausted {turn}`、`longrun/reset {boundary, childSessionId}`、
`longrun/handoff-inject {childSessionId}`、`longrun/auto-suggest {fillPercent}`。

### 关键行为流

**init 流**(`/longrun init <goal-text> [--commit]`,命令 handler 内):

1. 取 `invocation.agent.session.header.cwd`;缺失 → `{kind:'error'}` 返回并说明
   (会话必须有 cwd 才有项目根)。
2. `ctx.fs` 写 `init.sh`(环境自检模板;若已存在则跳过并重命名)、写
   `progress.md` 脚手架(goal 入 frontmatter)、写 `state.json.active`。
3. `--commit` 且 `ctx.shell` 在场:`git add .dsh/longrun && git commit`,
   结果并入返回文本;shell 不在场 → warn 文案降级。
4. 回显 current markdown 位置与"协议已生效"文本。幂等:重复 init 报错除非
   `--force`。

**round 检查 / steer-back 流**(`agent/turn-stopping` listener;listener 全程
try/catch,绝不 throw):

1. mode==='off' → 直返。取 payload `{agent, turn, signal}`;
   `ctx.get('fs')` 不在场 → 记一次 telemetry 后放行。
2. 读本条 session 的 progress baseline:`turn/start` 到达时(经
   `session/event` firehose,声明 `core/session/src/index.ts:74-76`)按
   `(sessionId, turn)` 缓存 progress.md 内容哈希;turn-stopping 时再读对比。
3. 三项检查,**逐项分类**(遥测的拦截类别按此命名):
   - `missing-progress`:progress.md 哈希与 baseline 相同(本轮没更新)。
   - `dirty-state`:policy 非 off 且 shell 在场时 `git status --porcelain`
     非空(空格文件名等边缘情况按 warn 降级)。
   - `premature-completion`:**仅当 04 在运行时在场**(读
     `.dsh/goal-verify-gate/goals/*.json` 最新 gate 结果,文件契约属 doc 04,
     见风险 R2)且本 turn 观察到 `update_goal complete` 工具调用被拒/未过
     gate;04 不在场不发此类别(缺判定面,不做文本启发式)。
4. audit 档:任何 catch 只记 telemetry + 不动 turn。**enforce 档**且 cap 未用尽:
   `agent.steer(createUserMessage({ content: 具体整改文本, source: { kind:'plugin',
   plugin:'long-run-protocol', form:'notice', summary: '<≤120字摘要>' } }))`
   — 整改文本具体到哪条挂了、要做什么(更新 progress.md 哪一节 / commit 或
   写进 Blockers / goal 还差哪条 gate),体现 steer-back-not-veto(不是拒绝
   turn 收尾,而是把带修复方向的 continuation 递回去)。
5. cap 用尽(同一 turn 内第 max+1 次失败):**不再 steer**,记
   `longrun/cap-exhausted`(severity warn),让 turn 正常收尾 — 死循环防线。

**reset = fork + handoff 流**:

- 手动:`/longrun reset [--at <seq>] [reason]`。boundary 选定:
  默认 = 源会话**第一个 `turn/start` 之前的 seq**(`findFirst(turn/start)-1`,
  即"留下全部 setup 事件、清掉全部叙事",对应 Harness Design 的窗口替换);
  `--at` 显式给出;`sessions.fork` 自身对 OPEN_TURN/越界 seq 的抛错
  映射为可读命令错误。**会话切换是 host-owned**(上游先例:command-resume
  只列会话并指向 `dsh --resume <id>`,不可程序化换会话)— 所以命令成功返回
  文本 = 新的 childSessionId + 切换指引;同时写 `state.json.handoffs.append(...)`
  并发 `longrun/reset` 遥测。
- 续接:子会话被 host resume 时,`agent/session-start`(seam 7)触发,查到
  lineage → 从**当前的** progress.md(容忍 partial write)构建结构化 continuation:
  goal / plan 摘要 / done 条目 / next / blockers / evidence 指针 + 协议义务重述,
  `agent.inject(createUserMessage({..., source:{kind:'plugin', plugin:
  'long-run-protocol', form:'recall', summary:'handoff'}}))`;记
  `longrun/handoff-inject`。state.json 丢失退化:`/longrun handoff` 手动重新生成。
- auto-suggest:turn-stopping 主流程顺带做 — seam 10 算 fill% ≥
  `autoSuggestFillPercent` 时记 `longrun/auto-suggest`;audit 档只遥测,
  enforce 档**至多一次**(每 threshold 阶梯)steer-back 请模型先把
  progress.md 写全 + commit,再由人执行 `/longrun reset`。**刻意不做
  serial hook 内的 approval ask**(会把 turn-close 堵在人机交互上,风险 R3),
  也与"host owns switching"一致:插件永远只建议,不擅自换会话。
- **丢失与保留**:丢 = 全部中间叙事(这正是意图:窗口替换>带噪摘要);
  保留 = progress.md 的 done/blockers/evidence 指针(commit hash、文件路径、
  seq 链接)+ 父会话完整 append-only log 永远可查(血缘 header 可追溯)。

### reset vs compaction 的边界

| | compaction(上游已有) | reset(本设计) |
|---|---|---|
| 机制 | 同一会话内 surface 原位替换,`compaction/*` 仅 log-only 影子事件
 (`packages/compaction/compaction/src/types.ts:16-89`;
 触发器 `compaction-basic` 挂 `agent/pre-step`,`src/index.ts:137-167`) | `sessions.fork` 新会话,以
 早期 boundary 的 durable 前缀为 seed + resume 注入 handoff |
| durable log | 永不动 | 父 log 永不动;子 = 新 log,血缘 header |
| 适用 | 中段 step pressure,叙事还有参考价值 | 上下文焦虑、溢出恢复频发、阶段切换 |
| 触发 | 自动(thresholdRatio 政策内) | 手动命令 + auto-suggest(永远建议) |

判词一条:上下文里的旧事实**还要被回头引用** → compact;旧叙事已成噪声源 →
reset。二者共存:reset 之后新的子会话照样受 compaction 保护(其 seed 前缀照常
投影),互不冲突。

### 与 06 issue-pilot 的边界

05 只定义**单会话内部**的长跑协议:工件契约、轮末检查、fork-reset 闭环、遥测。
**05 不做**:跨 issue 调度、分支/worktree 一 issue 一隔离、编排主循环(那些是
06 的事;06 用 fork provider 与 worktree 隔离)。06 实例化方式 = **每 issue 一个
05 会话**(独立 cwd 下独立 `.dsh/longrun/`),消费三样对外契约:命令、
progress.md 文件 schema、telemetry op 词汇。05 不感知"issue"概念。

## 里程碑切分

**M1: `/longrun init` + progress schema + prompt section + unit tests。**
注册命令与全局 prompt provider;init.sh/progress.md/state.json 脚手架;
schema 解析器(容忍 partial write)。验证:(a) init 命令在 fake-ctx(假
cwd/sessions/systemPrompt)上产出三文件,重复 init 二次报错;(b) prompt section
仅对 `.dsh/longrun/state.json` 命中的 session 出文本(`context.agent?.session.id`
映射断言),其余 session 组装零变化;(c) 解析器对缺节/未知版本/截断写入的
fixtures 不炸。pR 粒度。

**M2: turn-stopping round 检查 + steer-back + attribution + telemetry +
synthetic-session 测试。** 三分类检查、audit/enforce 两档、cap、归因。验证:
(a) 合成多 round 会话驱动:progress 未变 → 恰好一次 steer,
`user/message` 事件 source 断言 `{kind:'plugin', plugin:'long-run-protocol'}`;
(b) 连续两轮失败 → 第二次记 cap-exhausted,turn 正常关;
(c) listener 内 fault-injection(每个检查点抛错)用例断言 turn 仍以 completed 收
尾(永不 throw);(d) telemetry spy 断言 op 词汇落单。

**M3: reset via fork + handoff reconstruction + auto-suggest + metrics + docs。**
`/longrun reset [--at]`、`agent/session-start` resume 注入、auto-suggest 阶梯、
README。验证:(a) 合成会话 fork 断言:child.header.parentSession/seedLength 正确、
seed 长度 = boundary+1、构造鱼 firehose 静默;(b) resume fire 后第一次
pre-step 的 context 批次含 form:'recall' handoff;(c) 非法 boundary
(open-turn 点/越界)命令错误文案;(d) enforce 档 auto-suggest 达标只 steer 一次;
(e) kill-resume 演练:init 中写一半 progress.md 被截断 → reset 续接仍能
构建 handoff(parser 容忍)。rEPLAce via fork = M3 的接受标准。

## 验证计划

1. **单元**:progress.md 解析器 fixtures 矩阵(含 partial-write 截断);
   命令 handler 全部分支(无 cwd / 无 shell / 无 tokenMeter / 04 在场与不在场);
   配置 schema 默认值。
2. **合成会话集成**(参照仓库 test-support / agent-loop-mock 风格):真实
   `sessions.create` + 多 turn 驱动,断言 steer 事件形态、cap、归因、分类遥测;
   fork 断言 seed/血缘;resume 事件回放断言 handoff inject。
3. **遥测断言**:record spy 核对全部 op 的 attributes/body 形状(ops 词汇纪律)。
4. **真实 profile e2e**:一个故意多 round 的 demo 任务,跑通 init → 若干 round
   (含一次 steer-back 拦截)→ auto-suggest 触发 → 手动 reset →
   `dsh --resume <child>` 看到 handoff;人工核对离职工位(workspace 干净
   + progress 准确)。
5. **恢复演练**:进程 `kill -9` 于任意时刻后 resume,progress.md/state.json
   不腐败(各自的容错路径),`firstLiveSeq` 语义不受 fork 干预。
6. **毕业观察**(与 doc 00 毕业标准齐):指标面板展示 rounds / 、resets、
   各拦截类别计数与误拦申诉率,连续 2 周二连绿后提名毕业。

## 风险与开放问题

- **R1 未驱动的子会话 surface append 未验证**:备选设计本想把 handoff 作为
  `user/message` 直接 append 进 fork 后未驱动子会话让 seed 自带 — 未验证
  driverless 会话的 surface append 语义。**检查方法**:阅读
  `Session.append` 的 surfaceOp 路径对无 driver 会话是否允许(`packages/
  core/session/src/surface.ts` 接收规则),并写最小用例;当前设计用 seam 7
  的 `agent/session-start` + `agent.inject` 规避此依赖。
- **R2 04 gate-state 文件契约**:我们直接读 04 的 `.dsh/goal-verify-gate/goals/
  *.json`(运行时可选、编译期零依赖)。**检查方法**:05 M2 前读 04 M1 已合入的
  serialize 实现,确认字段;04 不在场/文件缺失/解析失败 → 只跳类、不炸流。
  若 04 schema 演化,本插件按版本字段协商,临时方案是容忍任何解析失败。
- **R3 auto-suggest 依赖两个可选服务**:`ctx.get('tokenMeter')` 服务键(spike:
  核 `llm/token-meter/src/index.ts` 的 declare module 键名)、
  `ctx.llm.resolveModelInfo` 可用性与 `contextWindow` 字段(照 compaction-basic
  `:293` 先例)。任一缺失 → 记一次 skip 遥测后该会话不再提。**检查方法**:
  在目标 profile 里打印一次二者存在性。
- **R4 workspace-dirty 检查依赖 `ctx.shell` 与 git 可用**:沙箱或无 git 项目
  下 `git status --porcelain` 不可行 → warn 降级;**检查方法**:`ShellExecSpec`
  的 cwd 字段与失败路径(读 `packages/shell/shell/src/index.ts` ShellExecRequest)。
- **R5 reset 切换引导是文本**:host owns switching(command-resume 先例),
  插件能给的最优 = 清晰命令回显 + state.json;若用户忘切换、继续父会话,父会话
  的 round 检查照常跑(protocol 对父子都生效,不构成数据风险)。
- **R6 state.json 与会话/store 的单向锚定**:以 cwd 为项目键,sessionId 存文件;
  **检查方法**:同一 cwd 多 profile 时确认不串(read path 校验 sessionId
  与 header.id 相等才判"本会长跑中")。
- **R7 enforce 档 auto-suggest 仅 steer 一次**:若模型整改后又跨阈值,不再
  steer(防止循环),只遥测。此权衡刻意为之;若实测漏警率高,在阈值之上
  加 % 阶梯(如 75/85/95 各一次)再做一轮评审。
