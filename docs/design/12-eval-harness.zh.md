# 12 eval-harness — harness 演化的信用纪律

> 状态: design (not started) | Tier: 3 | 包: packages/eval/eval-harness + scripts/bench/ | 依赖: 03, 11 的事件 schema

## 动机(Rethinking 的 67.4<72.3 警示: 没有纪律的演化是 search-budget 自欺欺人)

本仓库的全部工作项 (docs 01–13) 都在演化同一个 harness: 01/02/03 立验证栈、04/05/06 驱动长程任务、07/08/09 治理——每个插件都是一个"harness patch"。这个仓库自己的论点(观测驱动的 harness 演化)必须向内兑现: 没有信用纪律,这些演化只是 search-budget 的自我感动。

Rethinking Harness Evolution 的结论刻在这里:

- harness 演化**本质是一种 search**。在相同 budget 下,budget-matched 对照显示演化**输给** parallel sampling(67.4 < 72.3)和 sequential refinement(75.8/86.2 vs 84.3/91.8)——也就是说,一个声称"演化有效"的补丁,其价值可能只是多花的 token,单纯并行采样就赢过它。
- 无纪律时 held-out transfer 坍塌到 +0.6 pass@1——诊断集上拟合出来的 harness 增益,在未见任务上几乎不剩。

GSME 给出了修复这套信用问题的规程:proposer 读 failure trace、标注病理、写候选 patch;**credit 不靠手感判定,而是三道确定性门**——validity(重跑 + 基建损伤检查)、activation(patch 真的被触发了)、significance(配对试验 2σ);最优 harness **只在 sealed test 上评估一次**,sealed 集永不被诊断/选父/早停所用;被接受的 patch 按 (where × why) 病理归档,不按任务归档——这样拿下 86–147% 的 held-out retention。

Demystifying Evals 补齐工程面:task/trial/grader/transcript/outcome 五个对象分层清晰;grader 分 L1 outcome / L2 process / L3 model-graded / L4 human;**harness config 必须录制进 transcript 本身**,否则跨模型/跨 harness 的比较把 model 差异和 scaffolding 差异混在一起——这正是本仓库每次插件改动后最容易犯的错。AHE/observability-driven optimization 与 APEX 多层共演化是过程度量的背景动机,不展开。

## 现状与缺口

已验证(上游 dsh 仓库 `/deepseek-harness`):

- 有 headless one-shot runner(`dsh --profile headless "task"`)与 llm-replay / llm-mock-server / agent-loop-testkit 测试基建(见"表面与接缝")。
- `BENCHMARK.md` 只有 3 行: 指向 Python SDK 指南 + `jsonrpc-agent/minimal.py`,要求"separate workspaces and session IDs"。**它没有定义任何 task 格式**——所以本文对齐它的执行面(SDK + 独立 workspace/session),不自造一套与之平行的任务概念;这本身不构成缺口的借口。
- 本仓库有 vitest + presubmit 门禁 + pnpm 脚手架,`scripts/` 下是 node ESM 脚本约定。

缺口: (a) 没有 task registry 与 trial transcript 规范化层——session.jsonl 是运行工件,不是评测工件;(b) 没有 budget-matched 比较机制,任何"插件 X 提升了效果"的论断目前都无法复核;(c) 没有 train/held-out/sealed 划分与封存;(d) 没有被接受 patch 的病理归档。docs 03(trace 合规指标)与 11(silent-failure 旗标)将给出 L2 过程度量的 schema,本文按它们的消费方写接缝(着陆前跑降级模式)。

范围诚实: 本文**不是**通用 benchmark 套件。它是本仓库演化信用的铁轨(rail)。L3(model-graded rubric)与 L4(人工)grader 可选、默认缺席。明确不做: 新建公开 benchmark、多仓库通用评测框架、模型横评门户。

## 设计

### 表面与接缝(verified + cited)

| 接缝 | 已验证事实 | 引用 |
|---|---|---|
| Trial 驱动 A(SDK) | `DeepSeekHarness(provider, model, max_tokens, cwd, session_root, cordis=Path)`;`.run(prompt, session_id=…)` 返回 `{final_response}`;session 目录落 JSONL(含模型请求与工具调用) | `deepseek-harness/examples/jsonrpc-agent/minimal.py`、`docs/user/guide/python-sdk.md` |
| Trial 驱动 B(headless) | `dsh --profile headless "task"` 一次性跑完;stdout = 最后一条非空 assistant 文本;exit 0 ⟺ 末次 `turn/end` 完成,否则 1;terminal error 的 code+message 走 stderr;不开监听端口 | `packages/bundle/headless/README.md` |
| 打补丁挂载(变体切换) | launcher 语法 `dsh --profile <p> --patch <path.yml> [args]`;`--patch` 重复可传、值必须是路径;层序 = bundle layers → user layer → `--patch` overlays;cordis.yml 行格式 `- id/name/inject/config`,支持 `!!js` 与 `insert:` | `apps/cli/src/args.ts`(:58–68)、`apps/cli/README.md`(:37)、`packages/bundle/headless/cordis.patch.yml` |
| Session 持久化 | `@deepseek-ai/dsh-session-persistence-jsonl`,`config.root` 必填(常配 `$DSH_SESSION_ROOT`);布局 `<root>/<project>/<session-id>/session.jsonl[.zstd]`;`compression: 'none'` 得纯行可读 jsonl;无删除 API,文件只增 | `packages/session/session-persistence-jsonl/README.md` |
| 事件订阅 | `session/event`(cordis 事件,`ctx.on('session/event', (session, event) => …)`)实测挂上(schedule/llm-retry);`session-telemetry/record` waterfall(`ctx.waterfall('session-telemetry/record', record, () => record)`) | `packages/schedule/schedule/tests/runtime.spec.ts`、`packages/session/session-telemetry/src/coordinator.ts:214` |
| 确定性重放 | llm-replay: fixture 即录制版 `session.jsonl`(`assistant/chunk` 按 (turn,step) 重组;头行 `id`/`createdAt`);config `file`/`overrideFile`/`childFiles`/`providers`/`paceMs`(或 `$DSH_SNAPSHOT_FILE`);按 header `createdAt` 排序后**按首调顺序绑定** live session;`assertConsumed()` 收尾校验脚本用尽;throw/cancel/hang 用 `replay.override.json` sidecar | `packages/test-support/llm-replay/README.md` |
| 本仓脚手架 | `pnpm new:plugin <group> <name>` → `@jianxx/dsh-incubation-<name>` at `packages/<group>/<name>`;门禁: typecheck、vitest、check:exports、check:spec-deps | `scripts/create-plugin.mjs`、根 `package.json` |

**插件 vs 脚本的边界**(60% tooling / 40% discipline):插件只承担一件运行时工作——trial transcript exporter;其余全部落在 `scripts/bench/*.mjs` + 根级 `bench/` 数据目录(registry/trials/variants/archive/results 均非发布工件,不进 packages/)。

### 数据模型 / 配置

`bench/trials/<task>/<variant>/<run>.jsonl` — trial transcript。头行(对齐 llm-replay 的 line-0 头惯例,Demystifying 的"config 入 transcript"要求):

```jsonc
// line 0 — fingerprint(后续行为规范化事件)
{"id":"<trialId>","task":"<taskId>","variant":"<variantId>","run":3,"createdAt":"…",
 "fingerprint":{"repoHead":"<git sha>","plugins":[{"name":"@jianxx/dsh-incubation-trace-contracts","version":"0.1.0","configHash":"…"}],
  "settingsHash":"sha256:…","model":"deepseek-v4-pro","seed":null,"temperature":0.0,"patchFiles":["bench/variants/trace-on.cordis.patch.yml"]},
 "budget":{"maxTurns":40,"maxTokens":200000,"maxWallSeconds":1200}}
```

`bench/tasks/{train,heldout,sealed}/<id>.yml` — task registry:

```yaml
id: fix-failing-tests-01
prompt: "Inspect the repository and fix the failing tests."
setup: {fixture: fixtures/repo-a.tgz, workspace: per-trial}       # runner 解包到独立 workspace
graders:
  l1: {kind: command, run: "pnpm --dir {workspace} test", expect: {exit: 0}}
  l2: [trace-compliance.no-undeclared-tool, silent-failure.no-swallowed-error]  # 引用 doc 03/11 指标 id
  l3: null                                                        # 可选 model-graded rubric
budget: {maxTurns: 40, maxTokens: 200000, maxWallSeconds: 1200}
```

`bench/variants/<id>.yml` — harness 变体描述:`{id, parent, patch(指向 cordis patch yml), status: baseline|candidate|accepted|archived, pathology?: {where, why}}`。基线(`parallel-sampling`、`sequential-refinement`)与插件变体用同一格式声明。

### 关键行为流(run→score→propose→三道 credit 门→sealed 一次→archive)

1. **run**(`scripts/bench/run.mjs`,伪代码):载入 matrix(task × variant × {seed,temp});`budgetMatched = min over variants(task.budget)`→**先**把该任务所有变体的 cap 下调至 min,再开跑。每 trial:解 fixture 到独立 workspace → 置 `DSH_SESSION_ROOT` + `compression: 'none'` → SDK 或 headless+`--patch` 启动 → runner 监听 trial 进程,超 turn/wall cap 即 SIGTERM(记 `outcome: budget-exhausted`)。drain 后,exporter(插件态内联于 session/event;兜底为 harvest 持久化 session.jsonl)写 `bench/trials/…`。`deterministic: true` 且变体本身无并发 subagent 时,首轮同时录制 fixture,后续对照经 llm-replay 重放。

2. **score**(`scripts/bench/score.mjs`):per-variant pass@k + cost(tokens/wall)+ L2 过程指标(消费 03/11 旗标,未着陆时跳过并标 `l2: unavailable`)。配对显著性: 按 (task, seed/temp, budget) 对齐 trial,McNemar 式计 discordant 对 b/c,exact binomial → 判 2σ。报告模板末尾**强制**附纪律 checklist(见下节)。

3. **三道 credit 门**(GSME,全部确定性、跑干前不得人工豁免):
   - validity: 候选变体重跑 N 次,transcript 全部 schema-valid、无 crash、无基建损伤(session/event 序列完整、`turn/end` 闭合;基建损伤含 fixture 泄漏、workspace 越界写)。
   - activation: 候选 patch 声明的插件在所诊断的失败 trial 上**真的被触发**——以插件归因 telemetry(`session-telemetry/record` 中带插件 attribution 的记录)或 03/11 旗标的翻转为准;零触发 ⟹ 直接拒。
   - significance: 相对 baseline(parent variant)在 budget-matched 配对上达标 2σ。

4. **sealed 一次**:被 selection 阶段(held-out 上)选出的最优变体,**只**在 sealed 集上评估一次;结果落 `bench/sealed-results/`,不再回流任何诊断/选父/早停。

5. **archive**:接受门全过的变体进 `bench/archive/<where>__<why>/<slug>/`——病理 keyed by (where × why),不是 keyed by task。每条含:patch diff(cordis overlay)、motivating failure trace 路径、三门 gate 的量化结果、lineage(parent id)。GSME 的 quality-diversity map 的微缩版。

### 纪律协议与机械守卫

协议文本(本节的"协议"段落即执行文档,人读了能跑、机器能查):

- **预算匹配是一等不变量**:同任务下任何 comparison,双方 transcript 的 effective budget 差 > 0 即拒绝出分(score.mjs 直接 exit 1)。cap 在进入 trial **前**统一下调至 min(budget caps 不得事后折算)。Rethinking 的对照组(`parallel-sampling`、`sequential-refinement`)作为可运行的 baseline variant 常驻 registry——任何候选必须先证明"不是 search-budget 伪影"。
- **split 三分**:`bench/tasks/train/`(诊断)、`heldout/`(selection)、`sealed/`(终评)。sealed 目录 hash-locked: 仓内提交 `bench/sealed.lock`(每文件 sha256 + 总合 hash);`scripts/bench/check-sealed.mjs` 挂进 presubmit——(a) sealed 下任何文件改动而未白名单标记 `sealed-rotate` ⟹ fail;(b) `bench/results/`、`bench/archive/` 任一工件引用 sealed task id 或 sealed trace ⟹ fail;(c) `bench/sealed-results/` 只接受带 `sealed-run` 标记的提交且单任务单文件 ⟹ fail 否则。
- **报告 checklist**(score.mjs 模板尾部,缺项即红):`budgets matched? ✓ / baseline included? ✓ / held-out used for selection? ✓ / sealed intact (lock verified)? ✓ / transcript fingerprint recorded? ✓`。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 标准)

**M1: transcript exporter + task schema + 3 个种子任务 + 文档协议。**
`pnpm new:plugin eval eval-harness` 起骨架;订阅 `session/event` 写规范化 trial.jsonl(头行 fingerprint:插件集+版本+settings hash+model+时间戳);`bench/tasks/train/` 下 3 个种子任务(单工具修复类,含 L1 command grader + budget);`docs/design` 本节纪律协议成文。
验证: vitest 单测覆盖 fingerprint 稳定性与事件规范化;一次真实 SDK trial 产出 schema-valid transcript(手工 smoke,命令入 README)。

**M2: runner + 预算匹配强制 + 基线 comparator 配置 + paired-significance 报告。**
`scripts/bench/run.mjs` + `score.mjs`;budget-min 下调与差异拒绝;`parallel-sampling`/`sequential-refinement` 两个 baseline variant 可跑;McNemar + 2σ 门;报告模板带 checklist。
验证: 用 llm-replay fixture 构端到端 fake 评测,断言——budget 不匹配的 comparison 被拒、checklist 缺项变红、配对显著性在构造数据上数值正确。

**M3: sealed 锁 CI + archive + 一次真实的 docs 01–06 插件对照评测作为 dogfood。**
`check-sealed.mjs` 入 presubmit;archive 目录与写入器落地;选 01/03 中一个已着陆插件跑完整流程(propose→三门→held-out selection→sealed 一次),把 gate 数字写进 archive 首条记录。
验证: presubmit 对人为破坏 sealed 锁的分支 fail;dogfood 报告的 checklist 全绿且 sealed-results 只出现一次。

## 验证计划

- 单测(vitest,挂根 `pnpm test`):exporter 规范化(事件→行)、fingerprint(同配置同 hash、异插件异 hash)、McNemar/2σ 数值、budget 匹配拒绝、sealed 锁三种 fail 路径。plugins 测试遵守 check-spec-deps(import 必须自声明)。
- 集成(replay 态):用录制好的 session.jsonl fixture + llm-replay 跑确定性 trial→score 全链;`assertConsumed()` 语义沿用。
- 活体 smoke(SDK 态):`DeepSeekHarness` + 独立 `session_root` 跑一个种子任务,核对 transcript 头行与持久化 session.jsonl 互证。
- 流程 dogfood:M3 的 01–06 插件对照即行为验证——其产物(report + archive entry)本身要被 deep-reasoner 评审"结论是否被纪律约束"。

## 风险与开放问题

1. **token 记账粒度**:trial 预算的 token 数来自 `assistant/chunk` 的 usage 字段与 `compaction/summary` 记录的 usage(llm-replay README 提到 "the recorded usage when present"),但**逐 turn 的确切字段名未在本文核实**。M1 开工前检查:上游 session jsonl 事件 schema 文档 + doc 03 落地稿;若逐事件缺失 usage,降级为 walltime+turn 双帽并在 transcript 标 `tokenBudget: unavailable`。
2. **headless 无可验证的 max-turns/max-tokens flag**(README 未列)。M2 的 cap 执行依赖 runner 侧 SIGTERM(wall/turn 计数来自 `session/event` 的 `turn/end`)。检查: `grep -rn "maxTurn\|maxToken" packages/bundle/headless/src` + agent loop 的核心配置;若核心已有限额配置,改为配置注入优先、kill 兜底。
3. **SDK/headless 双驱动的一致性**:两驱动 prompt 组合不同(SDK 走 `agent-spine` demo 组合,headless 走 bundle patch),fingerprint 必须含驱动 id,跨驱动 comparison 默认禁止(score 拒绝),除非显式声明。
4. **沙箱强度**:`minimal.cordis.yml` 示例是 `sandbox-policy: danger-full-access`。bench trial 的 setup 可能写仓库——runner 必须用独立临时 workspace(worktree/解包),并在 validity 门检查越界写。
5. **上游版本钉住**:trial 依赖上游 dsh 树。仓内应提交 `bench/upstream.lock`(commit sha + 安装方式说明);CI/live 评测对 lock 不一致报警。确切形式在 M1 定稿前与现有 profile 同步脚本对齐(检查 `scripts/sync-local-profile.sh` 的现有约定)。
6. **并发 subagent 的重放**:llm-replay 按首调顺序绑定,声明了 sequential-delegation 假设(其 Known Limitations)。含并发 subagent 的变体(如 06 issue-pilot 的多分支)不可确定性重放——这类变体只能活体跑,fingerprint 标 `deterministic: false`。
7. **03/11 schema 未着陆**:docs/design 当前仅有 00-overview。exporter 先跑降级模式(`l2: unavailable`),指标 id 引用以 03/11 成文为准;若其 schema 与本文假设不符,以 03/11 为准改接缝,不反向约束。
