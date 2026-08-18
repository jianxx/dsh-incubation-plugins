# 19 evidence-registry — 跨会话领域信念登记处(并行 worker 的事实准入单一权威)

> 状态: design (not started) | Tier: 3 | 包: packages/science/evidence-registry | 依赖: [20 citation-verify](20-citation-verify.zh.md)(运行时注册 claim_level 2/4 档 verifier,M2 起;编译期零依赖) | 可选集成: 13 subagent-context-scope(M4)、15 scholar(编号预留,规划中)、03 trace-contracts(3 档 run 证据)

## 设计目标与用户问题

**目标**:一个跨会话的领域知识状态登记处——研究对象的**假设(hypothesis)、证据(evidence)、信念更新(belief_update)**三类条目录入 append-only 哈希链;信念状态只能由**过了门的证据**改变;多 worker 的全部写入经单一串行化点追加,这就是 Danus "stateless verifier 是事实准入唯一权威"在本插件的具体化。

**用户问题**:科研型多代理会话(3–9 个并行 worker 查文献、跑分析)最慢性的失败不是某个 worker 撒谎,而是**污染扩散**:worker A 凭半截证据宣布"假设 H 已被证实",worker B 把这句话当作事实前提继续推理,错误结论在 worker 之间互相引用、自我巩固,到终稿时已经没人分得清哪条信念有证据、哪条是谣言的平方。会话结束后这些信念还无处安放——下次研究同一主题,一切从头再来,或更糟:凭印象继续。

## 动机(为什么必要 — 两篇文献各给一半答案)

**HEP(Hypothesis Evolution Protocol,arXiv 2607.09195)**:把假设从"会话里的闲聊"升级为**持续演化的 registry 工件**——每个假设携带先验置信度 P(H)、lifecycle、lineage,全部变更走 hash-chained append-only event log,且**只有通过 evidence gate 的证据才能改变信念**。它给出形态学与可重放性:信念不是浮在上下文里的文本,而是可回放到任意时点的状态机。HEP 的教训同样直接可引:其证据强度受限于 agent 自评验证与工具 fidelity——换言之,协议立起来了,**gate 的档位必须外接真 verifier**,不能让 agent 给自己批条子。

**Danus(arXiv 2607.06447)**:verifier-gated 研究 workflow——main agent 规划、workers 并行探索、**stateless verifier 是事实准入的唯一权威**;fact-graph 以 proof + dependency 记忆,支持错误事实的**依赖传播式撤销**;未验证的 dead ends 与计划只留低信任的 global/local memory,不进 fact graph。它给出并行世界的纪律:worker 越多,越需要一个不接受"自报家门"的准入点;撤销语义则保证 registry 不是只能垒不能拆的单向坡——已接受信念被否证时,依赖它的下游信念可以沿着依赖指针级联标记,而不是静默作废。

两篇合起来就是本设计的骨架:**HEP 的 registry 形态(hash 链 append-only + 证据过门改信念)× Danus 的并行治理(单一权威 + proof/dependency 支持撤销)**。registry 不是又一份 markdown 笔记,是并行 agent 研究流程里"哪条信念此刻站得住"的唯一权威答案。

## 现状与缺口

dsh 现状(逐项已核实,见"表面与接缝"):

- **append-only 先例**:`session-persistence-jsonl` 就是"文件只增、无删除 API"的工程先例(doc 12 已核实其布局);其发布用 `link()+unlink()` no-clobber 协议(`:544-549`)——单写者假设深植于上游存储基建。
- **KV 层不替你串行化**:`storage` 的 `KvUnit` 头注明示 "**does NOT serialize concurrent writes — write ordering is the caller's responsibility**"(`backend.ts:59-60`);要串行化,要么走 `storage-domain` 的单写链(其 `update()` 承诺 "concurrent updates never interleave",`domain.ts:83-84`),要么自建进程内队列 + 文件锁。
- **共享观测与工具注册面**齐备:`ctx.tools.register`(强制 output schema)、`session-telemetry/record` ops channel、`session/event` 订阅,doc 02 均已钉死行号。

缺口:(a) 没有任何跨会话的**领域语义状态**存储——memory/CLAUDE.md 是自由文本,
无结构、无门控、无撤销;(b) 没有"信念只能由过门证据改变"的强约束原语;
(c) 并行 worker 写入共享知识时没有任何串行化纪律保护(这在 dsh 的
session/subagent 语义里尤其裸露:子代理各自活在自己的 session 里)。

## 与 02 claim-contracts 的边界(专设一节)

这一节是本文档的承重墙,先读 [02 claim-contracts](02-claim-contracts.zh.md) 再读本节。

- **02 管轮级诚实性**:在每个 `turn/end` 对"assistant 的自然语言自述"做 supported /
  unsupported / unverifiable 三态审计,判据是**本会话的工具事件对账**(`tool/call` ↔
  `tool/result` 配对 + 只读 fs 断言)。它回答:"agent 刚说的那句话,和这一 turn 里
  真实发生的调用对得上吗?"判定域 = 会话内事件,时间粒度 = turn。
- **19 管跨会话领域语义**:研究对象的假设、证据、信念状态机,判据是
  **带 gate_ref 的过门证据条目**。它回答:"关于这个研究对象,此刻哪条信念的
  confidence 是多少,且它是被哪份过了门的证据更新的?"判定域 = 外部世界,
  时间粒度 = 跨会话长期。
- **交叉点(单向)**:19 的 belief_update 可以把 02 已审计为 supported 的轮级 claim
  当作**证据线索**(evidence 条目的 `source` 指向该 turn 的事件 seq 区间),再由
  相应档位的 verifier 决定是否接受。19 从不反向过问轮级诚实性——worker 在 turn
  里撒没撒谎是 02 的事;19 只保证"撒谎就算没被 02 抓到,也进不了信念层",
  因为没 gate_ref 的 belief_update 在登记处就被拒。
- **档位含义不同,勿混**:02 的 `off / audit / enforce` 是 gate 执行强度;19 的
  `claim_level 1–5` 是**论断所需的证据强度档**。后者靠前者式的腿型 verifier 满足,
  两者共用 overview 原则 3 的三档旋钮但语义正交。

## 设计

### 表面与接缝(exact names + verified paths)

以下每条均在上游 dsh 源码核实;姊妹项(15/17)未落地的仅出现在开放问题。

1. **工具注册缝 — `ctx.tools.register(definition)`**
   `deepseek-harness/packages/core/tools/src/index.ts:1037`(返回 dispose 函数;
   强制 `output: {schema, render, presentationMeta?}`,否则即抛 `:1039-1042`)。
   四工具 registry_propose_hypothesis / registry_add_evidence / registry_belief_update /
   registry_query 均由本插件注册;**这是写入唯一入口**(见行为流单写者节)。
2. **存储座标 — `.science/registry.ndjson`(项目根)**
   项目级 `.dsh/` 目录约定见 doc 02 第 7 条缝
   (`packages/skill/skill-filesystem/src/index.ts:246`)。registry 是**数据工件**而非
   配置,故单独放 `.science/`(与 [20 citation-verify](20-citation-verify.zh.md) 的
   `.science/cite-checks/` 同根,便于外部工具整体冻结/归档)。
   追加协议自建(见行为流),dsh 的 `storage-json` 不适配:它是 whole-file snapshot
   (`atomic.ts` 的 writeAtomic,`:1-12` 头注"write a same-directory temp file, fsync
   it, then rename"),per-unit 单写者且 last-write-wins——无法表达"并发追加全局有序"。
   `storage-domain` 的单写链(`domain.ts:83-84` 的 atomic RMW 语义)可作后续 backend
   化的备选实现(开放问题 2)。
3. **遥测缝 — `session-telemetry/record` waterfall**
   `deepseek-harness/packages/session/session-telemetry/src/index.ts:43`,
   record 结构 `:55-`(`channel`、`severity`、`attributes`、`body`),sink `emit()`
   非阻塞 enqueue(:104);coordinator 对抛异常的 listener 容纳(fail-closed,
   `coordinator.ts:205-216`)。本插件 op 词表见数据模型节。
4. **事件订阅缝(可选观察面) — `session/event`**
   `deepseek-harness/packages/core/session/src/index.ts:76`,post-commit
   fire-and-forget,事件信封带单调 `seq`(类型见
   `packages/core/session/src/types.ts:415-447`,doc 02 已核实)。
   M4 用它把 registry_query 摘要绑进子代理上下文(以 turn 边界为注入时点)。
5. **13 交接缝(读者侧)**:[13-subagent-context-scope](13-subagent-context-scope.zh.md)
   已核实 `ctx.subagents.registerProvider`(index.ts:369-385)与
   `SubagentStartRequest.prompt` 整体可换(types.ts:100-149),scoped section 遮蔽
   已成立(core/system-prompt/src/index.ts:373-389)。19 不注册 provider,只导出
   `registry_query` 工具与 digest 构造器;**把 digest 注入子代理 prompt 的消费方
   是 13 的 scoped provider 或任何委托发起方**——19 给答案,13 给注入口。

### 数据模型 / 配置

**条目三类 + tombstone**,每行一条 JSON,canonical 序列化后尾部追加:

```ts
type RegistryEntry = {
  seq: number;                    // 全局单调序,追加时分配
  prev: string;                   // 上一条目的 sha256,'GENESIS' 链首
  kind: 'hypothesis' | 'evidence' | 'belief_update' | 'tombstone'
  id: string;                     // 本条内容寻址 sha256(canonical(entry minus id))
  at: string;                     // ISO8601
  agent?: string;                 // 写入者标识,审计用,不作安全边界
  payload: HypothesisP | EvidenceP | BeliefUpdateP | TombstoneP
}

type HypothesisP = {
  text: string
  confidence0: number             // 先验,0..1
  claim_level: 1|2|3|4|5          // 论断强度,决定所需 verifier 档位
  tags: string[]
}

type EvidenceP = {
  hypothesis: string              // 指向 hypothesis.id
  source: { kind: 'cite', ref: string }                // cite://<check_id>(doc 20)
        | { kind: 'run', ref: string }                 // trace://<run_id>(17/doc 03 类)
        | { kind: 'evidence_id', ref: string }         // 15 的稳定 ID
        | { kind: 'session-seq', span: [number, number] } // 本会话事件区间(经 02 审计线索)
  gate_ref?: string               // verifier 判决指针,形如 cite://<check_id>
  gate_tier: 1|2|3|4|5            // 该证据实际过的档位(由 gate_ref 解析对象自报)
  summary: string
}

type BeliefUpdateP = {
  hypothesis_raw: string          // hypothesis.id
  direction: 'support' | 'weaken' | 'abstain'
  new_confidence: number
  via_evidence: string[]          // evidence.id 列表;**每个都必须 gate 达标**
  rationale: string
}

type TombstoneP = {
  target: string                  // 被撤条目的 id(通常撤 evidence 或 hypothesis)
  reason: string
  by: 'author' | 'cascade'        // cascade = 依赖传播(Danus 撤销语义)
}
```

**claim_level → 所需 verifier 档位映射表**(config 可配,默认):

| claim_level | 语义 | 默认所需 gate_tier | 现成实现注册点 |
|---|---|---|---|
| 1 边缘观察 | 自述批注即可 | 1(无门) | 无(直接追加) |
| 2 规则级主张 | 机械可判 | 2 | [20](20-citation-verify.zh.md) V1 机械门 |
| 3 执行级主张 | 跑过且复核过 | 3 | 03 trace-gate 结果 / 17 run 指针 |
| 4 领域级主张 | 语义实质核查 | 4 | [20](20-citation-verify.zh.md) V1+V2 |
| 5 形式主张 | 形式验证 | 5 | (预留,尚无实现) |

`belief_update.via_evidence` 的每个 evidence 必须 `gate_tier >= 其 hypothesis 的
claim_level 所需档位`,否则整拒(见行为流)。映射表在 config:

```ts
{
  registry: {
    path: '.science/registry.ndjson'  // 相对项目根
    tierRequirement: Record<1|2|3|4|5, { minGateTier: 1|2|3|4|5 }>
    // verifier URI scheme 注册:见行为流"门控校验",20 提供 cite://,03 系 trace://
  },
  telemetry: { ops: true }            // overview 原则 3 的 audit/enforce 只作用于
                                      // 门控强度(见下),不改变观测义务
}
```

**遥测词表**(ops channel;provenance 含插件名,doc 00 原则"观测带归因"):

| op | 触发点 | attributes |
|---|---|---|
| `evidence-registry/append` | 每次成功追加 | `kind`, `seq`, `agent` |
| `evidence-registry/gate-reject` | gate 校验拒绝 belief_update | `hypothesis`, `claim_level`, `missing_tier` |
| `evidence-registry/write-conflict` | 串行化点检测到序冲突 | `expected_seq`, `got_seq` |

**与 20 的 gate_ref 契约**:URI 形态 `<scheme>://<id>`。`cite://<check_id>` 解析为
`.science/cite-checks/<check_id>.json`(工件格式见
[20 文档](20-citation-verify.zh.md)),自报 tier = `claim_level` 表声明(20 承担
2=仅 V1、4=V1+V2)。`trace://<run_id>` 预留 03/17 类。未注册 scheme = 解析失败。

### 关键行为流

**单写者纪律(Danus 单一权威的具体化)**:四个工具的全部追加路径收敛到模块内单一
`append(entry)` 函数——(a) 进程内:Promise 队列串行化,`seq` 分配与 `prev` 链算
在临界区完成;(b) 跨进程:`.science/registry.lock` 咨询锁(lockfile 实现属实现选型;
`storage-json` 头注(:1-12)的 "one writer per process" 先例表明 dsh 已把多写者纪律
推给调用方,本插件照此契约行事)。**契约句,不写给实现**:追加原子、全局有序。
任何 bypass 该函数的写入都是 bug;工具以"永不 throw 出 handler"为准则
(doc 02 缝 2 同一教训:listener 异常会被框架兜成 isError,丢失可行动反馈)。

**写入流(逐 kind)**:

- `registry_propose_hypothesis(text, confidence0, claim_level, tags)`:无门,直接追加
  hypothesis 条目,telemetry `append`。claim_level 一经写下即冻结(强度是论断的一部分,
  升降档等于新假设)。
- `registry_add_evidence(hypothesis, source, gate_ref?, gate_tier, summary)`:校验
  `hypothesis` 指针可解析(存在且未被 tombstone);gate_ref 非空时立即验:
  scheme 已注册 → 解析出检查对象 → 其自报 tier 与 `gate_tier` 字段一致
  (不一致 = 拒,"自报档位"必须和工件内容吻合,防档位僭越)。追加 evidence 条目。
- `registry_belief_update(hypothesis, direction, new_confidence, via_evidence, rationale)`:
  **这是唯一长牙的工具**。逐 via_evidence 校验:(i) 指针可解析;(ii) 未被 tombstone;
  (iii) 其 gate_tier ≥ 该 hypothesis claim_level 的所需档位(映射表 config)。
  任一不满足即整拒,返回文案列明被拒原因(可行动反馈,EG-VAR 式 abstain 的
  代价提示)且 telemetry `gate-reject`;全过才追加 belief_update。`abstain`
  方向**特殊豁免**:放弃判定也是判定(02 动机节 EG-VAR 语义),via_evidence 可空,
  但 rationale 必填缺链描述。
- `registry_query(filter?)`:当前信念图——遍历链,应用 tombstone 撤销
  (Danus 依赖传播:evidence 被撤 → 引用它的 belief_update 级联标 `cascade`
  tombstone,hypothesis 的有效 confidence 回落到有据可查的最后值),
  输出按 hypothesis 分组的现状视图。**查询是惰性的**:链是真相,查询是投影。

**撤销流(tombstone)**:`registry_tombstone(target, reason)` 仅作条目追加
(工具面并入 registry_append 的内部入口,模型可用 `registry_belief_update` 之外的
第四+一工具 `registry_tombstone`);**不删历史、不改写**。查询时在投影层消化。
这正对应 Danus 的 fact-graph 撤销与 HEP 的 hash 链 append-only:史不可改,现可撤。

**M4 注入流(query → 子代理上下文)**:委托发起方(13 scoped provider 或调用代码)
在 start 前调 `registry_query({compressed: true, maxItems: N})` 拿 digest,拼进
子代理 prompt 的 scoped section(13 已证 section 遮蔽成立,见接缝 5)。
**一致性口径**:同一 registry 在同一会话内版本单调——父子共享文件,digest 里带
`asOfSeq`,子代理回写时以其为 read-your-writes 基线(开放问题 4 论并发漂移)。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:")

- **M1 — ndjson + hash 链 + 三工具 + 写入纪律**:`pnpm new:plugin science
  evidence-registry` 骨架;条目 schema 与 canonical 序列化;`append()` 串行化点
  (进程内队列 + lockfile);hypothesis/evidence/belief_update 三工具
  (belief_update 只校验指针可解析,gate 校验留 M2);registry_query(含 tombstone
  投影);telemetry `append` op。
  **验证**: 驱动方式 = vitest 单测 + 直接构造条目序列;可观察结果 = 50 并发
  `append` 调用序列化产出合法链(逐条 `prev` 链可校验、seq 连续、无字节交织),
  tombstone 后 query roller 出回落的 confidence;通过条件 = `pnpm typecheck &&
  pnpm test` 全绿,含哈希链校验器作为纯函数独立测。
- **M2 — gate_ref 校验(仅格式)+ verifier 注册表**:scheme 注册表
  (`cite://` 由 [20](20-citation-verify.zh.md) 工件解析器承担,本插件内嵌最小
  JSON 读取;`trace://` 留扩展点);档位映射 config;belief_update 的全部三条
  gate 校验;`gate-reject` op。
  **验证**: 驱动方式 = 单测,构造 cite 工件 fixture(合法/缺文件/tier 不足/
  自报 tier 与工件不符四态);可观察结果 = belief_update 接受/拒绝与
  `gate-reject` 的 attributes 逐字段断言;通过条件 = 四态全覆盖、
  拒绝文案含修复指引。
- **M3 — 单写者并发硬化 + 冲突测试**:跨进程 lockfile 语义钉死(锁获取失败
  快速失败而非排队假死);崩溃恢复(半行截断检测:JSON 解析失败行即尾部即抛
  `corrupt-tail`,不静默跳过);`write-conflict` op;哈希链回放校验工具
  (bin 脚本,供人工审计)。
  **验证**: 驱动方式 = vitest 起 N=8 进程并发追加同 registry + 注入 kill -9 于
  写中;可观察结果 = 全部成功追加者链完整,被杀进程至多留一条 corrupt-tail 且
  下次开启 fail-loud;通过条件 = 链校验器对产物回放通过、异常路径有测试。
- **M4 — query digest → 子代理上下文注入样例**:digest 构造器(`compressed`
  档位:per-hypothesis 一行 + confidence + `asOfSeq`);示例委托脚本(用 13 的
  scoped provider 包装,把 digest 注入子代理 prompt);telemetry 不变。
  **验证**: 驱动方式 = 脚本化会话(`dsh --profile headless` + llm-mock,参照
  [12](12-eval-harness.zh.md) 接缝表的驱动姿势)起父子两级,父侧先写两条
  belief 再委托;可观察结果 = 子代理 system/user prompt 中含 digest 文本且
  `asOfSeq` 匹配父侧写入后 seq;通过条件 = 断言全过,13 未落地时降级为
  "直接拼 prompt 前缀"的手动样例(样例脚本同样过断言)。

## 验证计划

- **层一(纯函数)**:canonical 序列化稳定性、哈希链校验器、tombstone 投影
  (撤销/级联撤销/撤销已撤销)、档位映射判定、gate_ref 解析。
- **层二(单测)**:四工具各干路 + 所有拒绝路;telemetry op 名与 attributes。
- **层三(并发/崩壊)**:进程内 Promise 队列压力测试;跨进程 lockfile 并发;
  corrupt-tail 恢复。
- **层四(脚本化会话)**:headless + llm-mock 的幻觉注入演练(DoD 4)与 M4
  注入链路。
- 门禁命令:`pnpm typecheck && pnpm test`(worktree 内先
  `bash scripts/link-worktree-deps.sh`,见 CLAUDE.md)。

## 风险与开放问题

1. **lockfile 实现选型未定**(proper-lockfile 还是自管 fd `O_EXCL`):属实现,
   契约已写死"追加原子、全局有序"。检查项:M1 评审时定选型并写明 failure mode
   (stale lock、NFS)、加崩溃恢复测。
2. **backend 化的可能**:`storage-domain` 的单写链(`domain.ts:83-84` 的 RMW 语义)
   与 `domain/changed` 事件(events.ts:46)天然匹配 registry 的追加+广播需求;
   v1 选择自建 ndjson 的原因是 append-only 字节序对人工审计/外部冻结更友好
   (`storage-json` 为 whole-file snapshot,重写即失序)。开放问题:M3 之后是否
   提供可选 `storage-domain` backend(条目即 record,key=seq)。不做反向迁就。
3. **15/17 未着陆**:`source.kind = 'evidence_id' / 'run'` 两类指针在姊妹项落地前
   只能留 schema 与"解析失败即拒"的退化路径;联测在 M4 之后择机补(见 doc 20
   的 M4 同样顺延条款)。
4. **同 registry 的并发研究会话漂移**:digest 的 `asOfSeq` 只保证子代理**读到**
   时刻一致;并行父会话同写时,子代理回投的 belief_update 可能引用了已被撤的
   evidence。缓解:M3 的 write-conflict 遥测 + query 快照一致性文档;真正的
   read-your-writes 事务性超出 v1。检查项:M4 样例记录一次漂移场景观察。
5. **gate_ref 是时点快照而非终身保修**(与 doc 20 风险 5 对偶):cite 工件
   内容寻址、模板版本进 hash——同一论断重判会产生新 check_id,旧引用仍指向
   旧工件。registry 信念因此"过期而不自知"。缓解:query 投影可按需重跑
   verifier(可选参数),但 v1 不自动重验(成本与复现性,见 doc 20 风险 1)。
6. **tombstone 权限**:v1 任何写入者都可撤任何条目(研究小队内默认信任,
   审计靠链本身);若未来 registry 跨信任域,这里需要权限面,届时单独评审。

## 单元验收(Definition of Done)

- [ ] [auto] 编造证据的 belief_update 被拒:gate_ref 缺失、目标工件不存在、
  或其自报 tier 低于 claim_level 所需档位,三种注入各至少一例断言
  `gate-reject` op 与拒绝文案(M2)。
- [ ] [auto] 50 并发追加无交织损坏:链校验器回放产物,逐条 `prev` 校验、
  seq 连续、JSON 行完整;全局序可重放(M1/M3)。
- [ ] [auto] tombstone 撤销后 query 不含已撤信念:direct 与 cascade 两路
  (撤 evidence → 引用它的 belief_update 级联标记,hypothesis 的
  confidence 回落到残余证据所能支撑的最后值)(M1)。
- [ ] [auto] 幻觉注入演练:脚本化会话(headless + llm-mock,经
  [12](12-eval-harness.zh.md) 的驱动姿势)让 agent 被诱导直接口述
  "假设 H 已证实"而不调工具;断言 `registry_query` 中该假设信念未变,
  且会话里没有对应 `append` op(M4)。
- [ ] [auto] telemetry 词表契约:三个 op 的 attributes 精确断言(mock sink);
  sink `emit()` 非阻塞。
- [ ] [联测] 与 [20 citation-verify](20-citation-verify.zh.md) 端到端:
  真实 `cite://` 工件驱动的 belief_update 接受路径(DoD 对应 20 的 M4)。
- [ ] [manual] M3 崩溃恢复的真实进程 kill 手工复核一次(不止 mock);
  README graduation criteria 就绪。
