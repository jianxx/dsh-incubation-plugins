# 27 memory-maintenance — 记忆养护:陈旧检测、衰减降级、矛盾修复与版本化回收

> 状态: design (not started) | Tier: 3 | 包: packages/memory/memory-maintenance | 依赖: 25(§记录封套 v1,冻结锚点)、26(写入门)、07(复用其生命周期与 consolidation 机制)
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给 memdir 补"养护"半环——陈旧声明检测(死路径/过期版本/失效
URL)、访问频率追踪、衰减→降级队列(人工审批)、矛盾对→修复提案、
superseded-by 版本链与 NL 触发的回滚;机制复用 07 的候选/生效/归档状态机、
有界编辑 consolidation 与人工审批环,不重建。
**用户问题**:记忆单调增长;过时与矛盾的事实静默毒化决策——"构建路径已从
vite 迁到 rsbuild"写入后,旧条目还在,召回时两条一起进 prompt,agent
挑了旧的。今天没有任何机制知道"该删什么、该改什么、错了怎么回退"。

## 动机(文献锚点)

- **Agent Memory ≠ Database**(2605.26252):四类失败——无监管增长、
  缺语义修订、容量驱动的盲目遗忘、查询-召回失配——**直接当作本设计的
  契约清单**:M0 治增长可见性、M1 治遗忘(有据衰减,非盲目)、M2 治
  语义修订(矛盾修复)、M3 治修订历史的可回溯。这四类就是没有养护的
  memdir 的未来。
- **MEMOREPAIR**(2605.07242):barrier-first 级联修复——矛盾集未解前,
  依赖该事实的推理应被屏障标记;完整版需要 provenance 基建,故本包做
  **MEMOREPAIR-lite**(相位化:M2 只做最小 barrier 语义)。
- **MemStrata**:确定性 supersession 层 + bi-temporal 台账——被取代的
  记录不删,挂 superseded-by 链;M3 采用其 supersession 语义(lite 版,
  单时间轴 + 版本号,不做完整 bi-temporal)。
- **OBLIVION**(2604.00131):访问频率衰减——记忆按使用信号退火;
  M0/M1 的频率追踪 + 衰减队列即其确定性实现。
- **Live-Evo**(2602.02369)、**ChronoMem**(2607.27773):自然语言触发的
  回滚("把记忆回到上周三之前")——M3 的 ChronoMem-lite 以 25 的封套
  版本号实现,能力受限见开放问题。
- **Veracium**(2607.21962):单平台用户研究,结论仅作方向参考,原样标注。

## 现状与缺口

硬约束同 doc 26(插件不能包裹插件、无记忆写入瀑布缝;memdir 是普通文件,
文件级读/写/mtime 可用):养护**全部为文件级事后操作**,不存在上游
"删除/修订"事件可订阅;频率追踪只能来自本生态可观察的召回路径
(25 的注入路径;诚实面:cc-plugins 自己的召回注入对第三方不可见,
频率统计只覆盖 25 的注入面,标注为下界)。

07 已提供全部生命周期机制:candidate→active→archived 状态机、
有界编辑 consolidation(`consolidation.maxEditsPerRun`)、人工审批环
(`/rule review`/`activate` 范式)、utility 打分与人工豁免(`pinned`)。
本包**复用而非重建**:抽取候选定位于 07 §"consolidation 流
(SkillOpt/SSCA 维护阶段)"的机制面(状态机、有界编辑、审批环),
**承诺将该机制面抽为共享 lib**——该 lib 尚不存在,抽取是本包 M1 的
前置交付物之一,不是既有事实。

记录 schema 冻结锚点:**25 §记录封套 v1**(provenance、版本、访问计数
字段以 25 为准,本文不重复定义;26 的 rejected-hash 集与门时间戳亦经
封套读取)。

## 设计

### 表面与接缝(verified + cited)

1. **effect-scoped 定时器**:`ctx.interval` / `ctx.timeout`
   (`vendor/timer/src/index.ts:4-22`)—— M0 的频率聚合与陈旧扫描是廉价
   interval job;scope 卸载即停。
2. **进程内后台任务**:`ctx.jobs` in-process 契约
   (`packages/jobs/jobs/README.md:40`)——扫描/配对/提案生成为
   background job;listener 永不 throw(共享原则 2)。
3. **命令面**:`ctx.commands.register({name, description, input, recordInput,
   handler})`(`packages/feedback/command-feedback/src/index.ts:101` 先例)——
   `/mem-maint review|apply|rollback` 人工门;provenance 留痕用
   `recordInput: true`(NL 回滚手势需要输入留痕)。
4. **文件面**:memdir + `.dsh/mem-maintenance/`(队列/台账)走 `ctx.fs`
   原子写;mtime 用于增量扫描。
5. **遥测**:ops-channel `memory.maint.*` 计数器,key 约定归 doc 24,
   本文不重复规定;eval 判据归 12/24。

#### 配置声明（rc.7 起）

> **配置声明（rc.7 起）**：本插件的用户可调旋钮通过 settings 命名空间声明
> （`settingsNamespace` + `installSettingsSection`，
> `packages/settings/settings/src/index.ts:863`）：解析分层为 schema 默认值 →
> cordis 组合条目（base）→ `settings.yaml` 用户文档；支持 `settings/updated`
> 热更新与 `ctx.settings.describe()` 运行时读取。注册即暴露——#2404 移除了
> apiproxy 白名单，注册是唯一的暴露控制点；cordis `apply(ctx, config)`
> 第二参数保留为组合默认值层。

| 键 | 默认 | 含义 |
|---|---|---|
| `maintain.mode` | `off` | 三档:**off=queue-only**(只排队)/**audit=propose**(出修复提案)/ **enforce=auto-apply-trivial**(仅"平凡"提案自动应用:死路径删除、纯 typo;矛盾修复永不自动) |
| `decay.halfLifeDays` | 45 | 访问频率半衰期(OBLIVION 常数) |
| `decay.minAgeDays` | 30 | 降级候选的最低记录年龄 |
| `contradiction.scoreThreshold` | 0.6 | 配对置信阈值(灰带以下不进 M2) |
| `sweep.intervalMinutes` | 60 | 陈旧/频率扫描周期 |

### 关键行为流(相位即硬依赖序)

**M0 — 陈旧声明检测 + 访问频率追踪**
陈旧检测(确定性、零 LLM):memdir 记录中的文件路径→`ctx.fs` 探测死路径;
版本声明→与工作区实际版本(`package.json` 等)比对;URL→HEAD 探测失效。
频率追踪:25 的注入路径每次命中记录访问事件(封套字段),07/26 的门与
consolidation 触点在可用处一并计入;interval job 聚合。输出:陈旧清单 +
频率台账,`memory.maint.stale_found|hit` 计数。诚实声明:**注入侧命中
可见性只覆盖 25 自己的注入路径**,cc-plugins 内部召回不可见,频率是下界。

**M1 — 衰减→降级队列(人工审批)**
候选集 = 低频 ∧ 高龄 ∧ 无矛盾牵连(被 M2 矛盾集引用的记录不参与降级,
同 07"有未解决 recurrence 的规则不参与降级"的保护语义)。候选入
`.dsh/mem-maintenance/queue/`,经共享审批面呈现(07 范式:审批即显式
命令;`approval/request` waterfall 用于 ASK 场景,共享原则 1)。降级 =
archived 态(07 状态机语义),不物理删除;`pinned` 人工豁免同 07。
**前置交付:抽取 07 的状态机/有界编辑/审批环为共享 lib**(见现状节,
是承诺,不是既有)。

**M2 — 矛盾对→MEMOREPAIR-lite 修复提案**
依赖:25 封套积累的 provenance 密度 + 26 的门时间戳(谁先谁后、各自
出处)。矛盾配对(同 topic 断言冲突;置信 < 阈值不进)→ 生成修复提案
(保新废旧/合并改写/标记不确定三选一,LLM 起草、机检有界编辑数上限,
07 consolidation 的机检范式)。**最小 barrier 语义**:矛盾集未解决期间,
依赖该事实集的记录渲染时附 caveat 标记("存在未解决矛盾,见 /mem-maint
review"),不阻断召回。应用必须人工(enforce 档也不放宽,明说)。

**M3 — superseded-by 链 + ChronoMem-lite NL 回滚**
修复/改写产生 superseded-by 链(MemStrata lite:单时间轴 + 封套版本号,
不删历史);NL 回滚 = `/mem-maint rollback <NL 时间/条件>` 按封套版本
序列把受影响记录回退(ChronoMem-lite:只回退本包台账覆盖的版本,
25 封套之前的写入不在台账内,能力边界如实呈现)。

## 里程碑切分

- **M0: 陈旧检测 + 频率台账**
  三类确定性陈旧探针、25 注入路径命中计数、interval job、遥测。
  验证:fixture memdir(死路径/旧版本/失效 URL 各正反例)检出快照;
  频率聚合单测;interval dispose。
- **M1: 共享 lib 抽取 + 衰减降级队列(人工审批)**
  07 机制面抽 lib(本包首用户)、衰减打分、候选队列、审批命令、pinned。
  验证:候选集三条件合成测试(任一条件不满足不入队);审批前零生效;
  lib 抽取后 07 回归绿(不破坏既有)。
- **M2: 矛盾对 + 修复提案 + caveat barrier**
  配对器、LLM 提案 + 机检、caveat 渲染、人工应用。验证:矛盾 fixture
  产出三选一提案;超编辑上限被拒;barrier 期间 caveat 出现在渲染快照;
  enforce 档下矛盾修复仍不自动应用。
- **M3: supersession 链 + NL 回滚 + docs**
  superseded-by 写入封套、rollback 命令、README(graduation criteria)。
  验证:回滚后记录集与历史版本精确一致;台账外记录回滚被拒并提示边界。

## 验证计划

- 单测/集成同各里程碑;驱动方式以 fixture memdir + 合成注入事件为主。
- 观测:`memory.maint.*` 分布、队列人工处置比(采纳/驳回),作为毕业
  提名遥测证据;矛盾修复质量由 12/24 eval rail 裁决,不自评。
- 门禁:三连全绿(原则 6)。

## 风险与开放问题

1. **07 机制抽取的回改风险**:抽 lib 时 07 已上线则须回归其全部验证;
   顺序上尽量在 07 M3 合入前后动,开放:抽取边界(状态机 vs 渲染)待
   spike 定。
2. **频率下界的偏差**:只覆盖 25 注入路径,冷记录可能"假性低频"被降级。
   缓释:`decay.minAgeDays` + queue-only 默认 + 人工审批兜底;25 之外
   的命中面是否存在,依赖 Track B(doc 26)类上游贡献,未知。
3. **矛盾配对启发式天花板**:改述型矛盾漏检、隐喻误检都不可避免;
   阈值先保守(宁漏勿误),误报率以 M2 audit 数据调。
4. **NL 回滚解析歧义**:自然语言时间表达解析错→回滚错集。缓释:回滚
   前呈现 diff 预览,应用仍需确认;台账外内容明确拒答。
5. **依赖时序**:M2 硬依赖 25 封套在真实使用中积累足够 provenance 密度
   ——若 25 推迟,M2 顺延,不降级为无出处修复(那比不修更危险)。
6. **失败判据(诚实写明)**:若遥测显示 memdir 增长在真实使用中平台化、
   且矛盾率≈0,M2/M3 永远不上架(shelf)——养护没有对象;M0/M1 的
   陈旧检测仍独立有价值。
7. **memdir 格式漂移**:同 doc 26 风险 6,fixture + 上游版本 pin 对冲。

## 边界与非目标

- 不重建生命周期机制(07 拥有)、不重复定义记录 schema(25 拥有)、
  不重复规定遥测键(doc 24 拥有)、不做预写准入(26/Track B 拥有)。
- 不做容量驱动删除(四类失败之三的反面:盲目按容量裁剪被显式排除,
  降级只走频率+年龄+人工)。
- 不做学习化遗忘策略(MemCon 类:future work,须先有 24 基线)。
- 完整 bi-temporal 台账(MemStrata 全量)与级联推理屏障
  (MEMOREPAIR 全量)不做,lite 语义以本文为准。
