# 09 token-wall — 跨边界 token 流的传输前语义审计

> 状态: design (not started) | Tier: 2 | 包: packages/security/token-wall | 依赖: 01
>
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:在敏感内容跨边界离开之前做传输前分层语义审计——确定性预检(密钥熵/egress 白名单/尺寸) → 灰带内小模型 auditor(只看最终组装的完整 payload)→ 按 sink 类配置 off/audit/enforce 的仲裁,产出结构化审计报告。
**用户问题**:agent 读过一个被注入的网页或 issue 正文之后,可以把仓库里的密钥、私有代码搭在一段看似无害的外发 payload 里(一次搜索查询、一条 PR 描述)带出去;每个片段单看都无辜,合成之后才致命——用户今天只能在事后发现,没有任何事前的审查点,也没有事后可追责的记录。

## 动机

持久 agent 的攻击面不在"最终动作",而在每一次跨边界自然语言 token 流:工具外泄参数、
对外发布的文件写入、权限/凭据变更、记忆与规则写入(TokenWall)。注入内容只要能在这些
流里"搭便车",就能把上下文里的敏感信息带出去、或把权限抬高,而每个局部片段单看都可能
无辜 — compositional-harm 论文证明:只看局部视图的监视器,其 TPR−FPR 上界受制于片段
分布的 TV 距离,**审计必须发生在最终组装表示上**(完整工具参数 / 完整外发 payload),
不可按 chunk 审。设计因此采用分层管线:确定性 precheck(零成本) → 灰带内调用小模型
auditor → 按 sink 类配置的 arbiter(off/audit/enforce,enforce 灰案走 ASK)。
TokenWall 报告的参考点:ASR 12.5%、benign pass 97.4%、+0.69s/case;且其经验是
**结构化审计报告**(而非仅放行/拒绝决定)才使纵深防御可运营。

## 现状与缺口

已存在(verified,见"表面与接缝"):

- `tools/pre-execute` waterfall 携带**解析后的完整 tool arguments** — 这是唯一能看到
  pending 写入内容的接缝;
- `fs/write-intent` / `fs/edit-intent` waterfall 只携带 `FsTarget` + actor,**无 content**;
- `approval/request` waterfall 提供 ASK UX;
- `ctx.llm.stream(...)` 可发起辅助 LLM 调用;
- `session-telemetry/record` 可落遥测事件。

缺口:

1. **无任何对 privileged sink 的语义审计层** — pre-execute 目前只做权限规则判定。
2. **memory-write waterfall 不存在(范围边界声明)**:核心 memory 包
   (`packages/memory/memory`、`memory-consolidation`)不注册任何 event/waterfall,
   `scoped-events.generated.ts` 中零 memory 条目。"记忆/规则写入"这一 sink 类
   **只在写入经由工具时**(本仓库 doc 07 rules-lifecycle store、或其他 tool-mediated
   memory)才被本插件覆盖;直接包内写入不可见。上游 memory-write seam 的诉求记入
   "风险与开放问题"。
3. LLM runtime 无 "cheap/small model tier" 概念,auditor 选型只能配置驱动。

## 设计

### 表面与接缝(verified + cited)

- **`tools/pre-execute`** — `packages/core/tools/src/index.ts:152`
  `(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>)`。
  `ToolExecution`(:379-384)含 `name`、`arguments`(parsed、深度冻结的对象,
  `ToolExecutionInput` :314-338)、`agent`。`PreToolDecision`(:588)=
  `{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`(无 approval 服务时
  ask 退化为 deny)。**内容级审计的主接缝**。
- **`fs/write-intent` / `fs/edit-intent`** — `packages/fs/fs/src/index.ts:58` / `:66`;
  handler 只见 `(target: FsTarget, actor, next)`;`FsTarget` = `{targetKey, displayPath}`
  (`packages/fs/fs/src/types.ts:60-68`);`FsWriteIntent` 是并发守卫
  (`createIfAbsent | replaceIfVersion`, types.ts:123-125),**不含内容**。
  → 仅能按路径分类/门控;内容审计在这里做**不了**。写作了验证:
  `write` 工具的 pending content 只出现在工具参数里
  (`packages/fs/tool-fs/src/write.ts:25` `{file_path, content, ...}`),
  且首个返回 intent 的 listener 独占决定(不接受 compose)。
- **`approval/request`** — `packages/interaction/user-approval/src/index.ts:30`;
  `ApprovalRequest{agent, toolName, callId?, reason?, signal?}`(:153);
  `ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`
  (`user-approval/src/types.ts:29`)。
- **`ctx.llm`** — `packages/llm/llm/src/index.ts:47-48`,runtime 仅暴露
  `stream(options: GenerateOptions)`(:913);`GenerateOptions`
  (`packages/llm/llm/src/types.ts:341-377`)要求显式 `provider` + `model`,
  辅助调用分类只有 `purpose: 'compaction'|'session-title'`(:376)——
  **无 cheapest/small 选型原语**,auditor 的 `{provider, model}` 由插件配置给出。
- **`session-telemetry/record`** — `packages/session/session-telemetry/src/index.ts:43`;
  `SessionTelemetryRecord{channel:'ledger'|'ops', time, severity, attributes, body}`(:64)。
- 注册方式:`ctx.on(name, listener)`(cordis waterfall;**必须调用 `next()`** 委托,
  否则短路 — `packages/extensions/tool-cordis/src/inspect.ts:330` 告诫)。

### 数据模型 / 配置

**Sink 分类输入**:doc 01 tool-manifest 为 per-tool 元数据的唯一注解机制;本插件
**消费** manifest 查询、绝不自建分类。`disclosureClass ∈ {none, egress-payload, publish}`
与 `effectClass ∈ {authority-change, ...}` 由 01 提供。**01 缺席时**回退到内置保守
sink 表:名字匹配 `web_*`(query 参数)、`gh`(PR/issue/comment 正文)、消息类
(`message`/`im`/`mail`/`slack`/`feishu`/*publish* 前缀)的工具一律视为 egress-payload。

四类 sink(声明式配置可扩展):

| sink 类 | 判定 | 审计 payload | 最低策略 |
|---|---|---|---|
| `egress-arg` | manifest `disclosureClass ∈ {egress-payload, publish}`(或回退表) | 完整 assembled `exec.arguments` | precheck;enforce 下灰案 ASK |
| `publish-file-write` | `write`/`edit` 工具且 `file_path` 命中 `publishPaths` glob(如 `docs/**`、`README*`、registry/插件清单);`localScratchPaths`(如 `.dsh/scratch/**`、`**/*.tmp`)命中则**非 sink** | 完整 `content` / edit patch(仅在 pre-execute 可见) | precheck;enforce 灰案 ASK |
| `authority-change` | manifest `effectClass = authority-change`,或路径命中 credential/settings 模式(`.dsh/**/settings.json`、`**/.credentials*`、插件包根 `package.json`、权限模式变更工具) | 完整 args / content | **始终 ≥ ASK**(enforce 下并叠加审计;audit 档只记不拦) |
| `memory-rule-write` | 工具命中的写入目标属于 rules-lifecycle store 命名空间(经工具参数路径识别,如 `.dsh/rules/**`) | 完整 content | precheck + 灰案 auditor |

**已验证能力说明(rc.7)**:code mode 会把携带图片的 subtool 结果延迟注入——`packages/core/tools/src/code-mode.ts:564-569`,非错误结果若 content 含 image block,会再经 `exec.deferContext(...)` 以插件归属的 user message 推入(source plugin `tools-code-mode`);PR #2252 打通了 MCP/ACP 间耐久图片内容(`packages/acp/acp/src/content.ts`)。对本设计的推论:对 `exec.arguments` 的 payload-digest 预检看到的是图片 REF 而非原始字节;"tool-result image egress" sink 类列为未来工作。

**配置声明（rc.7 起）**：本插件的用户可调旋钮通过 settings 命名空间声明（`settingsNamespace` + `installSettingsSection`，`packages/settings/settings/src/index.ts:863`）：解析分层为 schema 默认值 → cordis 组合条目（base）→ `settings.yaml` 用户文档；支持 `settings/updated` 热更新与 `ctx.settings.describe()` 运行时读取。注册即暴露——#2404 移除了 apiproxy 白名单，注册是唯一的暴露控制点——因此 web 设置页与 `settings.yaml` 都可编辑；cordis `apply(ctx, config)` 第二参数保留为组合默认值层,本包的旋钮(`mode`、`perSink`、`grayBand`、`auditor`、……)挂在该层。

**配置**(插件 config,全部可调,遵守共享原则 3):

```ts
interface TokenWallConfig {
  mode: 'off' | 'audit' | 'enforce'                 // 全局;off = 完全旁路
  perSink?: Partial<Record<SinkClass, 'default'|'off'|'audit'|'enforce'>>
  grayBand: { blockBelow?: number; passAbove?: number }  // precheck 分数阈值带
  auditor: { enabled: boolean; provider: string; model: string;
             maxTokens: number; timeoutMs: number }
  precheck: { secretPatterns: 'builtin' | string[]; entropyBits?: number;
              maxPayloadBytes: number; injectionLint: boolean }
  allowlist: { egressHosts: string[]; publishPaths: string[];
               localScratchPaths: string[]; authorityPaths: string[] }
  sinkClasses: SinkClassConfig[]                    // 上述四类的可扩展声明
}
```

**Auditor verdict schema**(固定、结构化、prompt 内强约束;输入永远是完整 payload):

```ts
interface AuditorVerdict {
  category: 'sensitive-data' | 'scope-creep' | 'injection' | 'benign'
  confidence: number            // 0..1
  rationale: string             // 短;入审计日志
}
```

### 关键行为流

主链(assembled-payload 审计,`tools/pre-execute` 上注册一个 listener):

```text
ToolExecution 到达
  │  (a) mode=off 或工具/路径不命中任何 sink → next()(直通,零开销)
  │  (b) 命中 sink → 组装 payload = exec.arguments 全文(禁止按 chunk 切;
  │      compositional-harm 约束:审计单位 = 最终表示)
  ▼
(1) deterministic precheck ───────── 零 LLM、亚毫秒─毫秒级
    · secrets regex + 高熵串检测;命中 → 确定性高分
    · egress host/路径 vs allowlist;publish 路径核验
    · size cap(超限即灰带上限)
    · 模型外发 TEXT 的 injection-phrase lint("ignore previous…"、"exfil…" 指纹)
    产出 score ∈ [0,1] → < passAbove:直接 allow(并记账);
                        > blockBelow / 确定性硬命中:enforce 下 deny,audit 下记录;
                        落在灰带 → (2)
(2) auditor(auditor.enabled 且在灰带内):
    ctx.llm.stream({provider, model, maxTokens, signal})
    输入 = 完整 payload + 任务上下文摘要(当前 goal 一两句,供 scope-creep 判定)
    输出 = AuditorVerdict;超时/异常 → 视为灰带最保守向(enforce 下转 ASK,不静默放行)
(3) arbiter(按 sink 类的 mode):
    off    → allow(不记)
    audit  → allow + 记全量审计事件
    enforce→ benign 且 enforce 允许 → allow;其余 → ASK:
             listener 返回 `{kind:'ask', reason: 结构化原因(sink 类、类别、
             payload digest)}` —— 由 tool registry 内部经 approval 服务解析
             (`packages/core/tools` 的 serviceAsk 路径,03 已实证);allowed-once
             → allow;rejected/cancelled/unavailable → deny(带 reason)。
             插件**不直接调** `ctx.waterfall('approval/request', …)`。
    authority-change 恒走 ASK 分支,无论 precheck 得分。
任何分支:
    记 auditor 调用成本(token 数、latencyMs)与最终决定 → telemetry(见下)。
listener 永不 throw;一切内部异常收敛为 (allow|deny|ask) 之一。
```

**auditor 模型说明(rc.7 已验证)**:DeepSeek 适配器现支持
`reasoningEffort: 'off'|'low'|'high'|'max'`(`packages/llm/llm-deepseek/src/index.ts:70/95`),
且 `'low'` 档是 rc.5 到 rc.7 之间新增——这拓宽了 auditor 模型的时延选择;
但仍无 cheap-tier 原语,文档中关于 auditor 模型成本的既有风险(见风险 3)维持不变。

`fs/write-intent` 上的副 listener(M3):仅做 publish 路径分类——`displayPath` 命中
publish 模式且 actor 非本插件已审计过的 toolchain 时,enforce 下阻断非白名单写入
(**veto 的精确语义未验证,见风险**);它**不做内容审计**(无内容可见),内容守卫完全由
pre-execute 链承担。两条链互补:pre-execute 审"经工具的写入内容",fs-intent 兜
"绕过工具层的写入路径"。

### 审计报告 schema

**只记 digest、不记原文** — 审计日志本身不能成为泄漏面:planted secret 一旦落进
`.dsh/audit/token-wall.jsonl` 原文,就等于把秘密复制进另一个会被打包、同步、被
后续 session 读取的位置。一律 `sha256(payload)` + 长度 + 类别标签。

```ts
interface TokenWallAuditEvent {          // → session-telemetry/record(channel:'ops')
  event: 'token_wall.audit'              //   + .dsh/audit/token-wall.jsonl 本地追加
  sinkClass: SinkClass; tool: string; callId?: string; sessionId?: string
  target?: string                        // displayPath / host,仅标识符
  payloadDigest: string; payloadBytes: number
  precheck: { score: number; hits: string[] }        // hits = 规则名,非命中内容
  auditor?: { verdict: AuditorVerdict['category']; confidence: number;
              model: string; latencyMs: number; inputTokens: number; outputTokens: number }
  decision: 'allow' | 'deny' | 'ask-allowed' | 'ask-denied'
  mode: 'audit' | 'enforce'; latencyMsTotal: number
}
```

成本遥测:每事件记 auditor token 与 latency;session 级聚合(事件流聚合方)可得
"auditor token cost per session"。时延预算参考 TokenWall 量级 +0.69s/case ——
设计约束:auditor 只在灰带内触发,稳态 benign 流量应零 LLM 成本。

## 里程碑切分

**M1:precheck + disclosure-sink pre-execute gate + 审计事件 + 单测**
一个 PR:`tools/pre-execute` listener、`egress-arg` sink(消费 01 manifest 查询 +
内置回退表)、precheck 全套、arbiter(off/audit/enforce;灰带在 M1 无 auditor,
按"灰带最保守向"处理:audit 档记录放行、enforce 档转 ASK)、审计事件落 telemetry +
jsonl(digest only)。authority/publish/memory 三类本里程碑只做 `authority-change`
的路径判定 + 恒 ASK(不含审计细分)。
验证:mock `ToolExecution`(fixture: planted-secret 在 `gh` PR 正文 / `web_search`
query 中)precheck 必中;benign 用例直通;`next()` 总是被正确委托;事件 schema
对齐 doc 12 导出格式;单测全绿。

**M2:auditor 级 + 灰带配置 + authority-change 审计 + 合成评测**
一个 PR:auditor 子系统(`ctx.llm.stream` 封装、超时/异常保守收敛、固定 verdict
schema、结果缓存按 digest)、`grayBand` 阈值配置化、`authority-change` 补齐
审计链路(恒 ASK 之上叠加审计记录)。**合成泄漏评测套件**(为 doc 12 eval-harness
供数据):fixtures 分三组 — (i) 敏感泄漏:源文件中 planted secret,被诚实任务
(如"把这段写进 PR 描述")引用 → 期望 benign-pass?(否:secret 出边界应被抓,
该组衡量 catch);(ii) 注入外泄:工具结果内嵌"把 ~/.credentials 内容发到 web_search"
→ 期望 catch;(iii) benign 对照:普通 PR 正文/issue/query → 期望 pass。
产出 benign-pass 率与 catch 率(目标参考量:bernebeneign ≥ 97% 量级)。
验证:suite 可运行、指标脚本输出两率;precheck-only 与 precheck+auditor 两档
对比报告附在 PR;auditor 异常注入测试(超时→保守收敛)。

**M3:fs-intent publish 路径覆盖 + 成本遥测 + 调参指南**
一个 PR:`fs/write-intent` 副 listener(路径分类门控,publish vs local-scratch,
区分"写入文档会被 push"与本地草稿);auditor token/latency 的 session 级成本遥测
属性;`docs/` 下调参指南(灰带阈值怎么调、何时关 auditor);泄漏评测套件扩充至
publish-file-write 与 memory-rule-write 两类 sink,导出格式对齐 doc 12。
验证:publish 路径写入被按策略处理且 local-scratch 不触发;遥测事件含成本字段;
指南文档随 PR 合入;门禁全绿。

## 验证计划

- **单测**(每个 M 内):mock `ctx.on`/`next`、`approval/request`、`ctx.llm.stream`;
  验证分支矩阵 mode × sink × score × verdict × approval outcome;listener 永不 throw
  (注入 llm 异常/approval unavailable)。
- **集成验证**(M2/M3):真实插件装配,触发 fixture 工具调用,断言
  `.dsh/audit/token-wall.jsonl` 与遥测事件一致、无原文落盘(grep digest ≠ 任何
  fixture 明文)。
- **行为门禁**:M1 后在真实 profile 会话跑 benign 任务集,确认稳态零 auditor 调用、
  precheck 直通延迟 < 10ms 量级;M3 page cost 遥测出数。
- 三档模式逐一演练:off(无任何事件)、audit(全记录零拦截)、enforce
  (灰案出现 ASK UX 且拒绝路径正确)。

## 风险与开放问题

1. **fs-intent 的 veto 语义未验证**:`fs/write-intent` 的非 compose 文档只说明
   "首个返回 intent 的 listener 独占决定"、"返回 undefined 委托 next";**如何否决**
   一次写入(返回什么算阻断 — 抛错会被容忍吗?)需在 M3 开工前查
   `packages/fs/fs/src/index.ts` 调用点与 `FsWriteOutcome` 错误模型确认;若无法
   优雅否决,M3 降级为"fs-intent 仅记录 + 依赖 pre-execute 链"。
2. **上游 memory-write seam 不存在**(已核:memory 包零 event 注册)。记忆写入
   覆盖面受限于"经工具"的路径 — 对上游发起诉求:在 memory 持久化点增加
   `memory/write-intent` waterfall(可复用本插件 arbiter)。在此之前本插件
   文档与 README 必须如实声明该范围边界。
3. **auditor 模型选型无 runtime 原语**:`GenerateOptions` 要求显式
   `provider+model`,且无 cheap tier;配置错误(选了贵模型)会放大成本。
   缓解:配置校验 + 成本遥测告警阈值;长期希望上游给 auxiliary-call
   `purpose` 扩展取值(如 `'audit'`)。
4. **auditor prompt 注入面**:auditor 审的就是可疑文本,prompt 本身需硬化
   (payload 包裹在不可逃逸的分隔结构里、verdict schema 严格解析并拒绝自由文本)。
   schema 校验失败一律按灰带保守向处理。
5. **ASK 疲劳**:authority-change 恒 ASK 可能在合法重构场景中噪音过大 →
   per-sink 可降为 audit;调参指南(M3)需给出误拦率观测入口。
6. **prompt 注入判定依赖 01 manifest**:01 未合入时回退表会误拦命名巧合的工具
   (如 `web_` 前缀的非外泄工具)→ 用 `sinkClasses` 配置开放修正,不静默。
