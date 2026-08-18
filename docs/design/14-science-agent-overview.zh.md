# 14 science-agent-overview — 基于 dsh 构建科研工作流 agent 的总纲(工作项 15–23)

> 状态: design (not started) | 性质: 总纲(不占构建位) | 覆盖工作项: 15–23 | 共享基座: [01 tool-manifest](01-tool-manifest.zh.md) | 验收主场: breeding-ai-workspace `projects/genomic-selection`

本文档不是插件实现文档:它定义"在 dsh 之上构建科学研究 agent"这一工作包
(work items 15–23)的动机、阶段映射、单元切分、共享专则与整体验收口径。
各单元的表面细节(工具签名、schema、事件)由各自立项文档给出,本文只钉
单元间的边界与契约归属。

## 设计目标与用户问题

**目标**:把 dsh 从通用编码 harness 扩展为科研工作流 harness——文献证据、
分析执行、运行谱系、HPC 后端、引用归因、领域包六块短板各由一个孵化工作项
补齐,并在 breeding-ai-workspace 的基因组选择项目上完成端到端验收。

**用户问题**:今天一个育种(或其他 wet-lab / dry-lab 混合)团队想拿 dsh 做
科研,会遇到一连串同一根源的不便:让 agent 查文献,它只有通用 web 搜索,
检索记录不可复放;让 agent 跑 GBLUP,代码在 `run_code` 里算完即弃,结果没
有机器可读契约、链不上谱系;想把任务提交到集群,没有 HPC 后端;想让
goal gate 验收"分析完成",gate 拿不到任何可引用的运行证据;想注入领域知识,
唯一手段是把方法学写进提示词——恰恰是文献里消融掉就崩盘的那一层
(Vibe-FDTR,见下)。这些不是十个独立痛点,而是同一缺口的不同表面:
**dsh 没有科研工件的一等对象**(论文、数据集、假设、run、证据、引用关系)。

## 动机(为什么必要)

三层材料支撑本工作包的立项,分别回答"为什么 dsh 可以长出来""为什么必须
长出来""长出来后第一块田在哪"。

**① dsh 主仓能力面广,但对科研工作流存在系统性空白。** 已逐一核实的现成面:
cordis 插件/服务机制与 `ctx.tools` 工具运行时(`deepseek-harness/packages/core/
tools/src/index.ts`,接缝行号见 [01](01-tool-manifest.zh.md) 已核实清单);
code-mode `run_code` 传输(`packages/core/tools/src/code-mode.ts:20`,
`RUN_CODE_NAME = 'run_code'`);后台作业 `job_output/job_list/job_kill`
(`packages/jobs/tool-jobs/src/index.ts:303/343/363`);定时提醒
`schedule_create/list/delete`(`packages/schedule/schedule/src/tools.ts:318/400/420`);
`subagent` 与 `workflow` 编排(`packages/subagent/tool-subagent/src/index.ts:22`、
`packages/workflow/tool-workflow/src/index.ts:29`);goal 账本 `create_goal/
update_goal`(`packages/goal/tool-goal/src/index.ts:208/235`);CLAUDE.md 式记忆
+ consolidation(`packages/memory/{memory,memory-consolidation}` 包,00 概述列为
已覆盖);MCP client(`packages/mcp/mcp-client/src/index.ts:28`,stdio 与
streamable HTTP 两种 transport)。但同一棵 `packages/` 树下:无学术检索面、
无实验/运行谱系面、无 HPC/批后端、无 notebook 面、无 MCP **server**
(`packages/mcp/` 仅 `mcp-client` + `mcp-config`)、无浏览器自动化包
(顶层 `ls packages | grep -i 'browser|playwright|notebook|jupyter|hpc|slurm'`
零命中,已核)。空白是系统性的:整条 artifact→evidence→review→discovery
链路无一等承载。

**② 文献证据:科研 agent 的分界线已是"证据构建工作流"。** 综合页
`/Users/bytedance/workspace/llm-wiki/wiki/syntheses/scientific-research-agents.md`
(479 行、整合 63 来源,已核)的整合判断(:170):系统分界线不是"能不能搜
文献",而是**能否把 institution policy、research question、hypothesis、dataset、
paper、claim、evidence span、tool output 与 verifier 组织成可操作、可重放的
research artifact graph**。逐项与本工作包对应的锚点:

- *检索层做成 agent-facing 知识层即可换回跨任务增益* — EMBL AI Librarian
  把自然语言问题规划成 fielded subqueries 打 Europe PMC,拆段 BM25 + 句级
  证据抽取;LitQA2 上 GPT-5.4 从参数记忆 17.6 提升到 78.9(配 web search 70.3),
  ScholarQA-Bench Bio/Neu Citation F1 73.8/79.4 vs BM25 67.0/68.5(:216/:453)。
- *封装后领域代码 + 过程化知识是可靠证据执行的前提* — Vibe-FDTR 两级
  benchmark 成功率 100% / 98.9%;移除过程化 skills 的 code-agent 降到
  91.4% / **36.7%**,两者皆缺的 agent-only 为 38.6% / 0%,且较 code-agent 降
  本 87.7%、提速逾 60%(:212/:452)。这是专则 d(领域知识必须机器可读)
  的直接依据。
- *citation UX 不是 evidence verification* — Cited but Not Verified 把
  attribution 拆成 Link Works / Relevant Content / Fact Check 三层,显示
  factual support 远弱于表层引用质量(:184/:362)→ 工作项 20。
- *事实准入需要单一权威* — Danus 的 stateless verifier 是事实准入的唯一权威,
  fact-graph memory 保存 proof 与 dependency,支持错误事实的依赖撤销(:286)
  → 工作项 19。
- *长任务在真实实验现场成立* — 量子传感 NV 色心实验一次自主运行 18.9 h,
  含操作者未显式要求的 CPMG 追加实验(synthesis:304;源页
  `wiki/sources/arxiv-2607.25145-*.md:88`,均已核);分工结论"agent 负责假设
  与量化证据解释,确定性代码负责控制与安全"→ 工作项 18 的后端姿态。
- *规范证据 ID + 生成即门控* — Auditing RAG Hypotheses 以 `obs:/jump:/lit:/
  path:` 稳定证据 ID 组装 prompt,V1 引用有效性门在 136 条假设上报零无效
  引用(:208)→ 15/20 的证据 ID 方案。
- *写好 vs 重跑出更强证据必须被系统区分* — Prompt-to-Paper 把统计检验与图
  收敛为 canonical `results.json`,八维 scorer + hallucination penalty(:202/
  :380)→ 工作项 16 的结果契约。
- *统一 provenance contract 仍缺失* — meta 问题一(:347):"跨系统仍没有
  统一 schema 来表达 claim、evidence span、review note、simulation result 与
  verifier output" → 工作项 17 的立项理由。

**③ 育种工作区实证:文献层成熟,计算层/数据层空白。** 
`/Users/bytedance/workspace/github.com/breeding-ai-workspace`(已核):全局
`skills/` 下 paper-scan / paper-ingest / paper-deep-read / wiki-query /
innovation-scan 等文献面 skills 在册(`registry.yml`);而首个示例项目
`projects/genomic-selection/` 的 README 自述"结构占位,内容待团队按需填充"——
九面骨架(七槽契约 spec §4.4 + `rules.yml`/`knowledge/`/`memory-log/` 扩展)
全部目录仅含 `.gitkeep`。即:该工作区已经把"读论文、问 wiki"做到了可用,
而"处理基因型数据、跑 GBLUP、留谱系"连骨架内容都没有。14–23 的验收主场
正是这块空地。

## 现状与缺口

按科研工作流清点,dsh 现状可复用的与缺口如下(复用面引用见上节①;孵化仓
侧 01–13 提供的基座见 [00](00-overview.zh.md) 总表):

- **可复用**:run_code 即时代码执行;jobs/schedule 的后台与定时面;
  subagent/workflow/goal 的编排与目标账本;memory 面;mcp-client 可作
  外部工具接入;01 tool-manifest 的 per-tool 元数据注册表;03/04 的
  trace/goal 门。
- **缺口 G1 学术检索与证据装配**:无 Europe PMC/学术库 connector、无证据
  span 对象、无定时文献 watch → 15。
- **缺口 G2 分析执行面**:run_code 每次冷启动、无持久内核、无绘图面、无
  机器可读 results 契约 → 16。
- **缺口 G3 运行谱系**:每次计算run无统一 record(数据版本/参数/代码版本/
  环境/产物哈希),goal gate 拿不出证据指针 → 17。
- **缺口 G4 计算后端**:无 HPC/批提交、无计算级断点续跑,18.9 h 级任务在
  会话内承载不动 → 18。
- **缺口 G5 假设/证据图谱**:无假设一等对象、无事实准入权威 → 19。
- **缺口 G6 引用归因**:citation-looking output 无三层归因门 → 20。
- **缺口 G7 领域知识形态**:无"机器可读配置 + preflight"的领域包规范,
  提示词灌注是已知反模式 → 21。
- **缺口 G8/G9 领域落地**:基因组学工具封装(VCF/GWAS/GS)与公共数据源
  适配(NCBI/Ensembl 等)均无 → 22/23。

## 设计

### 表面与接缝(verified + cited)

总纲自身不新增接缝;15–23 复用的 dsh 面已全部核实并注出行号(见动机①)。
各单元文档落地时按 01 的行号级纪律重新核实自己消费的接缝。新接缝集中于三处:
15 引入外部学术 API(纯 egress,见专则 a);17 引入 run record 存储面
(本地 append-only,03/04 的集成点);18 引入提交器后端抽象(本地 executor
为 reference 实现,HPC adapter 后置)。除标注的集成点外,全部包编译期
零依赖 dsh-cc-plugins,遵守 00 共享原则 1/4/6。

### 八阶段工作流 → dsh 能力映射矩阵

本表是 14–23 的总图;阶段划分沿用综合页附录 A 的速查骨架。

| 阶段 | 文献锚点 | dsh 现状 | 新工作项 |
|---|---|---|---|
| 数据就绪 | SciHorizon-DataEVA(criteria 执行 + 自纠) | 通用 fs/shell;无领域数据契约与 QC 面 | 23(经 21 preflight 表达就绪判据) |
| 文献证据 | EMBL AI Librarian;SLR screening κ=0.52–0.77(纳排门需审计) | web_search 通用搜索;无学术库、无证据装配、无 watch | 15 |
| 假设形成 | ECLAIR(假设结构化可审计);HEP(registry + `P(H)`);Auditing RAG(稳定证据 ID) | 无假设/证据一等对象 | 19 |
| 实验执行 | Vibe-FDTR(封装 + 配置 preflight);量子传感(18.9 h;确定性代码控制) | run_code/bash/jobs 通用执行;无 HPC 后端、无计算级断点 | 18(本地 executor 先行) |
| 数据分析 | Prompt-to-Paper(canonical `results.json`) | run_code 冷启动;无持久内核与结果契约 | 16 |
| 写作报告 | Prompt-to-Paper(八维 scorer + hallucination penalty) | 无 | W3 `science-report`,本期不立项 |
| 评审验证 | Cited but Not Verified(Link/Relevant/Fact 三层) | 02 claim-contracts 通用声明校验;无引用归因门 | 20 |
| 发现闭环 | Danus(verifier-gated fact graph);OpenProver(机器可检查验收) | 04 goal-verify-gate 无实验证据指针 | 19 + 20;04 挂 17 的 run 证据 |

### 工作项单元矩阵

| # | 名字 | 包 | 依赖 | 波次 |
|---|------|-----|------|------|
| 15 | [literature-evidence](15-literature-evidence.zh.md) | science/literature-evidence | 01 | W1 |
| 16 | [analysis-workbench](16-analysis-workbench.zh.md) | science/analysis-workbench | 01, 17 | W1 |
| 17 | [run-provenance](17-run-provenance.zh.md) | science/run-provenance | 01;集成 03/04 | W1 |
| 18 | [hpc-runner](18-hpc-runner.zh.md) | science/hpc-runner | 01, 17 | W1 |
| 19 | [evidence-registry](19-evidence-registry.zh.md) | science/evidence-registry | 01, 02 | W2 |
| 20 | [citation-verify](20-citation-verify.zh.md) | science/citation-verify | 01, 15 | W2 |
| 21 | [domain-pack](21-domain-pack.zh.md) | science/domain-pack | 01, 05, 08 | W2 |
| 22 | [breeding-genomics-toolkit](22-breeding-genomics-toolkit.zh.md) | breeding/genomics-toolkit | 21, 16, 18, 10 | W2 |
| 23 | [breeding-data-adapters](23-breeding-data-adapters.zh.md) | breeding/data-adapters | 21 | W2 |

(各链接目标随立项陆续补齐;链接存在性由 `pnpm check:spec-deps` 与 00 总表
行同步约束。)

### 数据模型 / 配置

总纲只钉两个跨单元按手法,字段细节归各单元文档:

- **run record(17 所有,04/16/18/22 消费)**:每次受谱系管理的计算 run 一条
  append-only 记录,至少含数据版本指针、参数、代码版本、环境指纹、产物哈希
  与 verifier 输出;04 goal-verify-gate 的 complete 可挂"run 证据指针"
  (专则 b)。schema 与 03 trace 事件的对齐边界是 17 的开放问题(见风险)。
- **manifest 标注约定(01 扩注,不写第二份清单)**:15/22/23 引入的全部外部
  学术 API 工具在 01 tool-manifest 注册 `effectClass: 'readonly'` +
  egress 标注 read-only(GET-only,禁 POST/PUT)(专则 a);16 的内核/绘图
  工具按实际副作用分级;18 的提交器默认 `side-effecting` +
  `timeout-ambiguous`(与 01 内置清单对 `jobs` 的分级同源)。
- **gate 三档统一**:20 归因门、21 preflight 均提供 `off / audit / enforce`,
  遵守 00 原则 3。

### 关键行为流

- **文献闭环流(15 → 20)**:`schedule_create` 定时触发 watch → 候选队列 →
  摄入(全文/摘要 + 元数据)→ 证据装配(稳定证据 ID)→ 写报告或答问时
  每条引用经 20 的三层归因门(Link/Relevant/Fact)过门 → 装配与归因结果
  进 17 谱系。
- **计算谱系流(16/18/22 共走)**:preflight(21)→ 提交(本地 executor 或
  HPC adapter)→ 17 开 run record → 执行(16 持久内核;18 断点续跑)→
  canonical `results.json` + 图 → record 闭环 → 04 gate 以 run 指针验收。
- **领域注入流(21)**:domain-pack = 机器可读配置(数据契约/QC 判据/默认
  管线参数)+ 过程化 skills + 工具清单条目;加载即 preflight 校验范围,
  不通过即拒绝进入执行段——替代提示词灌注。

### 共享设计原则(科研专则)

00 的 6 条共享原则对本包全部有效;以下为科研场景新增四条:

- **a. 外部学术 API 一律 GET-only**,在 01 tool-manifest 标注 egress=read-only;
  需要写入的外部系统(投稿、注释库)一律不进本工作包。
- **b. 实证证据的统一载体是 17 的 run record**;04 的 complete、16 的
  results.json、22 的育种值报告都必须能挂 run 证据指针,无指针的产物不进入
  gate 语汇。
- **c. claim 强度 ↔ verifier 强度分级**(批注 / 规则 / 执行复核 / 领域审计 /
  形式验证五级)经 manifest + 20 归因门表达;各级 gate 保持 off/audit/enforce
  三档;"discovery 级 claim 必须配可执行或机器可检查 verifier"写入 19/20 的
  enforce 档默认。
- **d. 领域知识一律以 21 domain-pack 形态注入**(机器可读配置 + preflight),
  纯提示词灌注领域知识为本包明确的反模式——Vibe-FDTR 消融(98.9%→36.7%)
  即该反模式的量化代价。

## 里程碑切分

总纲自身无代码里程碑;切分即波次。

- **W1(分析与谱系底座,15–18)**:15/17 先行,16 依赖 01+17,18 依赖 01+17;
  四者并行面大,但 16/18 的统一证据出口必须是 17,不许先长私有记录面。
  出口判据:genomic-selection MVP 流(见验证计划)能跑通。
- **W2(证据治理与领域落地,19–23)**:19 → 20;21 → 22,23。
  出口判据:文献闭环流在 enforce 档过门;基因组选择端到端(数据适配 →
  QC → GBLUP → 交叉验证 → 报告引用全过归因门)。
- **W3 roadmap(仅列出,不立项;触发即按 00 流程单独立项)**:
  - `science-report`:当 16 的 `results.json` 契约在一个真实项目上稳定 ≥ 2 周,
    且 20 归因门在 enforce 档运行有遥测。
  - `debate-orchestration`:当 19 证据图谱内出现真实的 verifier 对同一 claim
    分歧案例(多解释竞争),需要对抗编排来裁决。
  - `mcp-server`:当出现把 15/17/19 的面对外暴露给其他 agent/工具消费的具体
    需求(dsh 侧仅有 mcp-client 的今天,反向供给才能确定 server 形态)。
  - `breeding/field-data`:当 genomic-selection MVP 验收通过且田间数据采集
    流程(仪器/表格规范)由团队确定。

## 验证计划

总纲的验证 = **整体验收**(叠加在各单元 DoD 之上):

1. **项目级 MVP 验收(真机手动项)**:在 breeding-ai-workspace 的
   `projects/genomic-selection` 七槽骨架中,从小数据集 QC → GBLUP → 交叉验证,
   产出符合 16 契约的 `results.json`;全程 run 处于 17 谱系之下,04
   goal-verify-gate 的 complete 引用 run 证据指针。
2. **文献闭环验收**:15 的定时 watch 产出候选队列 → 摄入 → 证据装配 →
   20 citation-verify 过门;归因失败产出可读三层报告(Link/Relevant/Fact),
   enforce 档拦截一个构造的"链接可达但事实不支持"用例。
3. **单元验收口径**:每个单元的验收 = 各自文档"单元验收(DoD)"一节全部勾选;
   总纲不替代单元 DoD。
4. **自动化门禁**:进仓必过 husky pre-commit(已核 `.husky/pre-commit`):
   `pnpm check:spec-deps` / `pnpm typecheck` / `pnpm test` /
   `pnpm check:subagent-paste` 四连全绿。

## 风险与开放问题

- **HPC 站点异构**:Slurm/PBS/云批的认证、配额、容器策略未逐一核实;18 以
  本地 executor 为 reference 实现,HPC adapter 立项时需真实集群账目先行。
- **学术 API 配额与 ToS**:Europe PMC、NCBI E-utilities 等各有速率与使用条款,
  15 需 per-source 限速与缓存策略;离线 fixture 是测试默认。
- **17 与 03 的事件 schema 边界**:run record 与 trace 事件的重叠(都描述
  "一次执行")需在 17 立项时对齐 03 的 schema,避免双写双漂。
- **domain-pack 配置面膨胀**:配置 schema 有演化成"第二套规则语言"的风险
  (同 01 对内容级 glob 的顾虑);21 需显式划定"配置管什么、skill 管什么"。
- **湿实验闭环不在本期**:量子传感式"确定性代码控制硬件"超出了 14–23 范围;
  18 只做计算后端,不接仪器。
- **数据许可**:育种基因型/表型数据的权限与隐私边界由 data-adapters(23)
  的 manifest 标注兜底,但具体数据源的许可审查是流程问题,非本包所能闭合。
