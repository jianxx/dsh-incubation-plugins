# Incubation design specs — index

设计来源:agent runtime/harness 领域的文献综合(《Agent Runtime and Harness Systems: From Session Scripts to Agent-Native Serving Plane》)
对 `deepseek-harness`(dsh 核心)+ `dsh-cc-plugins`(CC parity 插件集)的缺口分析,经独立评审修订。
每篇文档对应一个孵化工作项,按实现粒度切分为 PR 级里程碑。编号即构建顺序。

## 分析框架(三把尺子)

1. **三层验证栈**(不可互相替代):trace property → action gate → claim contract
   (AgentLTL / Reason-Less-Verify-More / Prompts-to-Contracts、Forethought、EG-VAR)
2. **三层状态恢复**:事件流可恢复 → 执行环境可恢复 → 目标验证 gate
   (CRAB / Goal-Autopilot / GODR)
3. **HarnessScaling 六维** R/M/C/S/O/G + skill/tool 工件生命周期
   (SkillOpt → Dynamic Agent Skills 八段)

## 现状已覆盖(不再重复建设)

三态权限引擎(cc-plugins permission-rules)、tool-search 懒加载、worktree 隔离、
subagent fork、coordinator 委托模式、CLAUDE.md 式记忆 + consolidation、microcompaction、
CC hook 桥、会话持久化/fork/resume。

## 明确不做(上游核心或服务面)

CRAB 式 OS checkpoint(sandbox 内部)、PatchOptic authority triple(运行时准入代数)、
KV 复用/投机解码/WorkflowCompile(serving plane)、TUI、自动更新、多用户协作。

## 共享设计原则(所有工作项遵守)

1. **ASK 走 `approval/request` waterfall**,不自造确认通道;不依赖 dsh-cc-plugins
   (跨仓库只做运行时可选集成,编译期零依赖)。
2. **turn 终止干预 = steer-back 续轮,不是 veto**:`agent/turn-stopping` 在自然完成时
   串行触发,插件通过注入带插件归因的 user 消息续轮;抛异常会把 STALL 变成 crash,
   listener 必须永不 throw。steer 消息参与 round 记账 — 归因标记必须做好。
3. **执行强度做可调配置**(SafetySentry 连续谱):每个 gate 类插件都提供
   `off / audit / enforce` 三档,ASK 阈值可配,不写死策略。
4. **tool-manifest 是共享基座**:副作用分类、幂等配方、外泄分类、验证探针等
   per-tool 元数据只允许一种注解机制(doc 01)。
5. **观测统一走 `session-telemetry/record` waterfall + session/event 流**,
   事件 schema 在所有插件间一致(见 doc 12 的 eval 导出 schema)。
6. **里程碑 = PR 粒度**:每个 M 独立可合入、带验证标准;
   `pnpm new:plugin <group> <name>` 脚手架生成骨架,门禁必须全绿。

## 工作项总表

| # | 文档 | Tier | 包 | 依赖 | 文献锚点 |
|---|------|------|-----|------|---------|
| 01 | [tool-manifest](01-tool-manifest.md) | 1(基座) | verification/tool-manifest | — | Verified Tool Calls, TokenWall, 三层栈横切 |
| 02 | [claim-contracts](02-claim-contracts.md) | 1 | verification/claim-contracts | 01 | Prompts-to-Contracts, Forethought, EG-VAR |
| 03 | [trace-contracts](03-trace-contracts.md) | 1 | verification/trace-contracts | — | AgentLTL, Reason-Less-Verify-More, ToolFailBench, SafetySentry |
| 04 | [goal-verify-gate](04-goal-verify-gate.md) | 1 | goals/goal-verify-gate | — | Goal-Autopilot, GODR |
| 05 | [long-run-protocol](05-long-run-protocol.md) | 1 | session/long-run-protocol | (04 可选) | Effective Harnesses, Harness Design |
| 06 | [issue-pilot](06-issue-pilot.md) | 1 | control-plane/issue-pilot | 04, 05, 01 | Symphony, SwarmResearch(分支隔离) |
| 07 | [rules-lifecycle](07-rules-lifecycle.md) | 2 | memory/rules-lifecycle | — | Self-Improving Coding Agents, AMV-L, MemCon |
| 08 | [skill-lifecycle](08-skill-lifecycle.md) | 2 | skills/skill-lifecycle | — | Dynamic Agent Skills 八段, Progressive Crystallization, SkillOpt |
| 09 | [token-wall](09-token-wall.md) | 2 | security/token-wall | 01 | TokenWall, Semantic Gateway, compositional-harm |
| 10 | [verified-tools](10-verified-tools.md) | 3 | verification/verified-tools | 01 | Verified Tool Calls (2608.02645) |
| 11 | [silent-failure-watch](11-silent-failure-watch.md) | 3 | observability/silent-failure-watch | — | When Errors Become Narratives, ToolFailBench, OAT, AgentCheck |
| 12 | [eval-harness](12-eval-harness.md) | 3 | eval/eval-harness | 03, 11 | GSME, Rethinking Harness Evolution, Demystifying Evals |
| 13 | [subagent-context-scope](13-subagent-context-scope.md) | 3(spike 先行) | agents/subagent-context-scope | — | PerspectiveGap, PatchOptic(projected read) |
| 14 | [science-agent-overview](14-science-agent-overview.md) | —(总纲,不占构建位) | — | — | Scientific Research Agents 综合(63 来源) |
| 15 | [literature-evidence](15-literature-evidence.md) | 2 | science/literature-evidence | 01 | EMBL AI Librarian, Auditing RAG Hypotheses |
| 16 | [analysis-workbench](16-analysis-workbench.md) | 2 | science/analysis-workbench | 01, 17 | Prompt-to-Paper(canonical results.json) |
| 17 | [run-provenance](17-run-provenance.md) | 2 | science/run-provenance | 01;集成 03/04 | HEP(hash-chained log), 统一 provenance contract 缺口 |
| 18 | [hpc-runner](18-hpc-runner.md) | 2 | science/hpc-runner | 01, 17 | 量子传感(18.9 h 长任务), 科研软件 HPC 需求清单 |
| 19 | [evidence-registry](19-evidence-registry.md) | 3 | science/evidence-registry | 01, 02 | Danus(verifier-gated fact graph), HEP |
| 20 | [citation-verify](20-citation-verify.md) | 3 | science/citation-verify | 01, 15 | Cited but Not Verified(三层归因) |
| 21 | [domain-pack](21-domain-pack.md) | 3 | science/domain-pack | 01, 05, 08 | Vibe-FDTR(消融 98.9%→36.7%), TRACE |
| 22 | [breeding-genomics-toolkit](22-breeding-genomics-toolkit.md) | 3 | breeding/genomics-toolkit | 21, 16, 18, 10 | Vibe-FDTR(领域封装), Prompt-to-Paper |
| 23 | [breeding-data-adapters](23-breeding-data-adapters.md) | 3 | breeding/data-adapters | 21 | SciHorizon-DataEVA(数据就绪) |

## 构建顺序与合并策略

```text
01 ──► 02 ─┐
01 ──► 03 ─┼─► 06(压测 04/05)
04 ──► 05 ─┘
01 ──► 10 ;01 ──► 09
07 ;08 ;11 独立  →  12 依赖 03/11 的事件 schema
13 先做 M0 spike,可行性报告决定是否立项
15/17 ──► 16 ;17 ──► 18
01 ──► 19 ──► 20
01/05/08 ──► 21 ──► 22,23
```

14 为总纲不占构建位。

- **第一波**(立起三层验证栈):01 → 02 + 03 → 04
- **第二波**(端到端压测):05 → 06(issue-pilot 真实驱动 04/05)
- **第三波**(治理与安全):07, 08, 09 并行
- **第四波**(纵深):10, 11, 12;13 看 spike 结论
- **科研 W1**(分析与谱系底座):15 – 18(15/17 先行,详见 [14 号总纲](14-science-agent-overview.md))
- **科研 W2**(证据治理与领域落地):19 – 23;更远的 W3 roadmap 仅列出不立项

## 毕业标准(incubation → dsh-cc-plugins 或上游)

一个孵化包满足以下条件即提名毕业:(a) 三连门禁全绿 ≥ 2 周;
(b) 有真实 profile 在用(非仅测试);(c) 遥测指标证明价值(如误拦率、
premature-completion 拦截次数);(d) README 的 graduation criteria 一节全部勾掉。
