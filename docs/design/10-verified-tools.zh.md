# 10 verified-tools — 幂等、先验后重试与参数准入

> 状态: design (not started) | Tier: 3 | 包: packages/verification/verified-tools | 依赖: 01
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:给副作用类工具补上可靠的执行语义——歧义失败(超时/无响应)先用后置条件探针判定"动作到底发生没有"再决定是否重试;确定性幂等键去重;工具参数在 pre-execute 做 schema 预校验。
**用户问题**:网络稍微一抖,agent 就不知道 `gh pr create` 到底成没成:盲目重试造出两个 PR,或者把一个其实已经成功的动作当成失败放弃;参数格式错被远端拒了也读不懂错误——用户看到的是重复副作用、"明明成功了却说失败"、以及永远对不上的世界状态。

针对「不可靠工具」的执行语义插件:围绕 `tools/execute` 包裹真实派发,提供
幂等去重、歧义结果的「先验后重试」、以及工具参数的预校验准入。

## 动机(含 verification-only > full wrapper 的消融含义:v1 先做验后重试,不先做重试编排)

文献锚点与含义:

- **Verified Tool Calls (2608.02645)**:形式化四类失败 —— timeout-after-dispatch、
  delayed visibility、partial success、stale conflict;并把「观测到的响应」与「世界状态」
  分离:响应只是可能过期的代理,重试副作用调用**之前**必须验证 intended postcondition。
  报告基线重复副作用 20–72%,加入确定性幂等键 + 验证后降为 0/16/20% 且任务成功率
  100% 不变。**关键消融:verification-only 经常优于 full wrapper —— 收益来自
  「检查动作是否已经发生」,不来自重试编排本身。** 因此本插件 v1 只建「验后重试」
  (retry 上限恒为 1),不做 backoff 链 / 重规划 / 多次重试编排。
- **To Call or Not to Call**:call/no-call 本身是 admission 决策
  (necessity / utility / affordability)。映射为本插件的 **wrap/no-wrap gate**:
  只对 manifest 分类为有副作用的调用支付验证成本;readonly / write-local 调用零成本
  直通,不产生任何存储与探测开销(见「包装主流」步骤 1)。
- **Structured Output Control**:schema/格式失败在工具边界常见,decoder 侧强制不充分;
  runtime 侧参数校验 + corrective feedback(恢复通道)属于 harness。上游 core 明确
  「tools validate their own schema」(见缺口 3),正好留给插件。

## 现状与缺口

已验证(上游仓库 `deepseek-harness`,下称 dsh;引用均为其仓内相对路径):

1. **超时已以结构化 error 结果返回**:超时由插件
   `packages/guard/timeout-policy` 承担,产出普通 `ToolExecutionFailure`
   (`isError:true`,`error.info = { name:'ToolTimeoutError', code:'TOOL_TIMEOUT' }`,
   `packages/guard/timeout-policy/src/index.ts:25,46`),wrapper 可按
   `error?.info.code === 'TOOL_TIMEOUT'` 路由。core 仅校验 `timeoutMs` 选项
   (`packages/core/tools/src/schema.ts:499-500`)。
2. **重复调用已有 advisory 提醒**:`packages/guard/repeat-tool-reminder` 检测连续
   相同调用(阈值默认 [3,5,8])并注入提醒 UserMessage,**但无 veto、无去重**
   (`src/index.ts:1-2`)。
3. **无 harness 层统一参数校验**:`ToolExecutionInput.arguments` 注释明确
   「Losslessly JSON-serializable parsed arguments (tools validate their own schema)」
   (`packages/core/tools/src/index.ts:322`)。core 有现成的校验器
   `validateJsonSchemaValue(schema, value, path): string[]`(`packages/core/tools/src/json-schema.ts:654`,
   经 `index.ts:93` 再导出,包名 `@deepseek-ai/dsh-tools`),目前只用于 output
   (`index.ts:1795`)。

缺口:(a) 无端到端幂等去重(store + short-circuit);(b) timeout-ambiguous 场景无
「先验后重试」(典型:`gh pr create` 超时后直接重发会建重复 PR);(c) 无统一的
pre-execute 参数校验与 corrective feedback;(d) 上述事件无一致遥测。

## 设计

### 表面与接缝(verified + cited)

1. **around-seam 包裹**:`'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>`
   (`packages/core/tools/src/index.ts:163`)。可完全包裹派发:检查 `exec` →
   **短路返回合成 `ToolExecutionResult`(合法,无需调 `next()`)** → 或 `next()` 后观察/替换结果。
   约束:wrapper 只允许替换 `exec.signal`,调用身份不可变
   (`index.ts:155-158,386-394`)。注册形态:`apply(ctx: Context)` 内
   `ctx.on('tools/execute', async (exec, next) => ...)`(参照
   `packages/guard/timeout-policy/src/index.ts:55`(`apply`)。
2. **pre-execute 否决**:`'tools/pre-execute'(exec, next)`(`index.ts:152`),决策
   `{kind:'allow'} | {kind:'deny'; reason} | {kind:'ask'; reason}`(`index.ts:588-603`);
   `deny` 物化为 `Error: <reason>` 的 isError 结果交给模型(`index.ts:1492-1497`)——
   即 corrective feedback 的恢复通道。**pre-execute 不能改写参数**(`index.ts:585-587`),
   因此恢复只能靠 deny-reason 提示模型修正后重发(与 Structured Output Control 的
   runtime 侧 corrective-retry 语义一致)。工具定义用
   `ctx.tools.get(exec.name, exec.agent)` 取(参照 `timeout-policy/src/index.ts:57`),
   声明 schema 字段为 `parameters`(`index.ts:1257-1265`)。
3. **嵌套派发(跑 tool 类 probe)**:`ToolRuntime.execute` 是公开方法
   (`index.ts:1342`),wrapper 内可 `this.execute(...)`;嵌套派发是设计内概念,
   通过 `parent` token 传递(`index.ts:316-320,327-334`),grep 未见 reentrancy 防护。
   需自带 `callId`、`signal`,并传 `parent: exec.token`。**注意**:Code Mode 下仅带
   parent 的调用可执行 native tool 名(`index.ts:329-334`)。先例:
   `repeat-tool-reminder/src/index.ts:190` 直接调 `ctx.tools.execute()`。
4. **ASK 升级**:`ctx.approval.request({agent, toolName, callId?, reason?, signal?})`
   → `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
   (`packages/interaction/user-approval/src/index.ts:153-165, :257`;
   `types.ts:29`)。`'unavailable'` fail-closed;`request()` 必须在 open turn 内
   (`request()` 在 `:257`,open-turn 检查在 `:259-265`),wrapper 内天然满足。不绕开 `approval/request` waterfall
   (共享原则 1)。
5. **遥测**:`'session-telemetry/record'` 是同步 redaction transform 而非「发事件」
   API(`packages/session/session-telemetry/src/index.ts:47`,记录形状
   `{channel:'ledger'|'ops', time, severity, attributes, body}` 见 `:64-92`)。发遥测 =
   追加 session event(ledger)或走 `SessionTelemetrySink.emit`(`:97`)。本插件产出
   的 dedup-hit / verify-catch / probe-run / arg-denial 以 ledger 事件进入统一事件流
   (共享原则 5)。
6. **shell 类 probe**:经 `@deepseek-ai/dsh-shell` 抽象执行服务
   `run(spec: ShellExecSpec): Promise<ShellRunResult>`
   (`packages/shell/shell/src/index.ts:93`),走沙箱语义,不直接 `child_process`。
7. **状态落盘**:`.dsh` 解析为 harness HOME(`DSH_HOME_DIR_NAME='.dsh'`、env
   `DSH_HOME`、默认 `~/.dsh`;`packages/util/home-paths/src/index.ts:12-18`,解析器
   `resolveDshHome()` / `dshHomePath(...segments)` `:87-98`);原子写
   `writeFileAtomic`(`packages/fs/fs-local/src/index.ts:36,200,244`)。
   manifest 元数据(effectClass / idempotency.keyRecipe / retryProbe /
   failureSemantics)一律来自 doc 01 的注解机制(共享原则 4)。

### 数据模型 / 配置(idem store schema, windows, modes)

幂等记录(去重窗口内一次「意图执行」的账本):

```ts
// 路径: dshHomePath('verified-tools','idem', <windowDir>, `${key}.json`)
interface IdemRecord {
  key: string                       // sha256 hex,见 keyRecipe
  tool: string
  agentId?: string
  argsDigest: string                // canonical 参数摘要(按 recipe 选定的子集)
  state: 'in-flight' | 'completed'
  resultDigest?: string             // 单行结果摘要(成功值或错误码),不含原始 payload
  recordedAt: number                // epoch ms
  bucketStart: number               // floor(now / bucketMs) * bucketMs
}
```

键配方(manifest 提供 `idempotency.keyRecipe`,选定参与散列的参数字段):

```ts
key = sha256(agentId, toolName, canonical(argsSubset(recipe)),
             floor(now / config.bucketMs))
```

配置(profile 级,SafetySentry 三档贯穿,共享原则 3):

```ts
verifiedTools: {
  mode: 'off' | 'audit' | 'enforce'   // 总闸 + 歧义升级档;默认 audit
  argValidation: 'off' | 'audit' | 'enforce'  // 可独立成档
  windowMs: number                    // 去重窗口,默认 600_000
  bucketMs: number                    // 时间桶,默认 60_000
  retentionWindows: number            // 写时 GC,默认 24
  maxRetries: 1                       // 论文消融含义:恒 1,不可调大
  probe: { timeoutMs: number; fallback: 'ask' | 'fail' }
  askThreshold: number                // SafetySentry 连续谱(见风险 6)
}
```

窗口目录 `<windowDir>` = 桶起点戳;GC 在每次写记录时顺手删除过期窗口目录,
避免无界增长。所有写经 `writeFileAtomic`。

### 关键行为流(包装主流;歧义→probe→决议流;参数校验流)

**流 1 — 包装主流**(`tools/execute` wrapper):

1. manifest 查 `effectClass`:不属于 `side-effecting | external-disclosure |
   irreversible` → **直接 `return next()`**,全程零存储零探测(gate economics)。
2. 按 `keyRecipe` 算 key,读 `IdemRecord`:
   - `completed` 且在窗口内 → 短路:返回去重结果 `isError:false`,content 为
     「本次调用与桶 <bucket> 内的同等调用重复,已按记录结果去重:<resultDigest>」,
     `meta: { deduped: true, originalBucket }`;ledger 记 `verified-tools.dedup-hit`。
   - `in-flight` → 短路抑制:isError 结果「同等副作用调用正在执行中,未派发」,
     防并发重复派发;记 `dedup-hit(inflight)`。
   - 无记录 → 写 `in-flight`,`next()`,按结果流转:
     - 成功 → 写 `completed` + resultDigest,原样返结果;
     - 失败且 `error.info.code === 'TOOL_TIMEOUT'` 且 manifest `failureSemantics`
       标 `timeout-ambiguous` → 进流 2;
     - 其他失败 → 写 `completed`(失败摘要)。**同参数+同桶的失败重发也被去重**:
       短路返回已记录的失败摘要,逼模型改参数(改参数即换 key)而非盲目重试。
3. 包装器自身的内部重试(流 2 步骤 4)带内部 bypass 标记,跳过步骤 2 的去重检查,
   否则会被自己的 `in-flight` 记录拦下。

**流 2 — 歧义 → probe → 决议**(验后重试):

1. 读 manifest `retryProbe`:`{ kind:'shell', command, expect }` 或
   `{ kind:'tool', name, args, expect }`(`expect` = postcondition 断言,含多断言时
   任一不满足记 partial)。
2. shell probe 经 `dsh-shell` `run()` 执行;tool probe 经 `this.execute(...)` 嵌套派发
   (`parent: exec.token`、新 `callId`、自带 `signal` 与 `probe.timeoutMs`)。probe 自身
   必须被 manifest 标为 `readonly` 且带 bypass 标记,避免被本 wrapper 递归包裹。
3. 三分决议:
   - **postcondition met**(动作其实已成功,响应是过期代理)→ 合成
     verify-success 结果:`isError:false`,content「调用超时后经验证已完成:
     <probe 证据摘要>;未重试」、`meta: { verifyRecovered: true }`;ledger 记
     `verify-catch`(被阻止的重复副作用);写 `completed`。
   - **postcondition unmet** → 允许**恰好一次**重试(带 bypass 标记重新 `next()`),
     第二次结果直接返回并落 `completed`。
   - **unknown**(probe 无法判定 / probe 自身失败)→ 按 mode 决议:
     `off` 原样返回超时错误;`audit` 记 warn 后原样返回;`enforce` →
     `ctx.approval.request({agent, reason, ...})`,`'allowed-once'` = 放行一次重试,
     `'rejected'/'cancelled'` = 返回原超时错误,`'unavailable'` fail-closed
     (上游语义,`user-approval/types.ts:29`)。
4. probe 全程计 `probe-run` 遥测(次数、verdict 分布、耗时)。

**流 3 — 参数校验**(`tools/pre-execute`):

1. 取 `ctx.tools.get(exec.name, exec.agent)?.parameters`,
   `violations = validateJsonSchemaValue(schema, exec.arguments, 'arguments')`。
2. 无违例 → `{kind:'allow'}`。
3. 有违例:`audit` → allow + ledger warn(只观察不放纵?——audit 档为收集误报率
   默认放行并记录);`enforce` → `{kind:'deny', reason}` 其中 reason 列出每个
   violation 路径 + 期望类型摘要(如 `arguments.prTitle: expected string, got
   number`)。上游把 deny 物化成 `Error: <reason>` 结果交回模型,模型据
   corrective feedback 修正参数重发(恢复通道)。记 `arg-denial` 遥测。

### 四类失败 → 信号/动作映射表

| 失败类(论文术语) | 检测信号 | 插件动作 |
|---|---|---|
| timeout-after-dispatch | 结果为 `error.info.code === 'TOOL_TIMEOUT'` 且 `failureSemantics=timeout-ambiguous` | 流 2:probe → verify-success / 一次重试 / 按档 ASK |
| delayed visibility | 流 2 probe 判 `unknown`(效应可能稍后可见) | 不盲重试:`off/audit` 原样失败 + 标注;`enforce` ASK;重试决定权交人或默认否 |
| partial success | probe 多断言部分满足 | 不重试(避免叠加部分副作用);合成结果注明 partial 证据 + 记 `partial` 事件;`enforce` 档升级 ASK |
| stale conflict | 派发前命中 `completed` 幂等记录(世界已含预期效应的代理) | 短路返回去重结果(流 1 步骤 2) |

### 端到端示例(gh pr create 超时)

设 manifest 对 shell 工具的 `gh pr create ...` command 模式标注:
`effectClass: 'side-effecting'`,`failureSemantics: 'timeout-ambiguous'`,
`keyRecipe: ['command']`,`retryProbe: { kind:'shell', command: 'gh pr list --head <branch> --json url,number', expect: 'nonempty' }`。

1. 模型发 `bash { command: 'gh pr create --title ... --head feat-x' }`。wrapper 匹配
   manifest → 进入包装路径;写 `in-flight` 记录(key 含 command 摘要 + 当前时间桶)。
2. `next()` 派发;timeout-policy 的计时器先触发 → 返回
   `error.info.code === 'TOOL_TIMEOUT'` 的失败结果(上游语义,所见即所得)。
3. wrapper 见 timeout-ambiguous → 跑 probe,经 `dsh-shell` 执行
   `gh pr list --head feat-x --json url`,`postcondition nonempty` 满足,取到 PR URL。
4. 合成 verify-success:`isError:false`,content「`gh pr create` 派发后超时,但已验证
   PR 存在:https://github.com/org/repo/pull/42;未重发」,`meta:{verifyRecovered:true}`;
   ledger 记 `verify-catch(tool=bash, pattern="gh pr create")`;写 `completed`。
5. 模型收到成功语义继续推进任务。**重复副作用 = 0,未做任何重试** —— 即论文
   消融结论的最小形态:收益全部来自「先验证是否已经发生」。
6. 反事实:若 probe 返回空(unmet),则带 bypass 恰重试一次;若 probe 也失败
   (unknown)且 mode=enforce,走 `approval/request` 把人请进来,而不是盲目重发。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 标准)

**M1 — 参数预校验 + 幂等 store + dedup(verify-catch 前置都可不做)**
PR 范围:`pnpm new:plugin verification verified-tools` 脚手架;流 3 全量
(`validateJsonSchemaValue` 复用);idem store(`dshHomePath` + `writeFileAtomic` +
写时 GC);流 1 步骤 1–2 的去重短路(不含流 2);mode/window/bucket 配置;
`dedup-hit`、`arg-denial` 两类 ledger 事件;单测。
验证:单测 mock 一个 `side-effecting` 工具 —— (a) 同参数同桶二次调用返回
`meta.deduped` 且底层 dispatch 计数 === 1;(b) 畸形参数在 enforce 档被 deny 且
reason 含 violation 路径,audit 档放行且 warn 落 ledger;(c) mode=off 全直通。
门禁(typecheck/lint/test)全绿。

**M2 — probe 框架 + 先验后重试 + 合成混沌测试**
PR 范围:流 2 全量(shell probe 经 `dsh-shell`、tool probe 经嵌套 `this.execute`
带 `parent: exec.token`;bypass 标记防递归包裹/防自拦 dedup);三分决议;
`verify-catch`、`probe-run`、`partial` 遥测;混沌测试台(tool 桩 + 「影子世界状态」
记录器,可注入四类失败:派发后超时、效应延迟可见、部分成功、过期冲突)。
验证:混沌套件矩阵(4 失败类 × verdict met/unmet/unknown)断言 —
重复副作用恒 0、任务最终结果成功率不因 wrapper 下降;probe met 场景在调用侧
观测到的是 verify-success 而非二次派发(派发计数 === 1)。

**M3 — ASK 升级 + telemetry 出口 + 文档**
PR 范围:`enforce` 档 unknown → `ctx.approval.request` 集成(`allowed-once` 放行
一次重试,其余 fail-closed);`askThreshold` SafetySentry 连续谱配置;遥测事件
schema 与 doc 12 eval 导出对齐;README(graduation criteria)、示例配置。
验证:集成测试 mock approval —— `allowed-once/rejected/unavailable` 三分支行为
分别断言;遥测快照断言事件序列;真实 profile 冒烟:沙箱 repo 内 `gh pr create`
断网注入超时,验证 verify-catch 路径真实触发且无重复 PR。

## 验证计划

- 单元:key 确定性(recipe 子集置换不改 key;跨桶必换 key);store GC;
  dedup 窗口边界(桶沿两次调用的去/留);deny reason 结构。
- 混沌测试(M2 测试台):影子世界状态 = 副作用真值的唯一来源,断言
  「真值中副作用恰好一次」而非「调用侧看到了成功」——贴合论文 effect/response 分离。
- 真实烟测(M3):沙箱 GitHub repo + 人为断网/慢网注入 timeout-after-dispatch。
- 遥测判据(毕业标准 c 的输入):prevented-duplicate 计数、verify-catch 次数、
  arg-denial 误拦率(audit 先行观察)、unknown 升级率。
- 回归:`repeat-tool-reminder` 与本插件并存不冲突(前者 advisory,本插件短路;
  顺序测试覆盖)。

## 风险与开放问题

1. **idem store 的作用域**:`.dsh` = harness HOME(`~/.dsh`),非 project-local
   (`home-paths/src/index.ts:12-18`)。跨 repo 的 `side-effecting` 命令(如两个
   repo 各自 `gh pr create`)若要正确去重,recipe 必须把 repo/cwd 类上下文吃进 key。
   检查项:是否存在 project 级 state 目录约定(grep `dshHomePath` 之外的
   state-dir helper);若无,M1 前拍板「全局 HOME + recipe 强制含 cwd 字段」。
2. **manifest 分类粒度依赖 doc 01**:`gh pr create` 场景需要按 command 模式在
   shell 工具内部再做子分类(effectClass / retryProbe 都挂在 arg-pattern 上)。
   检查项:`01-tool-manifest.md` 是否定义 arg-pattern 级注解;若只有 tool 粒度,
   本插件对 bash 类工具退化为「整条 shell 工具标注副作用」,成本显著放大
   (gate economics 失效)。这是 v1 立项的最大前置依赖。
3. **嵌套 probe 的链路副作用未完全摸透**:tool probe 经 `this.execute(...)` 会重走
   完整 `pre-execute → execute` waterfalls(`invariant.ts:100-110` 的阶段顺序),
   是否会触发权限审批 / 被本 wrapper 递归包裹、Code Mode 的 parent 限制
   (`index.ts:329-334`)在 probe 路径上的具体表现 —— M2 开工前用 spike 验证:
   「wrapper 内嵌套派发一个 readonly 工具,观测审批与拦截行为」。rc.7 已核:
   Code Mode 下,含 image block 的非错误 subtool 结果会额外经 `exec.deferContext(...)`
   以插件归因的 user message 投递(source plugin `tools-code-mode`,
   `packages/core/tools/src/code-mode.ts:564-569`)——wrapper/probe 观察
   `result.content` 时,若存在 image block,不得假定它等于最终模型可见面。
4. **deny reason 是纯文本**(`Error: <reason>`,`index.ts:1492-1497`),无结构化
   字段;校验违规清单长度可能撑爆展示。检查项:该 `Error:` 前缀文本有无长度
   截断;必要时 reason 只放前 N 条 + 「共 M 处」。
5. **失败记录的去重抑制可能误挡正当重试**:同参数失败被记 `completed` 后,窗口内
   修复条件满足(如网络恢复)的真实重试会被短路。缓解:失败记录的 TTL 用更短
   子窗口(`windowMs / 4`),或 audit 档对失败记录只观察不短路 —— M1 实验定案。
6. **approval 可用性**:`request()` 需在 open turn(`user-approval/src/index.ts:257,259-265`),
   无 UI answerer 的环境(subagent/background)返回 `'unavailable'` → fail-closed。
   这是预期行为,但 `askThreshold` 与 background profile 的组合策略需要文档化,
   避免 background 模式下 unknown 一律失败的体验塌方。
7. **resultDigest 不含原始 payload**:去重结果若夹带副作用输出详情,有外泄面
   (与 doc 09 token-wall 的交互)。设计定 digest 只存「动作 + 关键标识(如 PR
   URL)」;检查项:09 落地后确认是否需经其 redaction 出口。
