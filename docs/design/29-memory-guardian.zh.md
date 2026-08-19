# 29 memory-guardian — 共享记忆治理(Tier 3;门控于真实多人使用)

> 状态: design (parked; 仅 M0 威胁模型/fixture 可先行) | Tier: 3 | 包: packages/memory/memory-guardian | 依赖: 25(记录封套 v1/provenance)、26(gate/scan);边界: 13(作用域)、09(出口)
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给团队共享记忆(team overlay)补上治理层——文件层 TOCTOU 修复、跨类型污染检测(provenance 密度 + 类型标签)、可选的签名写记录;前置一个对抗性 fixture 套件(投毒话题文件/类型混淆事实/过时但可信),把"共享记忆的失败模式"变成可注入、可度量的问题。
**用户问题**:团队 overlay 今天是只读分层、单租户、带文档化的 TOCTOU、**没有写协议**——一个被投毒或过时的话题文件会被每个队友的上下文原样吸收;一条项目事实被当成用户偏好(类型混淆)没有任何检测;谁写入的、何时写入的、凭什么写入,无从追责。

## 显式门控(先说清)

**本项在出现真实的多人 team-overlay 部署之前不启动建设**(M0 威胁模型/fixture 除外)。
单用户场景下治理价值 ≈ 0:唯一的写者就是用户自己,投毒与混淆的攻击面不存在,
TOCTOU 退化为"自己覆盖自己"。门控的判据不是日期而是事实:team overlay 出现 ≥2 个
独立写者、且写入路径经过 dsh 系插件(而非手工编辑)。

## 动机(威胁模型证据,不是预期 ROI)

以下均为论文/基准的实验室数字,作为威胁模型的存在性证据呈现,**不构成部署收益预期**:

- **MemPoison**(威胁模型):对 agent 记忆的投毒攻击 ASR 高达 0.95——共享记忆一旦
  可写且无验证,几乎必然被利用;这是"为什么需要治理"的证据,不是"部署后风险 95%"。
- **MemGate**:加边界/过滤后泄漏率 27% → 3.5%——方向性证据:读侧边界有效;
  同样是 lab 数字。
- **MemGuard**(2605.28009):类型隔离存储 + 跨类型污染检测;其 89.53% 抗幻觉数字是
  **该论文自己的 lab 结果**,本文只借其结构(按类型分储 + 跨类型污染检测),不引用
  该数字为预期。
- **SafeHarbor**(2605.05704):查询条件化的边界重建——按当前查询动态划记忆边界;
  注意其规则库构建成本,本文不采用查询期重建,只在读时做轻量一致性检查。
- **MutMem**:签名变更记录——仅作为 M3 可选附录的概念来源。
- **RBI-Eval**:current-turn warrant 概念——"本轮凭什么读这条记忆",影响 M2 的
  读时策略措辞。

## 现状与缺口

已具备:

- cc-plugins `memory` team overlay:只读分层、单租户、文档化的 TOCTOU;
  **无写协议**——这是本项存在的前提,也是最大的缺口。
- 25 的记录封套 v1(provenance:谁/何时/哪个会话写入)。
- 26 的 Track A gate(写后降级 + 读扫描)——记忆写入的既有闸门,本项在其下游。
- 11 的故障注入轨道、12 的 eval rail——fixture 的承载。
- 13 决定子代理/agent **看到**什么;09 审计什么**离开**(payload 出口)。

缺口:

- 写路径无协议、无并发控制(TOCTOU 是文档化的已知问题)。
- 无跨类型污染检测:memdir 的类型标签(user preference / project fact / …)之间
  的误读没有任何信号。
- 无对抗性 fixture:共享记忆的失败模式今天没有可复现的测试资产。

## 范围分解(与 13/09 的边界)

本项严格位于 13 与 09 之间:**13 管"谁能看到什么"(per-agent-kind 作用域),
09 管"什么能离开"(egress payload 审计),本项管"什么被写进/共享进记忆,以及类型
是否串染"**。不重做 13 的 per-agent-kind scoping,不重做 09 的出口审计——两者均以
cross-ref 引用,本文不重复其接缝与设计。

## 设计

### 表面与接缝(verified + cited)

上游缝(本项直接依赖的仅配置与遥测;写入路径是 incubation 侧的):

| 接缝 | 已核实表面 | 出处 |
|---|---|---|
| 配置命名空间 | `settingsNamespace` + `installSettingsSection`(注册即暴露;热更新;`ctx.settings.describe()` 运行时读) | `$DSH/packages/settings/settings/src/index.ts:863` |
| 遥测通道 | 自定义 session 事件类型封闭(未知类型被持久层拒收);插件事件走 `session-telemetry/record` 运维通道 | `$DSH/packages/session/session-persistence-jsonl/src/format.ts:244` |
| timer(若 sweep 用) | `ctx.interval` effect-scoped 自动清理——不可用于无人值守的持久巡检 | `$DSH/vendor/timer/src/index.ts:4-15` |
| 回合边界 | `agent/turn-stopping` serial;listener 永不 throw(throw → error turn) | `$DSH/packages/core/agent/src/runtime-types.ts:272-278`、`$DSH/packages/core/agent-loop/src/agent.ts:304-315` |

incubation 侧缝(以各文档落盘 API 为准,此处只引用不重述):25 记录封套 v1 的
provenance 字段;26 Track A 的写后降级 + 读扫描;11 故障注入轨道;12 eval rail。

### M0 — 威胁模型 + 对抗性 fixture 套件

三类 fixture,骑 11 的故障注入轨道与 12 的 rail 运行:

1. **poisoned topic file(投毒话题文件)**:overlay 中混入语义可信但内容错误的条目
   (错误 API 签名、过时的内部约定),度量下游任务被带偏率。
2. **type-confused fact(类型混淆事实)**:项目事实写入 user-preference 类型槽
   (及反向),度量类型串染是否改变 agent 行为(MemGuard 的跨类型污染检测结构)。
3. **stale-but-plausible(过时但可信)**:曾经正确、现在错误的条目——专门用来区分
   "投毒问题"与"单纯过时问题"(这直接喂给证伪线)。

fixture 只产出分布数据,不在 M0 建任何检测器。

### M1 — overlay TOCTOU 的文件层修复

- 写路径:incubation 侧 writer 全部收敛到单一 writer 模块,内做 **原子交换**
  (tmp + rename)或文件锁;任何插件不得绕过 writer 直写 overlay 文件。
- **诚实边界**:其他会话里的读者无法被协调——文件锁只约束 dsh 系写者,管不住
  手工编辑与外部进程。因此配套**读时版本化一致性检查**:读取时校验封套里的
  版本/单调序号(RBI-Eval 的 current-turn warrant 措辞:本轮读到的这份凭什么可信),
  不一致 → 丢弃本次缓存、重读、仍不一致 → 降级为"陈旧读取"事件落遥测。
- 明确不做分布式共识:overlay 是共享文件系统上的约定,不是数据库。

### M2 — 跨类型污染检测器

- 输入:memdir 的**类型标签** + 25 封套的 **provenance 密度**(一个话题文件里
  provenance 来源的离散度——多来源互相矛盾的类型断言是污染信号)。
- 形态:静态扫描(非查询期重建;SafeHarbor 的查询条件化重建因规则库成本明确不采用),
  产出入 `memory.guardian.*` 遥测键(键约定属 doc 24,此处仅声明前缀)与
  per-scope 读/写策略命中报告。
- 与 26 的关系:26 Track A 管"这条写入该不该过闸",本检测器管"过了闸的东西在
  类型轴上是否串染"——下游互补,不重复扫描逻辑。

### M3(可选附录)— 签名写记录

MutMem 概念:writer 对每条写记录附签名(同一信任域内的密钥约定),读时验签。
**明确标注为 future/optional**:单信任域内签名只防外部篡改,防不了被攻陷的写者;
密钥管理成本在单租户 overlay 上不成立。除非 M0/M2 数据显示篡改(而非过时)是
主导失败模式,否则不做。

### 配置

标准 配置声明(rc.7 起) 小节(`settingsNamespace` + `installSettingsSection`,
`packages/settings/settings/src/index.ts:863`;分层解析 + 热更新;注册即暴露):

```yaml
memory-guardian:
  scanMode: audit           # off | audit | enforce(原则 3 三档)
  perScopePolicies:         # per-scope 读/写策略
    - scope: "team"
      read: audit
      write: enforce        # enforce = 仅经 M1 writer,拒绝旁路
  maxProvenanceSources: 8   # 超出的类型断言冲突进报告
```

## 里程碑切分

**M0 — 威胁模型 + fixture 套件(唯一先行项)**
三类 fixture + 骑 11/12 轨道跑通 + 失败模式分布报告(带偏率/串染率/过时占比)。
单测:fixture 的确定性(同输入同分布);不需要任何 writer/检测器。
**验证**:在合成 overlay 上跑出三类失败模式的基线分布,报告落盘。

**M1 — 文件层 TOCTOU 修复(门控后)**
writer 收敛 + 原子交换/锁 + 读时版本化一致性检查 + 陈旧读取遥测。
**验证**:并发写压力测试无撕裂读;手工外部改文件触发"陈旧读取"路径而非崩溃。

**M2 — 跨类型污染检测器**
类型标签 + provenance 密度扫描、per-scope 策略、报告命令。
**验证**:M0 的 type-confused fixture 上检出率报告(只报数字,不设预设阈值)。

**M3 — (可选)签名写记录**:见上文,默认不做。

## 风险与开放问题

- R1 **写协议是前置而非本项产出**:cc-plugins overlay 无写协议——M1 的"writer 收敛"
  前提是 incubation 侧插件已成为实际写路径;若真实部署仍以手工编辑为主,writer
  形同虚设,门控判据因此包含"写入经 dsh 系插件"这一条。
- R2 **fixture 的度量口径**:被带偏率/串染率依赖下游任务判定,借 12 的 rail 时
  判分标准是否稳定,开放。
- R3 **类型标签的权威性**:memdir 类型标签若由 model 写入,本身就是攻击面
  (投毒者先污染标签);M2 的检测器是否需要 25 封套的 createdBy 交叉验证,开放。
- R4 **读时一致性检查的成本**:每读校验版本/重读的延迟在 overlay 规模大时未测;
  若显著,退化为采样校验,开放。
- R5 **签名(M3)的信任域边界**:单密钥信任域防外不防内;多租户密钥分发完全没有
  承载点,这是 M3 保持 optional 的根因。
- R6 **lab 数字的再标注义务**:本文所有对抗数字(0.95、27→3.5%、89.53%)在后续
  README/报表中引用时必须保留"lab 结果"标注,不得转为部署预期。

## 边界与不做的范围

- 不做 per-agent-kind 作用域(13 的职责,cross-ref)。
- 不做 egress/出口 payload 审计(09 的职责,cross-ref)。
- 不做查询期边界重建(SafeHarbor 路线,规则库成本)。
- 不做分布式共识/数据库化 overlay——文件层约定是前提。
- 签名写记录默认 out-of-scope(仅 M3 可选附录)。
- 记忆打包与 `memory.*` 遥测键约定属 doc 24,本文只声明 `memory.guardian.*` 前缀。
- **证伪线**:若 M0 fixture 显示 overlay 的失败模式由单纯过时(staleness)主导、
  投毒与类型串染占比可忽略,则检测器范围收窄进 27(记忆维护),本项其余部分
  继续保持 parked。
