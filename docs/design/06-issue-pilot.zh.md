# 06 issue-pilot — issue 级任务控制面

> 状态: design (not started) | Tier: 1 | 包: packages/control-plane/issue-pilot | 依赖: 01, 04, 05

## 设计目标与用户问题

**目标**:把 agent 控制面钉在 issue 粒度——每个 issue 一个独立 worktree + 独立会话 + 独立预算的限流并发状态机,WORKFLOW.md 作为流程契约,CI 与评审意见自动回流为继续/修正指令,产出以 landed PR 与吞吐计量。
**用户问题**:想让 agent 批量消化 issue 队列的团队或个人,今天的交互形态是"一个人盯一个聊天框":谁在做哪个 issue、卡在哪一步、烧了多少 token 全靠人肉记;并发稍一放开就互相踩 workspace,失败了没有恢复路径——吞吐的上限是人盯人的注意力,不是机器。

## 动机

生产级 agent 控制面的锚点不在聊天会话粒度,而在 **issue/task 粒度**(Symphony 的核心教训:
控制面从「人盯 3–5 个 chat session」迁移到 issue 状态机后,团队 landed-PR 吞吐 ~5x / ~3 周)。
其四个可复制的要素:(1) per-issue 状态机;(2) 每任务独立 workspace(SwarmResearch: 每路径独立
branch/worktree,上下文隔离,仅 shepherd 处汇总);(3) WORKFLOW.md(YAML frontmatter + 模板正文)
作为 flow 契约;(4) agent 带 goal + 工具(含 `gh`、CI 日志)运行,产出以 PR 落地。dsh 已有全部
基座原语(agent 注册表/会话持久化/shell/jobs/telemetry),缺的是把它们编排成 issue 控制面的
那一层——本工作项即该层,也是对 04(gate)与 05(long-run)的端到端压测(见 00-overview 构建顺序)。

## 现状与缺口

已具备(deepseek-harness,均经核实,引用见「表面与接缝」):

- 程序化创建独立 agent 会话(指定 `cwd`、组合 setup、可续轮 steering、可 dispose)——`ctx.agents`。
- 插件级周期定时器(effect-scoped,自清理)——vendored cordis `timer`。
- 前台命令执行(带 cwd/timeout/结构化结果)——`ctx.shell`;后台 job 注册表——`ctx.jobs`。
- slash command 注册面——`ctx.commands`;观测 waterfall——`session-telemetry/record`。

缺口:

- 无 issue → 会话 的生命周期状态机(发现、排队、工作区准备、驱动、CI 回流、评审回流、终态)。
- 无 per-issue worktree + 依赖引导 的自动准备(git worktree 只有 tracked files,
  node_modules 缺席——必须显式 bootstrap)。
- 无 WORKFLOW.md 契约解析与 04/05 组合挂载。
- 无跨重启的 issue 状态持久化与 reconciler(`ctx.jobs` 是进程内契约,重启即丢)。
- 无预算护栏(并发上限、token 预算、重试退避、kill-switch)。
- 上游无 kill-switch 文件先例(全仓 grep 无命中),为本设计新引入。

## 设计

### 表面与接缝(verified + cited)

以下来源仓库根:`$DSH` = 上游 `deepseek-harness` 仓库根(引用均为其仓内相对路径)。

| 接缝 | 已核实表面 | 出处 |
|---|---|---|
| 创建 per-issue 会话 | `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>`;`CreateAgentOptions = { sessionId, meta?: { cwd?, parentSession?, origin?, delegationDepth? }, seed?, agentOptions?, signal?, setup? }`;`AgentHandle = { agent, dispose() }` | `$DSH/packages/core/agent/src/index.ts:405`(public `create`)、`:202`(abstract `createAgent`)、`:172`(`AgentHandle`)、`:95`(`meta.cwd`,validated absolute) |
| 续轮 steering | `handle.agent.followup(message: UserMessage): void` | `$DSH/packages/core/agent/src/runtime-types.ts:124` |
| 会话恢复(重启后 re-attach) | `ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>`(需 session persistence) | `$DSH/packages/core/agent/src/index.ts:424` |
| 非 agent 调用方先例 | SDK server 在插件上下文直接 `ctx.agents.create({...})` | `$DSH/packages/sdk/server/src/server.ts:223` |
| 周期定时器 | `ctx.interval(callback, delayMs): () => void`(返回 dispose;effect-scoped,插件卸载自动清理);另有 `ctx.timeout`、async-iterator 形态 | `$DSH/vendor/timer/src/index.ts:5-7`(Context mixin 声明)、`:31+`(`TimerService`) |
| 插件清理 | `ctx.effect(() => { ...; return dispose })`;agent-scoped 监听先例(schedule 的安装器) | `$DSH/packages/schedule/schedule/src/index.ts:43-47` |
| gh/git 执行 | `ctx.shell.run(spec)`,`ShellExecRequest = { command, workdir?, timeoutMs?, signal?, stdoutMaxBytes?, env? }`;resolve `ShellRunResult = { exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr }`;**仅在基础设施失败时 reject,非零退出正常 resolve** | `$DSH/packages/shell/shell/README.md`(Service API 表)、`$DSH/packages/shell/shell/src/types.ts:113` |
| 后台 job 注册表 | `ctx.jobs.start(spec): JobId`(须先 `attachController(name)`)、`kill/wait/get/list/onJobDone`;**契约是进程内的**(Known Limitations 明示) | `$DSH/packages/jobs/jobs/README.md` |
| slash command | `ctx.commands.register({...})` 先例 | `$DSH/packages/goal/command-goal/src/index.ts:164` |
| 观测 | `session-telemetry/record` waterfall(record 可经 waterfall 改写) | `$DSH/packages/session/session-telemetry/src/index.ts:43` |

设计决策与含义:

1. **不用 `ctx.subagents` 承载 per-issue 会话。** `ctx.subagents.startContinuable()` 要求一个
   live parent Agent(`$DSH/packages/subagent/subagent/README.md:Service API`),而 issue-pilot
   自身是插件不是 agent;直接 `ctx.agents.create()` 创建 top-level 会话,steering 由 pilot 自己
   经 `handle.agent.followup()` 完成,与 binding 原则 2(steer-back 续轮而非 veto)一致。
   `meta.origin` 目前仅接受字面量 `'subagent'`(index.ts:99 附近),pilot 会话**不设置** origin。
2. **依赖引导原生实现,不依赖 dsh-cc-plugins 的 tool-git-worktree**(跨仓库仅运行时可选,
   原则 1;本项明确禁止该集成)。worktree/依赖均经 `ctx.shell.run` 执行 `git` 与引导脚本。
3. **job 用于可观测/可取消,不用于持久化**:每次 spawn 的驱动循环包装为一个 `ctx.jobs`
   job(controller 名 `issue-pilot`),持久状态只落在 state 文件;重启靠 reconciler 重建。
4. **无人值守会话的批准面**:pilot 创建的是 top-level 会话,不经过 subagent 的
   delegated-policy 钉死;组合上要求部署侧为 pilot 会话提供 `approval 'never'` + sandboxed
   `ctx.shell` 的组合(见风险 R2)。

### 数据模型 / 配置

**Issue 状态文件** `.dsh/issue-pilot/<owner>/<repo>/<issue>.json`(原子写:tmp+rename):

```jsonc
{
  "version": 1,
  "issue": { "owner": "o", "repo": "r", "number": 123, "title": "..." },
  "state": "discovered|queued|preparing|running|awaiting-ci|in-review|merged|failed|needs-human",
  "attempts": 1,
  "budget": { "tokensUsed": 0, "tokenLimit": 500000, "wallClockMs": 0 },
  "links": { "branch": "pilot/issue-123", "worktree": ".worktrees/issue-123",
             "pr": null, "sessionId": "..." },
  "cursors": { "lastCommentId": null, "lastCheckRunId": null },
  "lastError": null,
  "history": [{ "from": "queued", "to": "preparing", "at": "ISO", "reason": "..." }]
}
```

状态机:`discovered → queued → preparing → running → awaiting-ci → in-review → merged`;
任非终态可入 `failed`(可重试,attempts++ 后回 `queued`)或 `needs-human`(终向人工)。
`merged` 是**观测到**的终态(pilot 永不执行 merge,merge 属人或仓库 auto-merge)。

**WORKFLOW.md 契约**(仓库根,Symphony 模式;frontmatter 经 schema 校验,body 为模板):

```yaml
---
label: pilot:queued            # 输入 label
steps: [reproduce, fix, test, open-pr]
done:                          # done-criteria,逐项映射 04 gate kinds
  gates: [tests-green, diff-scope, pr-opened]
allowPaths: ["src/**", "tests/**"]   # 01/trace 前置条件的 diff 边界
budgets: { tokens: 500000, wallClockMin: 120 }
reviewers: [alice]             # 必需人工评审,before merged 由仓库规则保证
---
Issue: {{number}} {{title}}
{{body}}
<05 long-run-protocol init block:每轮结构、进度账本格式、gates 再校验时机>
```

正文模板按 issue 渲染,经 spawn 时的 `setup` 组合进会话:挂载 05 long-run-protocol init
(进度账本/续轮纪律),把 `done.gates` 注册为 04 gate 实例(`tests-green` 的跑法、`diff-scope`
读 `allowPaths`、、`pr-opened` 读 `links.pr`),工具面按 01 tool-manifest 的副作用分类限定。

**Guardrail 配置**(插件 config,均有默认):

```yaml
issue-pilot:
  repos: [{ owner, repo, workflowPath: WORKFLOW.md }]
  pollIntervalSec: 60
  maxConcurrent: 1            # 允许 1-2
  maxAttempts: 3              # 指数退避 base 2^attempts * 5min
  defaultTokenBudget: 500000
  killSwitchFile: .dsh/issue-pilot/KILL
  bootstrapScript: scripts/link-worktree-deps.sh   # 本 repo 家族默认;他仓按 config 覆盖
```

### 关键行为流

**主流(poller → spawn → drive → PR → merge)**:

1. **Poller tick**(`ctx.interval` 每 `pollIntervalSec`):先查 kill-switch 文件存在则整体休眠;
   `ctx.shell.run({ command: 'gh issue list --label pilot:queued --json number,title,body,labels', workdir: <repoRoot>, timeoutMs: 30_000 })`;
   与 state 目录对账 → 新 issue 写 `discovered`;并发槽(当前 `preparing|running|awaiting-ci|in-review`
   计数 < `maxConcurrent`)有空则 `discovered → queued → preparing`。
2. **Preparing**:`git worktree add .worktrees/issue-<n> -b pilot/issue-<n>`;随后 bootstrap:
   默认按 `bootstrapScript` 执行(本 repo 家族即 `scripts/link-worktree-deps.sh` 模式——
   worktree 只有 tracked files,脚本把主 checkout 的各级 `node_modules` 符号链接过来);
   任一失败 → `failed`(可重试)。
3. **Spawn**:`ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: <worktree 绝对路径> },
   setup })` —— `setup` 内完成 05 init + 04 gates + 01 工具限定;resolve 后
   `handle.agent.followup(<渲染后的 WORKFLOW.md 正文作为首条 user 消息>)`,并把驱动循环注册为
   `ctx.jobs` job。→ `running`;issue 打上 `pilot:running`。
4. **Driving**:agent 在 worktree 内工作、跑测试、打开 PR(`gh pr create` 为其工具面内动作,
   副作用已按 01 分类)。pilot 每 tick 读 `gh pr list --head pilot/issue-<n> --json number,state`,
   PR 出现 → `awaiting-ci`,记录 `links.pr`。
5. **CI 回流**:`gh pr checks <pr> --json name,state`;全绿 → `in-review`(置 `needs human review`
   注释);有红 → 把 `gh run view --log-failed` 摘要经 `followup()` 注入(消息带插件归因前缀
   `[issue-pilot:<issue>#<attempt>]`——steer 消息参与 round 记账,归因必须显式,原则 2)。
6. **评审回流**:`gh pr view <pr> --json comments,reviews`;以 `cursors.lastCommentId` 增量,
   新评审评论 → `followup()` 注入要求修改;agent 修完推新 commit,回到 CI 回流。
7. **Merge 观测**:`gh pr view --json mergedAt` 非空 → `merged`;label 换 `pilot:done`,
   移除 `pilot:running`;清理埋点记录落账后的 cost(默认保留 worktree,由 GC 子命令统一清理)。

**预算与重试**:每 tick 从该会话 telemetry 快照累计 `budget.tokensUsed`;超限 →
`handle.dispose()` + label `needs-human` + issue 注释。gate 反复不过 → `failed`,退避后
回 `queued`,`attempts` 达 `maxAttempts` → `needs-human`。

**重启 reconciler**:插件加载时扫描 state 目录:非终态但 `ctx.jobs` 中无对应 live job →
若 session persistence 可用则 `ctx.agents.resume()` 续驾(attempts 不增),否则按重试策略
回 `queued`(attempts++)。`merged/needs-human` 不动。

**人工面**:`/issue-pilot run <n>`(手动发现并入队一个 issue,跳过 label 等待)、
`/issue-pilot status [n]`、`/issue-pilot report`、`/issue-pilot gc`。

### 失败分类学

| 类型 | 检测信号 | 恢复动作 |
|---|---|---|
| stuck-loop | `history` 中连续 K(默认 3)个 tick `running` 且分支 head SHA 不变、无新 gate 通过 | dispose + `needs-human`,附最近 gate 失败摘要与 token 消耗 |
| gate-flapping | 同一 04 gate 在 pass/fail 间交替 ≥ M(默认 3)次(读 gate 历史事件) | 冻结重试 → `needs-human`,附 flapping 报告(gate 名、交替序列) |
| ci-flake | 同一 head SHA 的同名 check 先红后绿(check run id 变、SHA 不变) | 触发 rerun(`gh run rerun --failed`),**不计入 attempts**,flake 计数 +1 入 telemetry |
| conflict-on-rebase | `gh pr view --json mergeable` = `CONFLICTING`,或 rebase 非零退出且含冲突标记 | 首次:steer agent 做 rebase + 解决冲突;二次失败 → `needs-human` |

检测逻辑全部只依赖 state 文件 + `gh`/`git` 只读命令,不侵入 agent 会话内部。

### 指标与计费

设计的目的即度量,统一走 `session-telemetry/record`(原则 5),事件:

- `issue-pilot/state-transition`:`{issue, from, to, attempt, elapsedMs}`
- `issue-pilot/gate-failure`:`{issue, gateKind, attempt}` —— gate 失败分布
- `issue-pilot/budget`:`{issue, tokensUsed, tokenLimit, outcome}` —— per-issue 成本
- `issue-pilot/landed`:`{issue, pr, leadTimeMs}` —— landed-PR 吞吐

`/issue-pilot report` 从 state 目录 + telemetry 聚合:7d 窗口 landed PR 数、p50/p90
time-to-merge、per-merged-PR token 成本、gate-failure 分布、`needs-human` 率。
对照组即 Symphony 报告的吞吐指标——本插件把该对照度量变成常驻输出而非一次性报告。

## 里程碑切分

**M1 — 状态机 + poller + 手动 spawn(不自动开 PR)**
state store(原子写 + schema)+ `gh issue list` poller(kill-switch、并发帽)+
`/issue-pilot run <n>`:单发 spawn 一个 cwd 为主仓库的隔离会话(尚未挂 worktree/04/05),
会话 goal 为渲染后的 WORKFLOW.md 正文;`ctx.jobs` 包装驱动循环;状态到 `running` 即停,
PR/CI 流程不做。单测:状态机合法迁移、原子写并发、kill-switch 生效、poller 对账。
**验证**:造一个带 `pilot:queued` 的测试 issue,`/issue-pilot status` 呈现
`discovered→queued→running`,会话确实收到渲染正文(读其 session 首条 user 消息)。

**M2 — worktree 隔离 + 依赖引导 + 04/05 组合 + PR/CI 回流 + telemetry**
per-issue `git worktree add` + bootstrapScript 执行 & 失败归类;`setup` 挂 05 init、
04 done.gates、01 工具限定; PR 检测、`awaiting-ci → in-review` 迁移、CI 红 → steer 回流、
merge 观测 → `merged` + label 轮换;四类 telemetry 事件落 waterfall。
**验证**:在本仓一个沙盒 issue 上端到端跑出 PR(checks 绿则到 `in-review`);
gate 失败注入(改坏一个测试)确认 steer 回流消息带 `[issue-pilot:...]` 前缀且会话续修;
`pnpm test` 全绿。

**M3 — 评审回流 + 护栏 + 报表 + 失败分类学覆盖**
评论增量注入;token 预算超限 → dispose + `needs-human`;退避重试 + maxAttempts;
重启 reconciler(`resume` 或回 `queued`);`/issue-pilot report` + `gc`;
失败分类学四行各有针对性测试(构造 fake `gh` 输出的可注入 mock seam)。
文档(README + 毕业标准一节)。
**验证**:四类失败各行至少一个测试断言「检测信号 → 恢复动作」;报告命令输出含
7d landed/gate 分布/needs-human 率三项;模拟重启后 reconciler 恢复 running 会话(no-op 即失败)。

## 验证计划

- 纯单测层:状态机迁移表、frontmatter schema 校验、cursor 增量逻辑、退避计算——
  `gh`/`git` 全部经注入的 `ctx.shell` mock(spec 里的 command 字符串断言)。
- 集成层(真仓真 `gh` 指向沙盒 repo):M1/M2 的端到端脚本,断言 label 轮换与 PR 落地。
- 组合验证(00-overview 原则 6:门禁全绿):`pnpm new:plugin control-plane issue-pilot`
  脚手架后 typecheck/lint/test 全绿。
- 度量验证:跑通 M2 后人工核对 `/issue-pilot report` 三项指标与手工记账一致。

## 风险与开放问题

- R1 **`ctx.jobs` 进程内契约**:重启丢 live job,reconciler 依赖 session persistence 才可
  `resume`;无 persistence 的组合下 `running` 中断只能重新 spawn——M2 前需确认目标部署组合
  挂载了 `session-persistence-*`(检查:组合 profile 的 plugins 列表)。
- R2 **无人值守会话的权限面**:pilot 创建 top-level 会话,不经 subagent delegated-policy
  自动钉 `approval 'never'`;若部署组合默认 ASK,会话会卡死在无人理会的 approval 上。
  开放:在 `setup` 内是否需要显式 `approval/policy` 注入(检查:`dsh-approval` 的会话级
  policy 写入 API,类似 `sandbox/mode` 的 `effectiveSandboxMode` 机制)。
- R3 **timer 服务的组合挂载**:`ctx.interval` 来自 vendored `timer`(`vendor/timer`),
  需确认宿主组合已注册该 service,否则插件需自带 `ctx.plugin(TimerService)`(检查:
  目标 profile 的 cordis.yml 是否含 timer)。
- R4 **client-runner 有独立 timer mixin**(`extensions/cordis-client-runner/src/client/timer.ts`),
  插件若运行在 extension 侧需确认拿到的是哪一份;M1 用真组合起 30s interval 冒烟即可排雷。
- R5 **预算计数的口径**:per-issue token 数依赖 telemetry 会话快照字段(读哪些字段
  待 M2 定:检查 `session-telemetry` record schema 的 token 字段名),若粒度不足则退化为
  wallClock + round 计数近似。
- R6 **kill-switch 为自行发明**(上游无先例):语义为「存在即拒新工作,在跑的会话跑完
  当前 gate 校验后自然停」;不做强制 kill(强制 kill = dispose 各 handle,列为 `/issue-pilot stop` 单独命令,不在文件语义内)。
- R7 **01/04/05 规范文档未落盘**(design 目录当前仅 00-overview 与本篇):本设计对
  gate kinds / long-run init / manifest 分类的引用,以各自文档落地时的 API 为准校准。
