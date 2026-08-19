# 24 memory-bench-pack — 记忆评测包(扩展 12 的 milestone 族;记忆波次入口门)

> 状态: design (not started) | Tier: 3(bench pack,归属 12 的 milestone 族扩展,不独立建包)| 依赖: 12(eval-harness,硬依赖——rail/三道 credit 门/sealed 纪律全部复用)| 波次: 记忆波次(25–29)的**入口门**——任何记忆插件在本包报出基线数字之前不得提毕业
> 锚点: StratMem-Bench (2604.26243) / Stored Evidence & Pass@B-P90R (2605.07313) / Veracium (2607.21962) / MemLeak / Setoka / PM-Bench (2607.12385) / Memory Characterization (2606.06448)
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:在 12 的评测 rail 上加装四个度量族的任务包,把"记忆"从单一提升数字拆成
可分别证伪的三级——**存下了吗(availability)→ 召回了吗(recall)→ 用对了吗(use)**——
再加老化、删除泄漏与规模条件三个轴;并在此定义全记忆波次(25–29)共用的
`memory.*` 遥测键约定,后续文档只引用不重造。
**用户问题**:今天没有任何东西把"记忆写进了文件"和"下次真的被想起来并用对了"
区分开。一个记忆插件可以声称"改进了记忆",但没有基线、没有分级的计数器,这个
声称是不可证伪的;更糟的是,fresh-fixture 评测(干净环境跑一轮)会系统性高估
记忆系统——Veracium 的 tenure-crossover 表明 curated-memory 在长使用周期上会退化,
fresh fixture 恰好测不到这一点。本包就是那道门:**记忆插件先过秤,再谈毕业**。

## 动机

- **综述论点(C.1 #1,最高严重度)**:现有 harness 的记忆评测几乎全部把
  "stored" 当 "used"——写入了 memdir 就算成功。StrMem-Bench 把评测拆成存储、
  检索、利用三段分别计分,正是本包第一个度量族的直接出处。
- **Veracium (2607.21962)**:tenure-crossover——curated-memory(人工/半自动维护的
  干净索引)系统在 ~9 周量级的使用周期上被 provenance-rich(带出处、可追溯原文)
  系统反超;fresh-fixture 短周期评测会给出与长期使用**相反**的结论。
  注意标注:其 96→72% vs 90% 的对比数字来自**单一平台的用户研究**,
  不作跨平台外推,只作"必须测老化"的动机。
- **Stored Evidence / Pass@B-P90R (2605.07313)**:答案正确不等于证据正确——
  记忆系统的评测必须报告"引用了记忆里的哪条、该条是否真的支持结论",
  且在记忆体量增长时报告 P90 延迟/成本劣化(P90R),而不是只报均值 pass@k。
- **MemLeak**:删除泄漏——用户删除的记忆事实不得再以任何形式(直接注入、
  索引残留、consolidation 转述)浮出。这是隐私/合规硬门,却几乎没有 harness
  评测覆盖它;本包把它做成一个确定性探针。
- **Setoka**:answer-rate ≠ accuracy——模型"回答了"不等于"答对了",
  记忆评测的 grader 必须区分拒答/错答/借旧记忆幻觉答,本包 grader 词汇按此三分。
- **PM-Bench (2607.12385)**:prospective scoring——不该只测"过去的事记得吗",
  还要测"将来要做的事(意图)记得吗"。本包 M3 留 intent-set 槽位,
  正式消费方是 doc 28(前瞻记忆),此处只落任务与键。
- **Memory Characterization (2606.06448)**:记忆的构建成本与新鲜度是第一等
  度量——construction 侧能耗可在数百次查询内超过 query 侧总能耗。本包要求
  每个被测插件同时报 `memory.construct.tokens`,让"建索引的代价"进同一张表。

**一句话**:12 解决"harness 改动是否可信",24 解决"记忆改动是否可信"——
同一个 rail,四个新度量族,一套共享键。

## 现状与缺口

已核实:

- 12 的 rail 全套在案:budget-match 不变量、GSME 三道 credit 门(validity /
  activation / significance)、train/heldout/sealed 三分、`bench/` 目录布局
  (`bench/trials|tasks|variants|archive|sealed-results`,见 12 §数据模型)。
  本包**不重建任何一块**,只新增任务族与 grader。
- 当前记忆栈:dsh-cc-plugins `memory`(memdir = `MEMORY.md` 索引,≤200 行/25KB,
  topic 文件带 `name/description/type` frontmatter,type ∈ user/feedback/project/
  reference;recall = 每 turn fork 小模型对 frontmatter 侧查后 `agent.inject()`,
  已展示文件去重——`packages/memory/memory/README.md:14-17/:53-55`)+ 
  `memory-consolidation`(turn-stopping → extraction → 带门 dream 重写:
  24h + ≥5 新会话 + 陈旧锁三道门)。这是**基线变体**,不是被替换对象。
- 系统提示注入缝:cc-plugins memory 的 section 走
  `ctx.systemPrompt.section({name, order, text})`
  (`packages/core/system-prompt/src/index.ts:375-392`)——被测插件的注入面
  全部经由既有 section,评测不需要新缝。
- 遥测缝:全部计数走 ops channel
  (`packages/session/session-telemetry/src/index.ts:64-86`,
  record = `{channel:'ops', time, severity, attributes, body}`);自定义 session
  事件类型对下游插件封闭(`packages/core/session/src/known-event-types.ts:7-15`
  头注释:仓外插件事件按构造不在表内;读路径带 `ignorable` 守卫,
  `packages/core/session/src/types.ts:422`)→ **本包不新增任何 session 事件类型**,
  一切度量经 ops channel(与 doc 02/04/05/07 同结论)。

缺口三件:①没有把 availability/recall/use 拆开计数的任务与 grader;
②没有老化(时间×流量)轴——12 的 trial 都是 fresh fixture;③没有删除泄漏
探针与规模条件化报告(Pass@B/P90R)。④没有跨 25–29 的统一 `memory.*` 键约定。

## 设计

### 表面与接缝(verified + cited)

| 接缝 | 用途 | 引用 |
|---|---|---|
| 12 的 runner/score/credit 门/sealed | 全部复用;本包只落 `bench/tasks/mem-*` 任务族 + 新 grader + 计数器挂钩 | 12 §设计 |
| ops 遥测 channel | 所有 `memory.*` 计数从这里出;`ctx.get('sessionTelemetry')` 判空后使用 | `packages/session/session-telemetry/src/index.ts:64-86`;先例 `packages/session/session-telemetry/src/index.ts:43/:104` |
| 系统提示 section(被测面) | 被测记忆插件的注入入口;评测只读装配结果,不改缝 | `packages/core/system-prompt/src/index.ts:375-392` |
| `agent.inject()`(被测面) | cc-plugins memory 的召回注入路径;评测经 trial transcript 观测其 `source.kind==='plugin'` 归因,不拦截 | `packages/core/agent/src/runtime-types.ts:135-143` |
| 会话历史检索(老化轴的夹具来源) | 用 `session_search` 等工具语义约束任务设计;真实驱动走 12 的 SDK/headless 双轨 | `packages/session-query/tool-session-query/src/index.ts:67-117` |
| 设置面 | 任务包自身旋钮(family on/off、bucket 边界)走 settings 命名空间:`installSettingsSection`(`packages/settings/settings/src/index.ts:863`),layers = schema 默认 → cordis base → `settings.yaml`,`settings/updated` 热更新,`ctx.settings.describe()` 运行时读取;注册即暴露(#2404) | 同左 |

### `memory.*` 键约定(唯一权威定义,25–29 引用此处)

全部为 ops channel 计数器,`telemetry.op` 属性值即键名,body 携带
`{task, variant, trialId, bucket?, detail?}`:

| 键 | 含义 |
|---|---|
| `memory.availability.stored` | 事实确实落入了该插件声明的持久面(memdir 文件/卡片库) |
| `memory.availability.absent` | 任务植入的事实事后未被找到(存储失败) |
| `memory.recall.hit` / `memory.recall.miss` | 召回路径是否把相关条目带进了 model-facing context(以注入归因/transcript 为证) |
| `memory.use.correct` / `memory.use.wrong` / `memory.use.hallucinated` | 下游答案分别:正确用到该条 / 用错或用旧版 / 引用了不存在或已被删除的条目(Setoka 三分) |
| `memory.leak.delete` | 删除探针中,已删事实再次浮出(直接/索引残留/转述),任何一次即 fail 该 trial |
| `memory.construct.tokens` | 构建侧 token 开销(索引、extraction、consolidation 全计入) |
| `memory.index.stale` / `memory.index.fresh` | 索引新鲜度(卡片/索引落后于事实变更的 trial 计数,25 起用) |
| `memory.aging.crossover` | 老化臂中,某变体在 T+N 相对 T=0 的方向翻转点(报告事件,非计数) |

约定纪律:25–29 各文档**只引用**本表键名,新增键必须先改本表(一个 PR,
仅表格行追加);键名即 op 名,禁止各插件私造同义键。

### 四个度量族(任务包设计)

**族 1 — availability-vs-use 拆分**(StrMem-Bench):任务为多 session 夹具——
session A 植入事实(经真实用户消息,非直接写文件),session B/C 依次提出需要
该事实的任务。三个独立计数:事实在持久面吗(`memory.availability.*`)、
召回路径带它进 context 吗(`memory.recall.*`)、下游用对了吗
(`memory.use.*`)。grader:L1 为确定性 command/model-graded 三分
(correct/wrong/hallucinated,Setoka);L2 检查 recall 证据(注入事件归因)。
**三级可以同 trial 全绿、也可以任意组合分裂——分裂模式本身就是诊断**
(存了没召回 = 检索问题;召回了用错 = 注入质量问题)。

**族 2 — tenure-crossover 老化臂**(Veracium):同一记忆库,在 T=0 建立后,
注入**合成时间与流量**(N 轮带新事实/更新/矛盾的后续 session 夹具,时间戳
前推),在 T=0 / T+N 两点分别测族 1 的三级计数。比较对象:curated 风格
(cc-plugins memory as-is)vs provenance-rich 风格(25 的 episode 卡片,
M0 之后接入)。fresh-fixture 数字只作 T=0 列,永不单独作为结论。
报告必含 `memory.aging.crossover` 事件(若有方向翻转)。

**族 3 — 删除泄漏探针**(MemLeak):session A 植入事实 → 用户显式删除
(走该插件的真实删除命令/文件操作,不走评测后门)→ session B 用三种问法
探测:直接问、问相关联的推理链、问 consolidation 转述面。任一路径浮出
已删事实 ⟹ `memory.leak.delete` + 该 trial fail。确定性 grader
(答案文本含已删事实的规范化形式即命中),不做 model-graded 宽判。

**族 4 — 规模条件化报告**(Stored Evidence):固定任务集,记忆库规模分桶
(如 10 / 100 / 1000 条目,夹具生成),报告 Pass@B(带证据正确率——答案须
引用条目且条目支持结论)与 P90R(P90 召回延迟/token 开销)逐桶展开;
禁用"均值吃掉长尾"。M3 再挂 PM-Bench 式 intent-set(前瞻意图任务:
"下周记得 X"在后续 session 是否兑现),正式消费方是 doc 28——本包只落
任务 schema 与 `memory.recall.hit` 于意图条目的细分(body.bucket='intent')。

**基线优先(硬规则)**:族 1–4 的第一个被测变体是**当前栈原样**
(cc-plugins memory + memory-consolidation,零改动),其数字写入
`bench/archive/` 作为 memory-wave baseline;之后任何记忆插件(25–29)
的对照都以它为 parent variant。没有 baseline 行,12 的 activation 门
对记忆变体直接拒。

### 证伪条件(本包自己的)

本包不只证伪别人,也声明何种结果削弱本波次的前提:

- 若**基线在真实工作负载上 availability ≈ use**(存了就基本能用),
  则 26(写入门)的核心前提——"存储与利用之间存在大裂缝需要门控"——被削弱;
  届时 26 降级为 audit-only 起步,而非默认 enforce 语义。
- 若族 2 显示 T=0 与 T+N 无显著差异(在测试的 N 范围内),
  则 Veracium 的 tenure-crossover 对本栈不成立,25 的 provenance-rich 卡片
  设计失去主要动机之一——25 的 M0 spike 判据相应收窄。
- 若族 3 在基线上零泄漏且 25 之后仍零泄漏,删除探针降级为回归守卫
  (每 release 跑一次),不占常驻评测预算。

## 里程碑切分(每个 M = 一个 PR 粒度,扩展 12 的族)

**M0: 基线——族 1 任务 + 三级计数器 + 当前栈首跑。**
`bench/tasks/mem-avail/`(train/heldout 各若干,sealed 留空待 M3);
`memory.availability|recall|use` 三族计数器挂 ops channel;score.mjs 报告
新增三级分列;**当前栈(cc-plugins memory + consolidation as-is)完成首跑**,
数字进 archive 作 memory-wave baseline。
验证:合成 trial 上三级计数可分裂控制(构造只存不用/只用不存两类夹具,
计数器分别只亮对应级);基线报告 checklist 全绿(12 的五项)。

**M1: 老化臂(族 2)。** 合成时间/流量注入夹具生成器(时间戳前推 +
N 轮后续 session);T=0/T=N 双点采样协议;`memory.aging.crossover` 事件;
基线 + (若已到)25 spike 变体的首张对比表。
验证:同库双点重跑 5 次,翻转判定稳定(不因采样抖动翻转);
fresh-fixture 列在报告中永不单独成段(模板守卫)。

**M2: 删除泄漏探针(族 3)。** 删除夹具三问法;确定性 grader;
`memory.leak.delete`;基线与(届时)25 各跑一遍。
验证:人工在删除后从 memdir 侧注入残留,探针必命中(负例构造);
真实删除路径零误报。

**M3: Pass@B/P90R 分桶 + intent-set 槽位(族 4,服务 28)。**
规模桶夹具生成器;证据 grader(答案引用 + 条目支持性,与 02 的 claim
检查器词汇对齐,对齐失败则 L1 降级 command-only);sealed 集首次填充
(一次性,走 12 的 sealed.lock 流程);PM-Bench 式 intent 任务 schema。
验证:分桶报告 P90 单列;sealed 锁 CI 三条 fail 路径(12 M3 已建)对新任务
族生效;intent 任务 grader 与 28 的判据文档互引一致。

**门语言(写进 12 的 archive 准入)**:记忆类变体(25–29)提毕业/进
candidate 状态时,archive 条目必须附:四级计数(基线 + 自身)、老化臂双点
数字、删除探针结果、construct.tokens 对账。缺任一 ⟹ 12 的 credit 门按
activation 不通过处理。

## 验证计划

1. 计数器单测:三级分裂控制、删除命中/误报、crossover 稳定性。
2. grader 单测:Setoka 三分在构造答案上的精确率;证据 grader 与 02 词汇
   对齐测试(不对齐时降级路径)。
3. 夹具确定性:族 2 生成器同 seed 同输出(hash 锁);族 4 桶边界稳定。
4. 流程 dogfood:M0 基线报告 + M3 sealed 首跑,评审结论同 12
   (deep-reasoner 核"结论是否被纪律约束")。

## 风险与开放问题

1. **recall 判定的观测面**:cc-plugins memory 的 recall 是 fork 小模型侧查 +
   `agent.inject()`,注入消息带 `source.kind==='plugin'` 归因,但"带进来的
   条目是否即目标事实"需要比对注入文本与 memdir 条目——匹配规则(精确/模糊)
   未定,且 fork 侧查本身可能不落 session 事件。开放:M1 前核实 cc-plugins
   memory 的注入是否一律经 `agent.inject()`(是则 transcript 可判),若存在
   system-prompt 直拼路径,recall 判定需增加 section 渲染 diff 面比对。
2. **合成老化的生态效度**:时间戳前推 + 流量注入能否逼近真实 9 周退化
   (Veracium 是真实用户研究)未证。缓释:crossover 只作方向性判据,
   不作数值外推;并在报告标注 synthetic-aging。
3. **intent-set 与 28 的判据耦合**:PM-Bench 消费方是 28,其 grader 若依赖
   28 尚未落地的机制,则 M3 只能交付 schema + 占位 grader。开放:与 28
   文档对表后再定 M3 范围。
4. **construct.tokens 的记账边界**:consolidation 的 dream 重写在独立 LLM 调用
   中发生,其 usage 是否可靠出现在 session 事件里未逐字段核实(12 风险 1
   同源)。若缺,fallback 为 wall-clock + 事件计数代理,报告标注。
5. **sealed 集的"新鲜"悖论**:记忆任务天然多 session、有状态,sealed 任务
   复跑即污染记忆库。方案:sealed 记忆任务强制 per-trial 独立 workspace +
   独立 session_root(12 已有 per-trial workspace 惯例),但"库内老化后测
   sealed"不可能——sealed 只覆盖 T=0 面。接受并写入报告模板限制栏。

## 边界

- **与 12**:本包是 12 的 milestone 族扩展(标题即"bench pack extending 12"),
  不独立建包、不建第二套 rail;12 的 budget-match、三道 credit 门、sealed
  纪律对本包全部生效,本包只加任务族、grader、`memory.*` 键约定与记忆类
  变体的额外门语言。
- **与 25–29**:各记忆插件的遥测键与证伪线**统一引用本文的键约定与基线数字**;
  它们的 milestone 验证若含"在 24 的 rail 上报数",指本包 M0 起的基线对照。
- **与 28**:intent-set 在此落任务与键,prospective scoring 的完整判据归 28。
- **与 02**:族 4 的证据 grader 词汇与 02 的 claim 检查器对齐(可选集成,
  02 不在场降级)。

## Out of scope

- 建一套面向其他仓库/其他 agent harness 的通用记忆 benchmark 套件
  (本包只在 12 的 rail 上服务本仓插件)。
- KV/缓存层的记忆评测(serving plane,见 00 排除项)。
- 真实人类长期使用研究(Veracium 式 tenure 研究是用户研究,本包只做
  合成老化近似)。
