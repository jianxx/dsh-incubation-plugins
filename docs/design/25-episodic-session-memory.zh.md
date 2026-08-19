# 25 episodic-session-memory — 跨会话情景记忆(记忆波次首建)

> 状态: design (not started;M0 为 spike,go/no-go 见里程碑) | Tier: 2 | 包: packages/memory/episodic-session-memory | 依赖: 无硬依赖(运行时可选集成:24 的度量 rail、07 的规则晋升、08 的技能候选、05 的 progress.md 数据源、10 的探针)
> 锚点: HLTM (2604.26197) / E-mem (2601.21714) / InMind (C.1 #13) / Selective Persistent Memory (2607.09493) / Memory Characterization (2606.06448);风险面: C.1 #9(跨会话 ROI 未验证——由 24 回答)
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:从历史会话中派生**情景卡片(episode card)**——带目标、结局、关键决策、
错误与修复、出处引用的可引用记忆单元——经"常驻/可召回"两级驻留策略注入,
并提供失败情景 → 候选规则(07)/候选技能(08)的晋升桥。唯一持久存储是派生
卡片;对原始事件日志的访问一律经上游 session-query 面。
**用户问题**:每个会话都从零开始。上周花三小时定位的那个构建失败(症状、
错误路径、最终修复、为什么其他办法不行)本周要重新推导一遍——因为现有
curated topic 记忆(memory 的 memdir)只存**事实**("该仓库用 pnpm"),
不存**带因果上下文的情节**(那次失败是怎么诊断、怎么修的)。

## 动机

- **HLTM (2604.26197)**:记忆分层(情景 → 摘要 → 语义)在生产规模上的验证,
  本波次唯一 production-scale 出身;情景层是源头,摘要/语义层由其派生。
  本设计只做情景层,派生规则留给 consolidation 波次。
- **E-mem (2601.21714)**:情景记忆的生成/更新/检索三段生命周期管理,
  卡片字段(goal/outcome/errors+fixes)的直接参照。
- **InMind (C.1 #13)**:in-context 常驻 84.0% vs 检索式 ≤14.4%——病灶不在
  embedding 规模,而在**驻留策略**:被召回的记忆永远输给常驻的记忆。
  本设计因此把 resident(常驻)/retrievable(可召回)作为卡片一等属性,
  而不是把全部筹码押在检索质量上。标注:该数字为单一平台研究,作方向不作数值。
- **Selective Persistent Memory (2607.09493)**:只持久化 schema-worthy 的内容;
  单一平台局限同样标注。
- **Memory Characterization (2606.06448)**:construction 能耗可在数百次查询内
  超过 query 能耗——索引器必须有界增量、成本记账、新鲜度可见。
- **C.1 #9(显式风险)**:跨会话记忆的 ROI 至今未在真实负载上验证——
  这正是 24 的存在理由;本插件的 M0 spike 即以 24 的族 1 任务为判据,
  没有提升即止步于 spike。

**dsh 现状**:上游已有 caller-workspace 的历史会话检索面(session-query 四工具 +
sqlite 后端,base 已挂载)与 opt-in 的跨会话快照(session-reference);
cc-plugins memory 提供事实级 curated 记忆。缺的是:情节级派生卡片、
带出处的记忆工件 schema、驻留策略、以及情节 → 规则/技能的晋升通道。

## 现状与缺口

已核实:

- **历史会话检索面( ingestion 的正门)**:`session_search`(在 caller workspace
  搜**先前会话**,每会话返回最强匹配事件)、`session_event_search`(单个授权
  会话内搜先前事件)、`session_trace`(会话血缘,完整祖先/后代关系)、
  `session_event_read`(读单个完整事件及邻域摘要)——注册于
  `packages/session-query/tool-session-query/src/index.ts:67-117`(另有
  `session_event_trace` :97,事件替换/引用关系)。
- **sqlite 后端已挂载**:`session-query-sqlite` 在 base 组合
  (`packages/bundle/base/cordis.patch.yml:117`)与 web-app(:30)均注入——
  读路径生产可用,无需自建索引基建。
- **跨会话快照(opt-in)**:`context/session-reference` 提供有界只读的其他会话
  快照作为 sourced model-facing context,消费 `ctx.sessionQuery`,
  不需要 SQLite FTS(`packages/context/session-reference/README.md`)。
- **系统提示缝**:`ctx.systemPrompt.section({name, order, text})` 返回精确
  disposer,同名 scoped 覆盖 global(`packages/core/system-prompt/src/index.ts:375-392`)。
- **注入缝**:`agent.inject()` 排队下一个 pre-step 的 model-facing context、
  不唤醒 driver(`packages/core/agent/src/runtime-types.ts:135-143`);
  归因纪律照 doc 05(source `{kind:'plugin', plugin:'episodic-session-memory'}`)。
- **turn-stopping(晋升桥候选触发点)**:serial、自然收尾才触发
  (`packages/core/agent/src/runtime-types.ts:272-278`);listener 永不 throw。
- **遥测**:全部走 ops channel
  (`packages/session/session-telemetry/src/index.ts:64-86`);自定义 session
  事件类型对下游插件封闭(`packages/core/session/src/known-event-types.ts:7-15`)
  → 不新增 session 事件。
- **定时基建**:`ctx.interval`/`ctx.timeout` 自动 dispose
  (`vendor/timer/src/index.ts:4-15`);`ctx.jobs` 仅进程内
  (jobs/README,非持久调度器——未逐行核,列为假设 A1);schedule 三工具
  (`schedule_create/list/delete`)是持久**提醒**记录而非调度器
  (`packages/schedule/schedule/src/types.ts:52-74`)→ 后台重索引**不依赖**
  schedule,进程内存活期间做,冷启动补账。

缺口:①情景卡片工件与 schema;②派生管线(哪轮触发、何时成卡);③
驻留策略与注入路径;④progress.md(05)到卡片的摄取;⑤情节→规则/技能
晋升桥;⑥索引成本记账。

## 设计

### 摄取纪律(硬约束,先行声明)

**对先前会话的一切读取经上游 session-query 面**——即 `session_search` /
`session_event_search` / `session_trace` / `session_event_read` 工具语义,及已挂载的
`session-query-sqlite` store 读路径(或 opt-in 的 session-reference 快照)。
**禁止**在本插件内对原始事件日志建立第二套私有索引(私有 FTS、私有嵌入库、
私有 JSONL 重放目录)。**唯一持久存储是派生出的情景卡片**(带引用,指回
session id + seq 区间)。理由:与 01 的 tool-manifest 唯一注解机制同一原则——
底座(substrate)只有一份;私有索引会在格式演进(如 zstd 压缩、事件 schema
演进)时静默腐烂,而卡片是对日志的**引用视图**,日志重读永远走上游读路径,
上游演进自动跟随。卡片不是事件日志的拷贝——是带出处的结论。

### 记录封套 v1

> 本节标题冻结("记录封套 v1";英译 "Record envelope v1");doc 26/27 交叉引用
> 时写作"25 §记录封套 v1"。字段只增不删;语义变更须开 v2 并保留 v1 读兼容。

所有本波次记忆工件(情景卡片,及 26/27 引用本封套的工件)共享的顶层信封:

```jsonc
{
  "type": "episode",                  // 类型标签:episode(本插件)| 预留 26/27 工件类型
  "schema": "memory-envelope/v1",     // 封套版本
  "id": "ep_01J…",                    // 工件 id(ULID)
  "timestamps": { "createdAt": "…", "updatedAt": "…" },
  "sourceSessionIds": ["01J…", "01J…"], // 出处会话(至少一个;可多会话合并)
  "provenance": [                      // 出处引用:回到事件日志的指针,非拷贝
    { "sessionId": "01J…", "fromSeq": 120, "toSeq": 340, "note": "诊断回合" }
  ],
  "confidence": 0.0,                   // 0–1:派生置信(模型自评 + 校验规则)
  "supersededBy": null,                // 被替代时指向新工件 id;非 null 即历史版
  "payload": { … }                     // 类型特定载荷(卡片字段见下节)
}
```

不变式:`supersededBy` 单向(无环);被替代的工件**不删除**(可审计、
可回溯删除请求);`provenance` 里的 seq 区间经 `session_event_read` 必须可还原
出处证据——卡片声称的东西查无实据时,confidence 强制降为 0 并打
`memory.index.stale`(键约定见 24)。

### 数据模型 / 配置(episode card schema, budgets, thresholds)

**情景卡片**(信封 `type:'episode'` 的 payload):

```jsonc
{
  "goal": "修复 CI 上 flaky 的 integration test",
  "outcome": "resolved | abandoned | superseded",   // 结果态
  "keyDecisions": ["放弃 mock 方案,改用 testcontainers(见 seq 210-260)"],
  "errorsAndFixes": [{ "error": "端口竞争 EADDRINUSE", "fix": "动态端口分配" }],
  "tags": ["ci", "flaky-test", "testcontainers"],
  "residency": "resident | retrievable",  // 驻留类别(InMind)
  "staleness": { "sourceAdvanced": true, "lastVerifiedAt": "…" }
}
```

**存储**:`.dsh/episodes/*.json`(每卡一文件,信封 + 载荷;相对 `session.cwd`
解析,可进 git review;原子写 temp+rename,照 07 惯例)。派生数据,
**永不**作为事件 append 进 session log。

**配置声明（rc.7 起）**:本插件旋钮经 settings 命名空间声明(`settingsNamespace`
+ `installSettingsSection`,`packages/settings/settings/src/index.ts:863`):
解析分层 = schema 默认值 → cordis 组合条目(base)→ `settings.yaml` 用户文档;
`settings/updated` 热更新;`ctx.settings.describe()` 运行时读取;注册即暴露
(#2404 后注册是唯一暴露控制点)。

| 键 | 默认 | 含义 |
|---|---|---|
| `mode` | `audit` | `off` / `audit`(只建卡+索引,不注入)/ `full`(注入) |
| `residentBudgetBytes` | 2048 | 常驻卡注入的 UTF-8 字节上限(与 07 的 2KB 同量级) |
| `residentCap` | 3 | 常驻卡片数上限 |
| `recall.trigger` | `per-turn` | `per-turn`(每 turn 侧查)/ `on-uncertainty`(见召回路径) |
| `index.batchMaxSessions` | 20 | 单次增量索引最多处理的会话数(有界增量) |
| `derivation.provider` / `derivation.model` | 必填成对 | 派生用辅助 LLM 路由(session-title-llm 同款成对要求) |

### 驻留策略(InMind:resident vs retrievable)

- **resident(常驻)**:少量(≤`residentCap`)高价值卡片,**每次装配都注入**,
  走自有 systemPrompt section(`name:'episodic-session-memory:resident'`,
  `order: 210`——07 的 rules section(200)之后,与 cc-plugins memory 的
  section 不同名不冲突)。字节硬顶 `residentBudgetBytes`,超顶按置信+新鲜度
  降序截断,尾部注明省略数。
- **retrievable(可召回)**:其余卡片只进召回路径,不常驻。
- **升级/降级**:outcome=resolved 且近端被引用 ≥2 次的卡可升 resident
  (audit 档只提案);`staleness.sourceAdvanced` 的卡自动退出 resident。
- **诚实的边界**:常驻段与 cc-plugins memory 自身的 prompt section、07 的规则
  注入是**并存(pile-up)关系**——上游**没有**跨插件 prompt 预算仲裁器,
  三个来源可以各自吃满各自预算后叠加。本插件不假装解决了这个问题:
  把"总注入字节无仲裁"列为风险 R2,并在遥测 body 记录当轮 resident 段实际
  字节,供 24 的 rail 与后续(若出现)预算仲裁设计消费。

### 召回路径(与 cc-plugins memory 的边界)

- 检索面 = 卡片库自身的轻量索引(tag + goal/outcome 文本,进程内,
  随卡片文件重建——卡片是派生物,索引是缓存的缓存,可丢弃)。
- 注入:`per-turn` 档在每 turn 开始侧查(小模型,照 cc-plugins memory 的
  fork 侧查先例)后 `agent.inject()`,带插件归因
  (`source: {kind:'plugin', plugin:'episodic-session-memory'}`);`on-uncertainty`
  档仅在触发条件命中(如模型显式搜索历史会话、或 uncertainty 信号)时
  召回——省 token,代价是漏召,M0/M2 对比两档。
- **明确边界:本插件不能也不去拦截 cc-plugins memory 的 `inject()`**——它的
  召回是它的;两套注入并存,去重只在本插件自己的"已展示卡片"集合内做
  (照 cc-plugins memory 的已展示文件去重先例)。跨插件去重同样无上游机制,
  归入 R2。
- 预算分层路由草图:recall 侧查先问"resident 里已有吗"(有则不重复召回);
  卡片召回数随当前上下文压力缩放(tokenMeter 面照 05 seam 10 用法,
  可选服务,缺失则固定数)。

### progress.md 摄取(与 05 的关系,不并行双抽)

05 的 `.dsh/longrun/progress.md` 是**任务作用域的一次性工件**(随任务废弃);
情景卡片是**会话作用域的可引用工件**(带 provenance,跨任务存活)。二者
不是竞争抽取:长跑会话收尾(或 progress.md 标记完成)时,progress.md 的
Goal/Done/Blockers/Evidence 是**现成的卡片初稿来源**——派生管线读它 + 用
`session_trace`/`session_event_read` 补 provenance seq 区间,合成一张卡,
不在同一会话里对事件日志做第二遍情节抽取。判词:progress.md 是脚手架,
卡片是建筑。

### 情节 → 规则/技能晋升桥(跨会话 ROI 的兑现口)

失败情景(outcome=abandoned,或 errorsAndFixes 密集)是最高价值的记忆。
里程碑内交付**候选生成**,永不静默生效:

- **→ 07 候选规则**:卡片 errorsAndFixes 呈现"同错 ≥2 次"模式时,生成
  规则草稿进入 07 的 `/rule review` 待审队列(07 的 candidate 状态机、人工
  activate 门、`/rule add` 文件契约照旧——本桥只产出草稿文本与出处)。
- **→ 08 候选技能**:重复出现的 multi-step 解法(keyDecisions 模式)生成
  技能候选进 08 的候选通道,人工审阅。
- **环境验证**:10 的 probes(verified-tools)在场时,晋升草稿附验证状态;
  缺席则标注 unverified(不阻塞人工审阅)。

这条桥是"跨会话 ROI"在 24 rail 上可测的机制:一张卡最终变成一条激活规则
并压低复发(07 的 recurrence 统计),比"注入次数"硬得多。

### 索引器纪律(Characterization 的成本记账)

- **有界增量**:进程内 `ctx.interval` 低频驱动,每轮至多
  `index.batchMaxSessions` 个会话;冷启动补账一次;`ctx.jobs` 仅进程内
  (假设 A1),不做持久后台。
- **成本记账**:派生调用 token 全计入 `memory.construct.tokens`(24 的键);
  卡片 staleness 进 `memory.index.stale/fresh`。若 construct 累计超过召回
  侧查的 token(Characterization 的 crossover),遥测升级 warn——
  这是"这套记忆不值"的机器信号,接 24 的证伪线。

## 里程碑切分

**M0: spike(go/no-go)。** 不建包。用现成 session-query 工具 + 手工/脚本
派生,对**一个真实仓库约 20 个历史会话**做一次性卡片抽取;mini 任务集取
24 族 1 的 heldout 任务(若 24 M0 未完,先以 24 的任务 schema 落 5 个种子);
对比"无记忆"变体跑一轮。
验证判据(硬):派生卡 + resident 注入在 24 的族 1 三级计数上对"无记忆"
有可重复提升(recall 与 use 至少一级、双跑方向一致)。
**证伪线:若无提升,M0 即终点——本插件停留在 spike 报告,不进 M1**;
该结果同时回写 24 的证伪条件栏。

**M1: 卡片派生管线 + 记录封套 v1。** `pnpm new:plugin memory episodic-session-memory`
起骨架;封套 schema + 卡片 payload schema + 原子写;turn 收尾
(`agent/turn-stopping`,listener 永不 throw)触发的增量派生(会话末成卡);
provenance seq 区间经 `session_event_read` 回验;confidence 规则。
验证:合成会话夹具 → 卡片 round-trip;回验失败的卡 confidence 归零 +
stale 计数;listener fault-injection 不杀 turn。

**M2: 召回路径 + 驻留策略。** resident section(order 210,字节硬顶+截断);
per-turn / on-uncertainty 两档;`agent.inject()` 归因;已展示去重;
recall 计数落 `memory.recall.hit/miss`(24 键)。
验证:resident 超顶截断断言;两档召回在 24 rail 的对比首跑;
注入事件 source 断言 `{kind:'plugin', plugin:'episodic-session-memory'}`。

**M3: progress.md 摄取 + 晋升桥。** 05 工件读取(容忍 partial write,
照 05 解析器);长跑会话收尾合成卡;errorsAndFixes → 07 待审草稿、
keyDecisions → 08 候选(只产草稿,人工门在 07/08 命令面);10 在场时附
验证状态。
验证:progress.md 夹具(含截断)→ 卡;草稿进入 07 `/rule review` 队列且
零静默激活;07/08 不在场时降级 warn 不炸。

**M4: 索引器经济学 + 加固。** 有界增量 + 冷启动补账;`memory.construct.tokens`
/ `memory.index.*` 全量记账 + crossover warn;删除路径(卡片删除 =
文件删除 + supersededBy 链保留审计,配合 24 族 3 探针);README 毕业判据。
验证:24 族 2/3/4 全套过一遍(crossover 双点、删除零泄漏、分桶 P90);
construct/检索成本对账报告。

## 验证计划

- 单测:封套 round-trip、provenance 回验、截断、partial progress.md 容忍、
  删除路径。
- 合成会话集成:真实 `session/event` 缝驱动派生触发;注入归因断言;
  turn-stopping fault-injection。
- 24 rail(主判据):M0 go 判据、M2 两档对比、M4 四族全套。
- 真实试用:本仓自身开发会话启用 ≥2 周,观察卡片被引用率与晋升桥产出
  (07/08 队列中的接受比),作为毕业提名证据。

## 风险与开放问题

1. **C.1 #9(显式):跨会话 ROI 未验证**。本插件的存在理由本身是待验命题;
   M0 spike 是第一道闸,24 的基线对照是第二道。若两者皆负,正确动作是
   归档本设计而非加功能。
2. **无跨插件 prompt 预算仲裁**(诚实声明):resident 段与 cc-plugins memory
   section、07 rules 注入叠加,总注入字节可能失控。缓释:自段硬顶 +
   遥测记实测字节 + 等 24 基线给出"注入总量 vs use.correct"曲线后再议
   是否需要仲裁设计(可能是独立工作项)。
3. **派生 LLM 路由**:照 07 风险 3,通用插件取"当前会话路由"的 API 是否
   稳定未确认;fallback 为 `derivation.provider/model` 必填成对
   (session-title-llm 策略)。
4. **假设 A1:`ctx.jobs` 仅进程内**——jobs README 未逐行核;若实际存在持久
   调度,索引器设计不变(有界增量照做),只是冷启动补账逻辑简化。
   检查方法:M1 前读 `packages/jobs/jobs/README.md` 全文。
5. **sqlite 读路径作为插件面的稳定性**:`session-query-sqlite` 已挂载 base,
   但其 store 的**直接程序化读 API**(绕过工具表面)是否属稳定插件面未核。
   检查方法:M0 spike 直接只用工具面(零风险路径);M1 前核实 store 服务键
   与导出面,不可得则全部经工具语义封装的操作层(已在本包 ingest 侧抽象)。
6. **20 会话的代表性**:M0 单仓库样本可能偏置(该仓库恰有丰富的可复用情节)。
   接受:spike 只求"存在性证明"(有一个真实场景受益),推广性由 24 rail 的
   多仓库任务族回答。
7. **隐私面**:卡片跨会话携带用户数据,进 git 的 `.dsh/episodes/` 可能含
   敏感内容。缓释:confidence 门 + 派生 prompt 中的脱敏规则 + 与 09 的
   purpose 标记集成(照 07 风险 2 的外泄分类思路),细则待 09 落地对表。

## 边界

- **与 24**:本插件的一切度量键与证伪判据引用 24 的 `memory.*` 键约定;
  M0 的 go/no-go 即 24 族 1 的对照跑。
- **与 26/27**:它们交叉引用本文"§记录封套 v1";本插件不消费它们的工件,
  但封套字段(sourceSessionIds/provenance/confidence/supersededBy)由它们复用。
- **与 05**:progress.md 是摄取源与脚手架,不是竞争记忆;05 的解析容忍
  规则被复用,不重复实现。
- **与 07/08**:晋升桥只产候选草稿;状态机、人工激活门、复发统计全部在
  07/08 侧,不越权。
- **与 cc-plugins memory**:并存不互读;事实记忆归它,情节记忆归本插件;
  无跨插件去重/预算仲裁(风险 R2)。

## Out of scope

- 摘要/语义层记忆(HLTM 的上两层)——留 consolidation 波次。
- 对原始事件日志的私有索引/嵌入库(明令禁止,见摄取纪律)。
- 跨插件 prompt 预算仲裁器(独立工作项候选,本插件只记遥测)。
- 跨仓库/跨用户共享记忆(团队 overlay 归 cc-plugins memory 的既有语义)。
