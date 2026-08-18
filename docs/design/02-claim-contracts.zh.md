# 02 claim-contracts — 声明与输出契约准入层

> 状态: design (not started) | Tier: 1 | 包: packages/verification/claim-contracts | 依赖: 01 tool-manifest

## 设计目标与用户问题

**目标**:在工具结果进入上下文、助手声明到达用户之前做代码级准入校验(schema 形状/新鲜度/出处/领域规则),并在轮末对助手声明做"supported / unsupported / unverifiable"三态审计。
**用户问题**:用户无法信任 agent 的自述——"文件已创建""测试已通过"可能纯属编造,或建立在残缺、过期的工具结果上;脏数据一旦进入上下文就静默污染后续所有推理,错误要到很下游才暴露,而提示词层的"请诚实"从来不是承重墙。



## 动机(为什么必要 — 三层栈缺的一层)

三层验证栈的三个面互相不可替代:01 tool-manifest 是 per-tool 元数据基座,
03 trace-contracts 管「轨迹合不合法」,本工作项管最后一层 —「产出像不像真的」:

1. **工具结果准入(tool-result admission)**:一个 tool 调用即使参数合法、执行没抛
   异常,其结果仍可能不满足组合契约 — 形状残缺、数据过期、缺少出处字段、或违反
   领域规则(bash 结果没有 exit code;读不存在的文件却以空字符串静默成功)。下游
   步骤会在坏结果上继续推理,这就是「silent failure → wrong narrative」的源头。
2. **助手声明卫生(assistant-claim hygiene)**:turn 结束时的自然语言总结
   「已创建文件 X」「测试全部通过」「PR 已提交」可能与会话里真实发生的事件不符。
   没有任何机制把声明与证据对账。

文献锚点与对应设计立场:

- **Prompts-to-Contracts**:契约以代码持有(manifest + schema + validator)优于纯
  prompt 指令;且相比 bolt-on guardrail 有更少的 over-refusal — 所以准入失败的反馈
  必须是**可行动的 corrective feedback**,不是笼统拒绝。模型只拥有可替换的组合边界,
  契约的判定权永远在代码。
- **Forethought**:typed primitive 配局部契约检查,在产出处就近拦截,而不是事后审计。
- **EG-VAR**:model proposes、确定性 verifier admits;**没有证据链时走 abstain +
  audit trail,而不是判违规** — `unverifiable ≠ violation` 是本层的硬语义。

为什么必须是 code-owned admission 而不是 prompt 指令:prompt 指令是「请求模型自律」,
契约是「harness 在缝上判定」。前者随上下文稀释、被注入覆盖、无法审计;后者每次调用
都执行、产生带 validator id 的遥测、且强度可调(doc 00 原则 3)。

## 现状与缺口

上游已具备全部承载缝(均在下方「表面与接缝」逐项核实):`tools/post-execute`
waterfall 的 `PostToolDecision` 已支持 `block + feedback` 纠错通道与结果替换;
session event 流携带 `assistant/message`、`tool/result` 等全量事件并带单调 `seq`;
`session-telemetry/record` waterfall 与 ops channel 存在;`agent/turn-stopping`
串行 hook 存在。按 doc 00「现状已覆盖」清单,cc-plugins 与本仓库均无 claim/契约
准入实现。缺口因此精确为两点:

- **没有任何 post-execute 结果的跨字段/跨域契约校验**:registry 自身只校验入参与
  工具自定义 output schema;新鲜度、出处、领域规则无人管。
- **没有任何 assistant 声明与证据的对账机制**,也没有相关遥测词汇。

## 设计

### 表面与接缝(exact names + verified paths)

以下每条均在上游源码核实,未核实的条目只出现在「风险与开放问题」。

1. **准入缝 — `tools/post-execute` waterfall**
   `packages/core/tools/src/index.ts:175`:
   `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>`。
   插件以 `ctx.on('tools/post-execute', handler)` 注册。
2. **判定类型 — `PostToolDecision`** 同文件 `:596-600`:
   `{kind:'accept'; content?|value?; additionalContexts?}` 两条变体 +
   `{kind:'block'; feedback: ContentBlock[]; additionalContexts?}`。
   消费点 `postExecute()`(:1742-1781,已核实):`block` 把结果替换为
   `{content: feedback, isError: true, error: {message}}` — 即模型看到的就是
   feedback 文本(recovery-friendly);`accept+content` 替换 content、
   `accept+value` 替换 value(会对工具自身 output schema 重校验,失败结果不允许
   替换 value;两者不可同时替换)。行为同时由测试钉死:`tests/tools.spec.ts:856-872`
   (「can replace the result content」「block turns the call into an isError with
   corrective feedback」)。注意:listener 抛异常会被兜成 isError(:1740 注释)—
   我们的 handler **必须永不 throw**,否则丢失 actionable feedback;且 block 会丢弃
   工具 defer 的 context,只保留 block 决定自带的 `additionalContexts`。
3. **结果形态 — `ToolExecutionResult`** 同文件 `:556-580`:成功载
   `value: JsonValue + content: ContentBlock[]`,失败载 `error: ToolFailure`;
   validator 优先读结构化 `value`,`meta` 可作领域辅助。
4. **声明审计缝 — `session/event` observer**
   `packages/core/session/src/index.ts:76`:
   `(session: Session, event: SessionEvent) => void`(纯 observer,无返回值)。
   事件载荷 `packages/core/session/src/types.ts:243-297`:`assistant/message`
   `{turn, step, message, usage?}`、`tool/call` `{turn, step, callId, name, arguments}`、
   `tool/result` `{turn, step, message, error?, meta?}`、`turn/end {turn, reason}`
   (`TurnEndReason` 枚举 `:155-177`:completed/aborted/blocked/error/max-tokens/
   interrupted)。事件信封 `:415-447` 带 `seq`(会话内单调)、`time`、
   `sourceEventSeqs`- 证据引用直接用 seq 表达。消费范式见
   `packages/core/agent-loop/src/runtime-context.ts:46`。
5. **遥测缝 — `session-telemetry/record` waterfall**
   `packages/session/session-telemetry/src/index.ts:43`,
   record 形状 `SessionTelemetryRecord` 同文件 `:64-`(`channel: 'ledger'|'ops'`、
   `severity`、`attributes`、`body`),sink `emit()` 为非阻塞 enqueue(:104)。
   本插件的判定/声明旗标走 **ops channel**,不落 session log(见风险 3)。
6. **steer-back 缝(里程碑门控,非 v1)— `agent/turn-stopping` 串行 hook**
   `packages/core/agent-loop/src/agent.ts:296`。doc 00 原则 2:只能以带插件归因的
   user 消息续轮,listener 永不 throw。
7. **配置落点 — `.dsh/contracts/*.yml`**:与上游 project 级约定一致
   (`packages/skill/skill-filesystem/src/index.ts:246` 的 `<projectRoot>/.dsh/skills`,
   source `project-dsh`)。

### 数据模型 / 配置(contract + validator schema, modes)

契约文件(YAML,每文件一条,`.dsh/contracts/*.yml`;内置契约随包携带同名格式):

```yaml
id: fs-read-missing-file        # 全局唯一,遥测引用之
version: 1
tool: fs/read                   # 工具名或 glob;经 doc 01 manifest 按名解析
validator: domain               # json-schema | freshness | provenance | domain
mode: enforce                   # off | audit | enforce(可被更高层配置覆盖)
when: { result.isError: false } # 适用谓词,仅对命中结果运行
checks: ...                     # kind 专属参数(见下)
feedback: |                     # block 时注入给模型的可行动反馈模板
  fs/read 目标 {{args.path}} 不存在:先用 fs/list 确认,或创建后重试。
```

validator 四类(kind 决定 checks 参数):

- `json-schema`:结果 `value` 须满足的 JSON Schema(Prompts-to-Contracts 基座)。
- `freshness`:结果中某 mtime/timestamp 字段须落在 ttl 内,或与当前 fs mtime 一致
  (防陈旧缓存被当作现状)。
- `provenance`:必须携带的出处字段清单(如 `sourceUrl`、`path`、`fetchedAt`)。
- `domain`:命名规则实现(registry 内按 id 查找),面向不属于前三类的硬约束。

mode 解析顺序(SafetySentry 可调旋钮,doc 00 原则 3):
契约文件字段 > validator 类默认 > 全局默认(`audit`)。`off` 完全短路;
`audit` 照常 `accept`/`next()` 但发遥测;`enforce` 走 `block + feedback`。

声明审计侧(不占契约文件,由 pattern library 配置):一条 pattern =
`{id, match(正则/意图模板,中英双语), evidence 查询 spec}`。evidence spec 描述
支撑证据的检索面:本 turn 的 `tool/call`/`tool/result` 事件对(按 callId 配对、
成功即 isError=false)+ 需要时的只读 fs 断言(文件存在)。每条产出旗标:

```ts
type ClaimFlag = {
  plugin: 'claim-contracts'      // 归因(doc 00 原则:观测带 provenance)
  patternId: string
  claim: { text: string; turn: number; sourceSeq: number } // 出处 seq
  verdict: 'supported' | 'unsupported' | 'unverifiable'    // abstain 是判定,非违规
  evidence: { eventSeqs: number[]; fsFacts?: string[] }    // 可空
  mode: 'audit' | 'enforce'      // v1 恒为 audit
}
```

### 关键行为流(post-execute admission flow; claim-audit flow; abstain path)

**准入流(每次工具调用)**:`tools/post-execute` handler 收到 `(exec, result)` →
按 `exec.name` 查 doc 01 manifest + `.dsh/contracts/` 得适用 validator 列表 →
逐个执行(纯函数;只允许只读 fs stat,禁止副作用)→
全过则原样 `next()`;失败时:validator 自身的 bug 与「契约不满足」分开 —
前者记 `{severity:'warn'}` ops 遥测并 fail-open(默认按 audit 放行),后者按 mode:
`audit` → `next()` + ops 遥测 `{telemetry.op:'claim-contracts/admission',
attributes:{validator.id, tool, verdict:'rejected', mode}}`;
`enforce` → 返回 `{kind:'block', feedback: ContentBlock[]}`(feedback 含 validator
id 与可行动修复指引)+ 同一遥测。handler 全程 try/catch,永不 throw。

**声明审计流(v1 审计专用)**:`session/event` observer 维护 per-turn 缓冲
(本 turn 的 assistant/message 文本、tool/call+result 对);在 `turn/end` 且
`reason.kind==='completed'` 时:取最终 assistant 文本 → pattern library 抽取
可核查声明 → 逐条按 evidence spec 对账(优先事件 seq,必要时只读 fs)→
每条发一个 ops 遥测 flag(结构如上,`severity`:unsupported 用 `warn`,其余 `info`)。
turn 以 aborted/error 结束则整轮跳过(声明不成立的环境,不做判定)。v1 不改变任何
模型可见面。

**abstain 路径(EG-VAR)**:证据既不足以支持也不足以否定时,verdict 必须为
`unverifiable` 且在 evidence 里写明缺失链路(如「无配对 tool/result,fs 断言不适用」)。
`unverifiable` 永不计入违例率,只计入覆盖率指标 — 这为 doc 12 的 eval 导出预留了
「多少声明其实不可核查」的读数。

**steer-back(里程碑门控,默认关闭)**:当 claim 侧 mode 提到 `enforce` 时,在
`agent/turn-stopping` 注入带 `[claim-contracts]` 归因的 user 消息,附上 unsupported
声明清单,要求模型逐条出示证据或撤回。只在 M3 之后以实验 flag 开启,需要单独的
真实会话观察记录才可转正(doc 00「无观察不声称」)。

### 内置 validator 清单(initial pack with justification)

1. `json-schema-shape`(generic):凡契约给 schema 的工具结果先过形 — 成本最低、
   覆盖面最大,是其余 validator 的前置。
2. `bash-exit-status`(domain):bash 类结果必须带结构化 exit code;缺之则 block —
   「命令跑了但成败未知」是 wrong-narrative 的头号来源。
3. `fs-read-missing-file`(domain):fs/read 击中不存在路径时必须表面化为结构化
   isError(ENOENT),不允许空内容静默成功。
4. `result-freshness`(freshness):声明「最新/当前」语义的读取类结果,mtime 超出
   ttl 即拒绝(或 audit)。
5. `provenance-required`(provenance):代表外部获取的结果必须带
   `sourceUrl`/`path`/`fetchedAt` — 出处缺失即不可审计。
6. claim patterns(audit-only):`file-created`、`command-ran`、`tests-passed`、
   `pr-opened` 四类 — 高频且 each 都有明确证据面(配对的 tool 事件或 fs 断言)。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 可观测标准)

- **M1 — validator registry + post-execute 准入 + ≥3 内置 validator + 单测(mock
  pipeline)**:registry(kind→实现)、契约加载(内置 pack 先行,`.dsh/contracts/`
  可留 M3)、准入 handler、遥测;内置 `json-schema-shape`、`bash-exit-status`、
  `fs-read-missing-file`。
  **验证**:mock pipeline(参照 `packages/core/tools/tests/invariant.spec.ts:54` 的
  `ctx.waterfall` 直驱法)下 — enforce 时 bash 无 exit code 的结果被替换为
  isError 且 feedback 含 validator id;audit 时结果原样通过且产生一条
  `claim-contracts/admission` ops 遥测;handler 抛错路径被兜住不 throw。
- **M2 — assistant-claim 审计 observer + 遥测旗标 + 合成会话测试**:per-turn 缓冲、
  pattern library(上述四类)、turn/end 触发、旗标发射。
  **验证**:合成会话 A(assistant 声称「测试通过」但本 turn 无任何 bash
  tool/call)→ 产出 `unsupported` 旗标,`evidence.eventSeqs` 为空、
  `claim.sourceSeq` 指向该 assistant/message;合成会话 B(声称内容无 pattern 命中)
  → 零旗标;合成会话 C(证据面不足)→ `unverifiable` 且不计违例。
- **M3 — mode 配置解析 + contract pack 示例 + 文档**:off/audit/enforce 三级覆盖链、
  `.dsh/contracts/*.yml` 加载与 schema 校验、README(含 graduation criteria 一节)。
  **验证**:全局 `off` 时 M1/M2 行为全部静默;单 validator 提到 `enforce` 而全局
  保持 `audit` 时只有它产生 block;非法契约文件拒绝加载并报出行号。
  (steer-back 不在 M1–M3;按上文门控单独立项。)

每个 M 独立可合入:M1 只新增准入面、M2 只新增观察面、M3 只新增配置面,互不改名
既有 API。

## 验证计划

- **层一(纯函数)**:各 validator 对构造的 `ToolExecutionResult` 表的输入输出;
  mode 解析矩阵单测;契约 schema 校验(含坏 YAML/缺字段)。
- **层二(mock pipeline 集成)**:按 `invariant.spec.ts` 模式构造 ctx + waterfall,
  断言 accept/block/telemetry 三支路;fail-open(validator 自身异常)单独一例。
- **层三(合成会话)**:构造 `SessionEvent` 流喂给 observer(与上游
  `runtime-context.ts:46` 相同的消费姿势),断言旗标集合。fs 断言用临时目录。
- **层四(实跑观察)**:在真实 profile 下以全局 `audit` 跑 ≥ 若干会话,人工抽查
  ops 遥测中的 rejection 是否误拦(为毕业标准的遥测证据积累数据)。
- 门禁命令:`pnpm typecheck && pnpm test`(若在 worktree 中,先
  `bash scripts/link-worktree-deps.sh`,见 CLAUDE.md)。

## 风险与开放问题

1. **doc 01 尚未成文**(`docs/design/` 目前只有 `00-overview.md`):manifest 的
   按名 lookup API 形状未定。缓解:本文档只依赖「按工具名查契约」这一契约式约定;
   若 doc 01 延期,M1 可先仅用 `.dsh/contracts/` + 内置 pack 落地,接入点保持
   一个函数(`resolveValidators(toolName)`),后续换实现。检查项:doc 01 评审时
   核对 lookup 签名。
2. **遥测发射把手的获取路径部分未核实**:waterfall 签名(:43)与 sink `emit()`
   (:104)已核实,但插件在运行时拿到 coordinator/emit 入口的服务注册名未核实。
   检查项:`grep -rn "session-telemetry" packages/*/src --include="*.ts"` 找
   coordinator 的 service 注册与现有 ops record 生产者(如 feedback 包)的接法。
3. **自定义 session event 类型暂未开放**:`known-event-types.ts` 头部注释明确
   「downstream plugin events … a registration surface is deferred」。因此 v1 旗标
   只走 telemetry ops,不落 session log;doc 12 eval 导出若需要持久化旗标,届时
   重估(检查项:上游是否出现事件注册面)。
4. **声明抽取的误报**:自由文本(尤其中英混排)的 pattern 命中可能错认声明。
   缓解:pattern library 保守化(只匹配确定断言句式),`supported` 仅在存在正面
   证据时给出;覆盖率与违例率分开统计。检查项:M2 层四人工抽查误报率。
5. **turn 结束的 fs 检查成本**:限定为 pattern 需要的最小 stat 集合;禁止递归遍历。
   若实测拖慢,降级为「无事件证据即 unverifiable」(检查项:perf 预算待定)。
6. **block 语义的误用风险**:契约失败 block 是 recovery-friendly 的(feedback 即
  下一轮输入),但 validator 自身 bug 若走错支路会造成重复拒绝。已在设计中分开
   (fail-open + warn),M1 验证标准包含该路径。

---

*Verified seams(路径:行号均已在 2026-08 核读)*:`packages/core/tools/src/index.ts`
:175 / :556-600 / :1742-1781;`packages/core/tools/tests/tools.spec.ts:856-872`;
`packages/core/session/src/index.ts:76`;`packages/core/session/src/types.ts`
:155-177 / :243-297 / :415-447;`packages/session/session-telemetry/src/index.ts`
:43 / :64- / :104;`packages/core/agent-loop/src/agent.ts:296`;
`packages/core/agent-loop/src/runtime-context.ts:46`;
`packages/skill/skill-filesystem/src/index.ts:246`。
