# 26 memory-write-gate — 记忆写入准入:事后降级门、载荷读扫描与上游预写门

> 状态: design (not started) | Tier: 2 | 包: packages/memory/memory-write-gate | 依赖: 08(rejection memory 先例);联动 24(基线判据)、29(team overlay)
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给 dsh-cc-plugins memory 的 consolidation 产物补一道**质量准入**——
事后(post-write)对已落盘记录打分、隔离劣质记录并阻断其再导入;对注入点附近的
记忆文本做指令形载荷扫描;并把"预写准入"作为对上游 `memory-consolidation` 的
PR 贡献(Track B),而不是伪装成本插件能力。
**用户问题**:今天的记忆要么全收要么全不收——consolidation 没有
admission 质量门,闲聊、瞬态状态、自相矛盾的事实全部沉进 memdir。无监管增长
直接稀释召回(InMind 式 recall dilution):memdir 越大,每次召回捞进 prompt 的
噪声越多,真正重要的事实反而被挤出去;而矛盾记录被召回后在决策面上互相打架,
没有任何机制说"这条不该进记忆"。

## 动机(文献锚点,含诚实标注)

- **MemRouter**(2605.00356):报告 +10.3 F1 / 16.7× 召回效率,但**这些数字
  来自训练出的 12M 参数 embedder 路由器**,而我们采用的打分器是启发式 +
  LLM-fallback——每 turn 支付 MemRouter 用训练消除掉的成本。本工作项只采纳其
  **概念**:"写入应有准入门槛,而不是写后全收";不引用、不预期其量化收益。
- **Selective Persistent Memory**(2607.09493):96% vs 71% 任务完成率
  (选择性持久化 vs 全量),证明准入门有真实收益。**单平台用户研究**的局限
  原样标注,不外推。
- **ConsistencyGate**:K-shot 自一致性准入;成本集中在 implicit facts——
  启发式先筛、灰区才进 LLM-fallback,正是把贵判定收窄到灰带。
- **DMF**(2606.03463):deterministic write function——写入判定应可复现、
  可审计,不引入隐藏学习状态;本打分器全部输入(记录文本、frontmatter、
  邻近记录)确定,同输入同结论。
- **MemSIF**:CoreFact(写入时)与 ActiveFact(查询时)分工——写入门管
  "什么配成为核心事实";查询时过滤属召回侧,不在本包范围。
- **GhostWriter / AM-Sentry**:delayed-activation payload 的准入 + 检索
  双门——记忆文本本身可以是注入载体;读侧扫描(本包 Track A 第二特性)
  是检索门的移植。

## 现状与缺口(硬约束,先说清)

**插件不能包裹插件,上游没有记忆写入的瀑布/事件缝。** memory 系包
(`packages/memory/memory`、`packages/memory/memory-consolidation`)不被挂载为
可包裹的服务:它们内部自行监听 `agent/pre-step` / `agent/turn-stopping`
(可在 `packages/memory/memory-consolidation/lib/index.js` 内见到
turn-stopping 订阅),consolidation 的写入发生在其内部,**没有任何事件或
waterfall 让第三方插件在写入前介入**;自定义会话事件类型对仓外插件封闭
(读路径在缺少 `ignorable: true` 时拒绝解释,
`packages/session/session-persistence-jsonl/src/format.ts:244` 一带即
格式拒绝的落点)。因此:

- **Track A(本仓孵化插件)**只能做**事后降级门**:写已发生,门在下一读
  之前跑。这严格弱于预写准入——坏记录在写入到门运行之间对召回可见。
- **Track B(上游贡献,非插件)**:向 dsh-cc-plugins `memory-consolidation`
  提 PR,增加 pre-write admission hook(scorer SPI)。**在 Track B 落地前,
  真正的预写准入不存在**;本文档不假装它存在。

memdir 是普通文件(MEMORY.md 入口 + 带 user/feedback/project/reference
frontmatter 的 topic md;入口名与截断逻辑见
`packages/memory/memory/lib/index.js:873-879` 一带),所以**文件级
读/写/mtime 访问对孵化插件可用**——这是 Track A 全部能力的事实基础。

### 与 dsh-cc-plugins memory 的边界

本插件读 memdir 文件(只读扫描 + 写自己的隔离区),**不改写** cc-plugins
的原始记忆文件:被降级记录移入本插件自有的 `.dsh/mem-gate/quarantine/`
并从原文件中删除该条目(这是对 memdir 的编辑,须原子写并在审计事件中留痕);
不从 consolidation 的写入路径上拦截(不可能,见硬约束)。Track B 才是
上游侧的正确集成形态。

## 设计

### 表面与接缝(verified + cited)

1. **turn-stopping 串行钩**:`'agent/turn-stopping'` 串行触发
   (`packages/core/agent/src/runtime-types.ts:272-278`);listener 抛异常会把
   STALL 变成 error(turn 级错误包装见
   `packages/core/agent-loop/src/agent.ts:304-315`)→ **gate listener 必须永不
   throw**,所有扫描工作经 `ctx.jobs` 转 background(见 3),钩内只入队。
2. **effect-scoped 定时器**:`ctx.interval` / `ctx.timeout` 随 scope 自动
   dispose(`vendor/timer/src/index.ts:4-22` 的 mixin + disposable 装饰)→
   每小时清扫扫描用 `ctx.interval` 注册,插件卸载即停。
3. **进程内后台任务**:`ctx.jobs` 为 in-process 契约
   (`packages/jobs/jobs/README.md:40`)→ 扫描/打分作为 background job
   运行,turn-stopping 钩只 `JobStart.run()` 入队后立即返回。
4. **文件面**:memdir 与 `.dsh/mem-gate/` 均走 `ctx.fs` + 原子写
   (temp + rename,07 同款惯例);mtime 作为"写入到门运行"窗口的检测信号。
5. **配置**:`settingsNamespace` + `installSettingsSection`
   (`packages/settings/settings/src/index.ts:863`)。
6. **遥测**:ops-channel `session-telemetry/record` waterfall,`memory.*`
   键约定**由 doc 24 拥有**——本包只发计数器
   (`memory.gate.scanned|quarantined|rehydrated|payload_flagged` 等),
   key 命名与 schema 遵从 doc 24,不在本文重复规定。

#### 配置声明（rc.7 起）

> **配置声明（rc.7 起）**：本插件的用户可调旋钮通过 settings 命名空间声明
> （`settingsNamespace` + `installSettingsSection`，
> `packages/settings/settings/src/index.ts:863`）：解析分层为 schema 默认值 →
> cordis 组合条目（base）→ `settings.yaml` 用户文档；支持 `settings/updated`
> 热更新与 `ctx.settings.describe()` 运行时读取。注册即暴露——#2404 移除了
> apiproxy 白名单，注册是唯一的暴露控制点——因此 web 设置页与
> `settings.yaml` 都可编辑；cordis `apply(ctx, config)` 第二参数保留为组合
> 默认值层。

**配置**(每记录类别独立三档;`off | audit | enforce` 语义:

| 键 | 默认 | 含义 |
|---|---|---|
| `gate.chitchat` | `audit` | 闲聊/瞬态记录:audit=只记数;enforce=隔离 |
| `gate.contradicted` | `audit` | 与更新记录矛盾(启发式):enforce=隔离较旧方 |
| `gate.incomplete` | `audit` | frontmatter 残缺:enforce=隔离 |
| `gate.payloadScan` | `audit` | 指令形载荷扫描:enforce=隔离 + 遥测 |
| `gate.grayBandLlm` | `on` | 灰带记录送 LLM-fallback 判定(provider/model 必填成对,同 07 范式 3) |
| `gate.sweepIntervalMinutes` | 60 | `ctx.interval` 清扫周期 |
| `quarantine.retainDays` | 30 | 隔离区保留期,过期物理删除 |

### 关键行为流

**事后降级门(Track A 特性 1)**
触发:turn-stopping 钩(入队)或 hourly interval。job 内:
(a) 枚举 memdir 记录,按 mtime 增量;(b) 逐条打分——启发式:age、
与更新记录矛盾(同 topic 内断言冲突的正则/字段级近似,DMF 确定性)、
frontmatter 完整性、相对既有记录集的 novelty(与近邻重复度过高 = 无信息);
灰带才进 LLM-fallback(ConsistencyGate 的成本收窄);(c) enforce 档下
劣质记录从原文件原子移除、落入 `.dsh/mem-gate/quarantine/`(保留原始
frontmatter + 隔离原因 + 时间戳),其 contentHash 记入 **rejected-hash 集**
(08 的 rejection memory 先例:同 hash 内容再被 consolidation 导入时直接拒,
阻断"换个文件再沉进来");(d) 计数器入 ops 遥测。
**弱于预写准入的窗口诚实声明**:坏记录在"写入→下一次门运行"之间对召回
可见。缓释:turn-stop 钩使门在**下一会话首次读取之前**完成(同 turn 内
入队、后台立即跑);残余窗口 = 同一会话内的后续召回,接受并遥测该窗口
命中率。

**延迟载荷读扫描(Track A 特性 2,GhostWriter 式)**
对"被召回/注入的记忆文本"在注入点附近扫描指令形载荷:针对 agent 的
覆盖语("ignore previous…" 中英模式)、工具调用形文本、base64/hex 大块
(复用 08 的 `safety/override-phrase`、`safety/base64-blob` 模式库,不重写)。
命中 → 标记 + 隔离提案 + `memory.gate.payload_flagged` 遥测;enforce 档
直接隔离。**范围收紧**:只扫记忆注入通道,不做通用 prompt 过滤(那是
09 token-wall 的地盘);只对本插件可观察到的注入文本生效(诚实面:cc-plugins
记忆注入发生在其内部,本插件能稳定观察的是 memdir 文件本身——读扫描因此
主要在门扫描时对全部记录执行,而非逐 turn 拦截注入)。

**团队域变体(Track A 里程碑项)**
team overlay 在场时(`29` 的 team-scope 机制),gate 对团队共享 memdir
加严:enforce 前置人工审批(隔离提案走 `approval/request` waterfall,
共享原则 1)。细节以 doc 29 的 overlay 契约为准,本包只声明消费。

**Track B(上游贡献,repo deliverable,非插件)**
对 dsh-cc-plugins `memory-consolidation` 的 PR:在持久化前插入 admission
hook(scorer SPI:输入候选记录 + 上下文,输出 admit/reject/gray),本仓
Track A 的打分器以适配器形式挂入。**明说:Track B 合入前,预写准入不存在;
Track A 一直是事后门。** Track B 的验收在上游仓库,不进本仓里程碑门禁,
只在本仓维护适配器与 PR 链接。

## 里程碑切分

- **M0: 打分器 + 隔离区 + rejected-hash 集**
  memdir 只读解析、启发式四项打分、`.dsh/mem-gate/quarantine/` 原子写、
  hash 集持久化与再导入阻断、`memory.gate.*` 计数器、settings 三档。
  验证:fixture memdir(闲聊/矛盾/残缺/良例)→ 打分快照测试;同 hash
  重导入被拒单测;listener 永不 throw(注入异常仅遥测)。
- **M1: 读扫描(payload scan)**
  模式库复用 08 规则、扫描 job 挂 hourly interval + turn-stop 入队、
  enforce 档隔离、遥测。验证:含载荷文案的 fixture 被标记/隔离;
  良性记忆零误报(阈值内)。
- **M2: team-scope 变体 + Track B PR**
  doc 29 overlay 下的审批式 enforce;上游 scorer SPI PR 提交并链接。
  验证:team fixture 走 approval waterfall;PR 仅记录链接,M2 门禁不依赖
  上游合入。
- **M3: enforce 毕业(gated on 24)**
  默认档升 enforce 的**显式晋升判据**:doc 24 的 baseline 在我们的真实
  workload 上证明 recall dilution 存在(召回噪声占比、矛盾召回率等指标
  超阈值),否则停留在 audit。验证:以 24 的 bench pack 复跑 gate on/off
  对照,隔离组的召回质量不劣于全量(12/24 的 eval rail 是裁决方)。

## 验证计划

- 单测:打分器确定性(同输入同结论)、hash 集阻断、原子写往返、
  interval dispose(scope 卸载即停)。
- 集成:合成 memdir fixture 全套;turn-stopping 入队不阻塞(钩内无 await
  重活);jobs 后台执行遥测可见。
- 真实试用:本仓开发会话启用 audit ≥ 2 周,`memory.gate.quarantined`
  人工抽检误报率,作为 M3 晋升讨论证据。
- 门禁:三连全绿(原则 6)。

## 风险与开放问题

1. **编辑 memdir 原文件的竞态**:gate 移除记录与 cc-plugins consolidation
   写入可能并发。缓释:原子写 + mtime 前置检查(写前 mtime 变则放弃本轮
   该文件);残余竞态窗口记录于遥测。开放:上游是否愿意暴露文件锁或
   写完成事件(Track B PR 的附加议题)。
2. **灰带 LLM-fallback 的成本**:每条灰带一次辅助调用;上限阈值(每轮
   最多 N 条)待 M0 遥测定。
3. **矛盾检测的启发式天花板**:字段级近似会漏掉改述型矛盾;漏检率未知,
   依赖 doc 24 基线度量,不预设。
4. **MemRouter 数字不可迁移**(已在动机节声明):若需量化收益声明,
   必须走 12/24 的 eval rail,禁止引用文献数字。
5. **失败判据(诚实写明)**:若 doc 24 显示"可用性≈使用率"(记忆几乎
   全被召回且无稀释),准入门没有收益空间——Track B 撤回,Track A 收缩
   为 payload-scan-only。
6. **memdir 格式漂移**:cc-plugins 若改 topic md 结构,解析器需跟随;
   以 fixture + 上游版本 pin 对冲。

## 边界与非目标

- 不包裹、不替代 cc-plugins memory(硬约束,见现状节);不修改
  consolidation 的检索逻辑。
- 不做查询时召回过滤(MemSIF 的 ActiveFact 面)——那是召回侧工作,
  若立项另开文档。
- 不做通用 prompt 注入过滤(09 token-wall 域);不学习打分器
  (DMF 确定性约束,学习化是 future work 且须先有 24 基线)。
- Track B 的上游评审节奏不受本仓控制;本仓不因 PR 未合而阻塞 M0–M1。
