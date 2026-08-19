# 13 subagent-context-scope — 子代理按需上下文边界(spike 先行)

> 状态: spike 已完成(结论: **feasible-plugin**,证据见下) | Tier: 3 | 包: packages/agents/subagent-context-scope(M0 判定:可行)| 依赖: 无(上游 `deepseek-harness` 提供全部接缝;doc 01/12 只做运行时可选集成)
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给派生子代理加上按需上下文边界——注册 scoped-fork / scoped-spawn provider 包装,按角色 policy 只携带必需的 prompt section、工具子集、记忆范围与 goal 子集;配泄漏度量 harness(合成干扰秘密场景)供 12 消费。
**用户问题**:今天派一个子代理 = 把父会话的全部见闻——无关任务的讨论、探过的密钥、其他角色的中间推理——原样拷贝给它;子代理被干扰项带偏、答案质量掉,用户为两份上下文付双份 token,还多背一个信息泄漏面,而这一切没有任何配置入口。

## 动机(PerspectiveGap 数字 + 为何默认全貌拷贝是错的)

PerspectiveGap 测量了多代理 prompt 编排中的信息泄漏:把干扰项/越权信息灌进角色
上下文后,110 个场景 × 10 种拓扑上,组合通过率平均仅 14.9%,最强模型也只有 62.0%,
平均总体泄漏率 246.5%(泄漏内容被复制放大)。结论方向一致指向同一条独立可测的轴:
**need-only context boundary** —— 每个角色只该看到完成任务所必需的上下文切片。

PatchOptic 的 projected read(每步只见与自己相关的投影子视图)与 Formal Hierarchical
Architecture 的 manifest 驱动懒发现(每步 prompt 只加载当前节点的子 manifest)是同一
经济性在委托树上的体现。

dsh 的默认行为恰好是反例:`fork` provider 把父会话"已完成 turn 前缀"**整体拷贝**进子
会话(`completedTurnPrefix`,见 Q1)。父会话里积累的无关任务、探过的密钥、其他角色的
中间推理,全部成为子代理的干扰项与泄漏面。默认全貌拷贝在工程上省事(种子可直接重放),
在质量与安全上都错:它优化了"子代理能重放父历史"这个几乎没人要的性质,牺牲了
"子代理只见所需"这个 PerspectiveGap 证明值钱的性质。

## M0 Spike:可行性调查

**本 spike 已在写作本文档前由作者实际执行**(直接读上游源码,非转述)。结论先行:
"critical context"中的担忧(插件无法控制子代理上下文)**被代码证据推翻** —— fork/
provider 接缝把种子字节、prompt、工具集、persona 的决定权全部交给了 provider,而
provider 注册表对第三方插件开放。唯一真实的限制:`ctx.sessions.fork` 是 session 级
纯切片 seam(与 subagent 种子无涉),one-shot 子代理的 creation window 没有插件钩子
(可在 M1 用公开 API 自行组驱动绕过,见 Q2)。

rc.7 关于已发布外部 provider 的注记:`subagent-claude-code` 与 `subagent-codex`
在 rc.7 获得了 `run_in_background`(Job registry 支撑:`backgroundMode: 'one-shot'`;
显式 `true` 返回父代理持有的 Job id,经 `job_output`/`job_kill` 消费),且二者均为
显式 OPT-IN 挂载——生产 dsh 不安装它们(`apps/cli/config/agent-presets/standard/agent.cordis.yml`
中 `disabled: true` 工具行及 "Production dsh does not install these optional providers" 注释)。

### Q1: 子代理 spawn 时拿到什么上下文?覆盖点在哪?

**fork 路径(进程内 fork)**:
`packages/subagent/subagent-fork-in-process/src/index.ts:48-54` —— `completedTurnPrefix(parent)`
把 `parent.session.events` 切到最后一个 `turn/end` 为止(进行中的 turn 不平衡、不可
重放,故排除),作为 `{seed}` 传给 `startInProcessRun`。**种子的内容、边界完全由
provider 计算**,service 层不参与挑选。
`SubagentProvider.inheritsParentContext = true`(同文件 :64)只是面向模型文案的描述位。

**spawn 路径(provider 直生)**:
`packages/subagent/subagent-spawn-in-process/src/index.ts:48-53` —— 不传 seed,子代理全新
(自己的 session、自己的 system prompt、零父上下文)。

**两条路径汇合于** `packages/subagent/subagent-in-process-driver/src/index.ts:102-148`
`startInProcessRun(request, {seed})`:解析深度 → 捕获委托策略(approval 钉死 `'never'`)
→ `parent.ctx.agents.create({sessionId, meta, seed, agentOptions, signal, setup})`,其中
`setup(childCtx)`(:120-130)调用 `applyChildComposition`:
`packages/subagent/subagent/src/child-agent.ts:163-174` ——
(1) `agentPresets.composeFrom(childCtx, parent.ctx)` 加入父 preset;
(2) 注册 `subagent:delegation` 运行期上下文(order 120);
(3) 有 `persona` 则注册同名 `deployment:persona` scoped section **遮蔽**部署 persona(`:171-172`);
(4) 有 `toolFilter` 则 `childCtx.tools.restrict(...)`(`:174`)。

**请求级覆盖点**(`SubagentStartRequest`,`subagent/src/types.ts:100-149`),每项都有
capability 门(`SubagentRuntime.assertCapabilities`,index.ts:481-496):
`prompt`(子代理 user 消息,整体可换)、`agentOptions`(provider/model/maxTokens)、
`toolFilter`(ToolRestriction)、`persona`、`outputSchema`、`maxDepth`、`label`。

**`ctx.sessions.fork(source, boundary?)`**(`packages/core/session/src/index.ts:1081-1138`)
是另一条 session 级 seam:**只有 boundary 纯切片**(连续前缀、不得落在开放 turn 内),
不支持内容投影。注意:subagent fork provider **没有用它**,而是自己切片传 seed —— 这
恰恰是插件的机会。

**seed 合法包络**(`core/session/src/index.ts:508-547`):`seq` 从 0 连续、lossless JSON、
信封合法、request header 受支持、逐事件过 `surfaceManager.validateNext`。⇒ **内容级
投影的 seed 可表示**:删除事件后重编 seq、保持 turn 配平即可通过同一校验。事件深冻结,
投影 = 构造新事件对象(snapshot 路径本来就接受全新 JSON 值)。

### Q2: 第三方插件能否包装/替换 subagent provider?

**能,且已有shipped先例。**
- 注册 API:`SubagentRuntime.registerProvider(provider)`
  (`subagent/src/index.ts:369-385`)—— 命名注册表,cordis effect 作用域(卸载即注销),
  重名抛 `DUPLICATE_PROVIDER`;`getProvider(name)`(:392)供包装者解析被包对象。
  对照 bash seam 单实现互斥,这里**显式设计为多 provider 共存**(index.ts:8-10 头注)。
- 先例:`dsh-cc-plugins/packages/compat/cc-plugin-loader/src/agents.ts:40-90` 的
  `AgentProvider` 正是"包装 provider"——按 agentType 注册,`start` 时先
  `resolve('fork')` 再覆盖 `prompt`/`agentOptions.model`/`toolFilter` 后转发。
  (仅作形态证据引用;本包编译期不依赖 dsh-cc-plugins,共享原则 1。)
- 选择机制:模型侧工具 `tool-subagent` 的 `Config.provider: string`
  (`subagent/tool-subagent/src/index.ts:30,81-82`)决定委托落到哪个注册名;部署把
  名字指到包装 provider(如 `scoped-fork`)即生效,无需改上游。

**provider 接口暴露的上下文控制杆**:
- 包装转发(改 request):`prompt` 改写/替换、`agentOptions`、`toolFilter` 与请求值
  **相交**(restrict 语义天然收窄)、`persona` 遮蔽、收紧 `maxDepth`。
- 历史投影:接口上没有声明式字段,但包装者可以**不转发给 stock fork**,改为公开导出的
  `startInProcessRun(request, {seed: 自算投影种子})`(driver 是公开包)——fork 的种子
  计算只有 7 行,重实现并加过滤器即成投影。
- 更深的 creation-window 组曲:`dsh-subagent` 公开导出
  `applyChildComposition / captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides /
  childSessionMeta / resolveChildAgentOptions / resolveChildDepth / settleRun /
  finalAssistantOutput`(index.ts:72,101-111)——自行 `ctx.agents.create({setup})` 组
  one-shot 驱动(约百行生命周期代码)可在 childCtx 里追加任意 scoped section 遮蔽。
- continuable 子代理:provider 只贡献 `{seed}`(`prepareContinuable`,types.ts:323),
  组曲归 continuation manager;但 deployment 插件有显式和弦
  **`SubagentRuntime.registerContinuableSetup(contribution)`**(index.ts:286-292),对
  每个 continuable 子的新建与冷恢复 creation window 生效。

### Q3: `agent.ctx` 作用域能否按 agent 切服务/prompt-section 薄片?

**能,这是结构能力而非巧合。**
- `SystemPrompt` 用 `ScopedLayers`(`core/system-prompt/src/index.ts:347`);
  `section()/context()` 经 agent 的 `childCtx` 注册即按名遮蔽全局同名片(:375 注释
  明示"A scoped section shadows a global section with the same name",签名在 :381);重名错误消息直接
  指路 `agent.ctx`(:317)。**遮蔽为空文本 ≈ 删除**:`renderPrompt` 丢弃空 section
  (:212-217)。`suppressRuntimeContext()` 同样 effect 作用域(:415)。
- `tools.restrict()` **强制要求 scoped context**,全局调用直接抛错
  (`core/tools/src/index.ts:1074`)——`agent.ctx` 切片是一等公民。
- preset 加入是 scope 重挂:`composeFrom(childCtx, parentCtx)`
  (`preset/agent-presets/src/index.ts:316-325`);自定义 provider 亦可给子代理
  `mount()` 另一个 preset,即"子代理跑在与父不同的组曲上"。

### 三结局应急表

| M0 结局 | 走向 | 触发情况 |
|---|---|---|
| **feasible-plugin(实际命中)** | 全部杆件插件化,无需上游改动 → 执行下述 M1/M2 | Q1-Q3 证据成立(已成立) |
| needs-upstream(未触发,预存) | 提交上游 issue 并 park。预存议题:在 `SubagentStartRequest` 增加声明式 `historyProjection`(keep 谓词/turn 保留策略,service 校验后传给 session 级种子构造);为 one-shot 子代理增加 `registerOneShotSetup(contribution)`(对齐 continuable 已有的 `registerContinuableSetup`,index.ts:286);两者均为 additive、不破坏现 capability 语义 | fork 种子被证明不可由 provider 控制,或 registerProvider 不对插件开放 —— 证据已否定两者 |
| partial(未触发,预存投影退路) | 插件先ship:L1 prompt 改写、L2 agentOptions、L3 toolFilter 相交、L4 persona 遮蔽(纯包装转发即可达成);升级为上游 issue:one-shot creation-window 钩子(若 M1 决定不维护自组驱动,见风险 R1) | 自组 one-shot 驱动的维护成本被评审判定超过收益 |

## 设计(按 spike 结论条件化;provider wrapper 形态;context policy schema)

总形态:**包装 provider + 角色级 context policy**。插件注册 `scoped-fork` 与
`scoped-spawn` 两个 provider(包装 stock `fork`/`spawn`),部署经 `tool-subagent`
的 `Config.provider` 指过来。每次 `start`,wrapper 按请求解析角色(laze 顺序:显式
`label` 匹配 policy 名 → `persona` 文本哈希 → 默认 policy),应用该角色的 policy,
再决定转发或自算种子。

### 表面与接缝(只写已验证的)

- `ctx.subagents.registerProvider / getProvider`(index.ts:369,392)——注册与解析。
- `ResolvedSubagentStartRequest`(types.ts:155-158)——可改写字段见 Q1。
- `startInProcessRun(request, {seed})`(subagent-in-process-driver/src/index.ts:102)
  + 自算投影种子——历史投影的唯一正确入口(stock fork 的种子在 provider 内部计算,
  包装转发改不到它)。
- `child-agent.ts` 全部组曲函数为公开导出(index.ts:102-111)——自组驱动时复用,
  不复制逻辑。
- continuable 侧:`registerContinuableSetup`(index.ts:286-292)。
- 泄漏观测:run 句柄带 `localAgent`(types.ts:257-261),harness 可直接读
  `child.session.events` 与 child 组装出的 system prompt,无需新观测通道。
- 三档执行强度 `off / audit / enforce`(共享原则 3):`audit` 档只记录
  "若 enforce 会剪掉什么",不改写请求。
- 工具外泄分类一律走 doc 01 tool-manifest 的注解机制(共享原则 4),本包不另造 per-tool
  元数据;doc 01 未落地时 policy 内联 `secretPatterns` 兜底。

### 数据模型 / 配置

```
ContextScopePolicy {
  roles: Record<roleName, {
    promptSections?: { shadowEmpty: string[] }   // 经 childCtx 注册空 section 按名遮蔽(Q3)
    toolFilter?: { allow?: string[]; deny?: string[] }  // 与请求 toolFilter 相交(L3)
    persona?: string                             // 遮蔽 deployment:persona(L4)
    agentOptions?: { model?, provider?, maxTokens? }    // (L2)
    history?: {
      mode: 'inherit' | 'prefix-only' | 'projected'
      // projected: 保留 turn 配平前提下删除命中事件,重编 seq
      dropEventTypes?: string[]                  // 如 'session/end-seed' 外的遥测回行
      dropContentPatterns?: string[]             // canary/secret 正则;或来自 doc 01 外泄分类
      keepLastTurns?: number                     // projected 的粗粒度捷径
    }
    maxDepth?: number                            // 只能比请求更紧
  }>
  defaultRole: roleName
  strength: 'off' | 'audit' | 'enforce'
}
```

### 泄漏度量 harness(合成场景设计,供 12 消费)

PerspectiveGap 风味的场景包:每个场景 = 父会话脚本化 transcript(含 task-relevant 内容
+ K 个 canary 秘密,形如 `CANARY-{scenario}-{k}` 分布于其他角色任务/凭据/推理片段)+
一个子代理委托任务。对每个场景跑 `inherit`(基线)与 policy 档两次委托,采集:
- **leak rate**:子代理最终上下文(`localAgent.session.events` + 组装的 system prompt)
  中出现的 canary 比例,pre/post policy 对比;目标:policy 档 ≤ 基线 × 0.1。
- **task success**:子代理任务断言通过率(防过度剪枝,over-pruning 与泄漏同列为失败)。
- 事件按共享原则 5 走 `session-telemetry/record` waterfall + `session/event` 流,schema
  对齐 doc 12 的 eval 导出(`metric: 'context-leak-rate'`,维度 scenario×role×mode)。

## 里程碑切分

- **M0 = 本 spike(已完成于本文档)**:Q1-Q3 证据与上述结局判定。产出即本文档。
- **M1(条件化,现已激活)**:`pnpm new:plugin agents subagent-context-scope` 脚手架;
  policy schema;`scoped-fork`/`scoped-spawn` 包装 provider;杠杆子集
  L1 prompt 改写 + L2 agentOptions + L3 toolFilter 相交 + L4 persona 遮蔽 + 历史投影
  (`prefix-only` 与 `projected`,经自算 seed + `startInProcessRun`);单测:种子投影器
  不变量(seq 连续/turn 配平/事件 JSON 往返)、capability 拒绝透传、相交语义、off/audit
  不改写请求。
- **M2(条件化)**:泄漏度量 harness + telemetry 上报 + 场景包 ≥ 10 个(含 3 拓扑);
  `shadowEmpty` section 切片(continuable 经 `registerContinuableSetup`;one-shot 若
  评审接受自组驱动则同稿,否则转 partial 退路的上游 issue);README graduation criteria。

## 验证计划

1. `pnpm --filter @jianxx/dsh-incubation-subagent-context-scope test` 全绿(门禁)。
2. 集成测试:起内存 deployment,stock `fork` 委托一次(基线 transcript 全量继承),
   切 `scoped-fork` 同任务再委托,断言子 `session.events` 长度、canary 命中数、
   `inheritsParentContext` 文案与真实行为一致(projected 时必须如实声明)。
3. harness 场景包跑分:leak rate 与 task success 双指标出报告,接入 doc 12 导出。
4. 真实会话人工抽查一次 steer-back 归因(若 M2 加 section 切片,验证父代理不受影响:
   遮蔽只落在 childCtx 作用域)。

## 风险与开放问题

- **R1 自组 one-shot 驱动的漂移风险**:若 M2 需要 one-shot section 遮蔽,须以公开导出
  重组驱动(~百行),钉一组对照 stock driver 行为的特性测试;上游演进时靠测试报警。
  退路即 partial 行的上游 issue(`registerOneShotSetup`)。
- **R2 投影合法性包络**:哪些事件类型是 surface/model 重放必需(如 request header、
  turn 边界),M1 用失败测试实测圈定;`sessions.create` 校验会 fail-loud,不会静默裂。
  投影不得触碰 `session/end-seed` 之后的子代理自身事件(种子仅含父前缀,天然满足)。
- **R3 角色解析的诚实性**:`label` 是模型/调用方自报,不能当安全边界;policy 是减泄漏
  与提质量手段,不替代权限(权限由 `DelegatedPolicyOverrides` 的 approval `'never'` 钉住,
  child-agent.ts:186,已验证)。

  与 29 memory-guardian 的边界:子代理**能看多什么**记忆属本文档的 scope policy;跨 agent
  的记忆**写入/共享**治理(准入、类型污染、overlay 一致性)归 29(门控于真实多人写入)。
- **R4 与 doc 01 的时间差**:doc 01 未落地前 `dropContentPatterns` 内联兜底;落地后
  迁移至 tool-manifest 外泄分类(共享原则 4),迁移期双读。
- **开放问题**:continuable 子的投影种子在冷恢复后是否应随父会话增长重投影(当前
  `prepareContinuable` 语义是"创建时一次性固化",subagent-fork-in-process:77-89 的
  TODO 表明 upstream 也在此留白)——本包跟随 upstream 语义,不抢答。
