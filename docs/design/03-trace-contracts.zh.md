# 03 trace-contracts — 轨迹契约:在线门 + 离线评分

> 状态: design (not started) | Tier: 1 | 包: packages/verification/trace-contracts | 依赖: 无(可选集成 01)

## 动机

Agent 的失败很多不是"答错",而是**轨迹走形**:跳过测试直接 commit(Tool-Skip)、
拿到工具报错却继续声称成功(Result-Ignore)、没调工具就编造结果(Output-Fabrication)、
无意义地重复调用(Unnecessary-Tool-Use)——这四类即 ToolFailBench 的度量类别。
permission-rules 回答的是"这个 agent 有没有权调这个工具"(身份/模式授权),
回答不了"这个任务此刻该不该再调一次 bash"(per-task 行为预算)。

AgentLTL 给出的范式是:把轨迹性质写成一份声明式 spec(源自 FO-LTL 的工具
order/branch/count/params/grounding),**同一份 spec 三处复用**——离线评分、
在线 block-and-warn、训练 reward。本工作项落地前两者(reward 留给训练侧消费
doc 12 导出的事件 schema)。两条文献红线直接进设计:

- **AgentLTL 警告**:soft-block 配 early termination 会损害 agent 的恢复能力——
  所以 deny 必须携带引用被违反条款的反馈文本,给模型留**恢复通道**,而不是
  一个死胡同错误。
- **Reason-Less-Verify-More**:gate 只在 state-decidable / interceptable /
  recoverable 三者同时成立处才值得在线强制执行;不可判定的前置条件降级为
  audit,不在线拦。
- **SafetySentry**:EXECUTE / ASK / REFUSE 三态路由 + 可调阈值——ASK 是配置
  dial,不写死(对应 overview 共享原则 3 的 `off / audit / enforce` 三档)。

## 现状与缺口

已有(见下节验证):`tools/pre-execute` waterfall 的 decision 类型含
`allow / deny(reason) / ask(reason?)`;ask 由 tool registry 内部经
ApprovalService(`ctx.get('approval')`)解析,天然走 `approval/request`
waterfall 的原生 UX;`session/event` 持久事件流可被插件订阅;
`session-telemetry/record` waterfall 是统一观测出口。

缺口:没有任何插件把"任务级轨迹预算"表达成可加载的声明式文件;pre-execute
gate 目前只看到单次调用,没有跨调用的序列/计数状态;离线侧没有把会话事件流
重放为合规率与违规分类的评分器。cc-plugins 的 permission-rules 引擎另有
allow/deny/ask 三态,但它是**身份授权语义**且位于另一仓库——本插件编译期零依赖,
ASK 一律走上游 `approval/request` seam(overview 原则 1),standalone 可工作。

## 设计

### 表面与接缝(verified + cited)

以下均已直接读码确认(上游仓库 `/Users/bytedance/workspace/github.com/deepseek-harness`):

1. **`tools/pre-execute` waterfall + PreToolDecision 三态**
   `packages/core/tools/src/index.ts:152`(listener 签名)与 `:588-591`:
   ```ts
   export type PreToolDecision =
     | { kind: 'allow' }
     | { kind: 'deny'; reason: string }
     | { kind: 'ask'; reason?: string }
   ```
   waterfall 末尾缺省值为 `{ kind: 'allow' }`(`:1477`)。
2. **ASK 的实际接线(插件不自己调 approval)**:registry 在 pre-execute 拿到
   `gate.kind === 'ask'` 时**内部**调 `serviceAsk(exec, gate)`(`:1479-1480`,
   实现 `:1689-1728`):`ctx.get('approval')` 缺席 → 降级为 deny(reason 为
   `tool "X" requires approval (not yet supported)`);`exec.agent` 缺席同样降级;
   否则 `approval.request({ agent, toolName, callId, reason?, signal })`,
   `allowed-once` → allow;`rejected / cancelled / unavailable` → deny 且三者
   reason 文案可区分(模型能分辨"人说不"和"没有审批通道")。ApprovalService
   实现内部经 `approval/request` waterfall 渲染 UX(见
   `packages/core/tools/tests/tools.spec.ts:744` 的 `ctx.on('approval/request', …)` 用法)。
   **结论:插件的 ASK 只在 pre-execute 返回 `{ kind: 'ask', reason }`,审批 UX 由
   宿主 ApprovalService 负责;这在无 UI/无 approval 服务的部署里自动 fail-closed
   成 deny,符合预期。**
3. **会话事件订阅**:`ctx.on('session/event', (session, event) => …)` —— 类型
   声明 `packages/core/session/src/index.ts:76`(`post-commit, fire-and-forget`,
   listener 失败被 log 并隔离);真实用法 `packages/core/session/src/invariant.ts:223`。
   事件键(`packages/core/session/src/types.ts:236-291`,SessionEventMap)含
   `turn/start`、`turn/end`、`step/start`、`step/end`、
   `tool/call { turn, step, callId, name, arguments: string }`、`tool/result {…}`——
   序列/计数/参数三类规则的全部输入都从这来;`tool/call.arguments` 是 JSON 字符串,
   解析失败按参数规则求值失败处理(见行为节)。
4. **遥测出口**:`'session-telemetry/record'(record, next) => SessionTelemetryRecord`
   waterfall,声明于 `packages/session/session-telemetry/src/index.ts:43`;
   record 形状 `{ channel: 'ledger' | 'ops', time, severity, attributes, body }`
   (同文件 `:64-83`)。session log 事件经 ledger channel 自动镜像;插件自建
   指标(compliance % 等)走 ops channel,`telemetry.op` 命名
   `trace-contracts.*`。
5. **审批之外的 deny 反馈**:deny 的 `reason` 被 materialize 成
   `Error: <reason>` 的 tool result(`:1490-1496`)——这正是恢复通道的载体:
   reason 即模型下一轮能看到的反馈文本。

### 数据模型 / 配置(contract schema sketch)

契约文件:`<repo>/.dsh/trace.yml`(project 级)与 `~/.dsh/trace.yml`(user 级);
`/trace attach <file>` 可把契约绑到当前 session/goal。user 级提供默认值,
project 级覆盖,session attach 再覆盖( precedence:session > project > user )。

```yaml
# .dsh/trace.yml — 例:TDD flow
name: tdd-flow
mode: enforce            # off | audit | enforce(overview 原则 3 三档)
ask:                     # SafetySentry dial:全局 ASK 阈值
  default: false         # 命中 ask 级违规时是否升级为真人 ASK
  escalateAfter: 2       # 同一规则被 deny≥N 次后,后续违规升级 ask(防死循环)
rules:
  - id: test-before-commit
    kind: sequence                       # 序列规则
    pattern: "edit* test+ commit?"       # 类 regex:工具名 token + * + ? 量词
    capture: { edited: "edit{file}" }    # 具名捕获,供 param 规则引用
    window: turn                         # 匹配窗口:turn | session
    action: deny                         # deny | ask | audit
    message: "commit 前必须先运行 test(捕获文件 ${edited})"
  - id: bash-budget
    kind: count                          # 计数规则
    tool: bash                           # 或 pattern: "edit*"
    maxCalls: 40
    window: session
    action: ask                          # 超预算不硬拦,问人
  - id: no-destructive-bash
    kind: param                          # 参数约束(JSON-schema on parsed args)
    tool: bash
    schema:
      type: object
      properties:
        command: { type: string, not: { pattern: "rm\\s+-rf\\s+/" } }
      required: [command]
    action: deny
    message: "破坏性命令被契约禁止;如需清理请逐文件删除并说明理由"
  - id: build-clean-before-push
    kind: state                          # 状态前置:只读探针,先于副作用步骤求值
    before: "git push*"                  # 触发点(副作用模式)
    probe: build.status                  # 引用 01 tool-manifest 的探针 id
    expect: green
    action: deny
    downgrade: audit                     # 无 manifest 插件/探针不可判定 → 降级
```

设计要点:

- **sequence** 的 pattern 作用在"本窗口内已 invoke 的工具名序列"上,语义是
  AgentLTL 的 order/branch/count 子集(刻意不做完整 FO-LTL,保持 schema 可读);
  具名捕获把已匹配的参数暴露给后续 param 规则。
- **state 规则**遵循 Reason-Less-Verify-More:探针必须只读、可判定、可在
  pre-execute 同步/短超时内求值;任一不满足 → `downgrade` 生效并记录
  `trace.state_downgraded{ rule, reason }` 审计事件,绝不在线拦一个不可判定
  的条件。
- **action 默认值**:param 硬性安全约束 → deny;序列/计数预算类 → 默认 ask
  (SafetySentry:可恢复的违规问人比硬拦便宜);state 探针缺失 → audit。
  全局 `mode: audit` 时所有规则只记录不拦截(灰度期用它收集误拦率)。

### 关键行为流

**Gate flow(在线)** — pre-execute listener 一次调用内的求值顺序:

```text
tools/pre-execute(exec):
  1. contract = sessionState.attachedContract; 无 → return next()(直通)
  2. args = JSON.parse(exec.arguments)  // 失败:param 规则记 unevaluable,不拦
  3. 命中 param 规则且 schema 不通过
     → action 执行(deny 走恢复通道;ask 走 approval;audit 记事件)→ 后续 param 规则可叠加
  4. 副作用调用前:求值 state 规则的只读探针(有 01 插件时);
     不可判定 → downgrade=audit + 审计事件
  5. 把本次调用喂给 window 内的序列匹配器(增量 NFA),并完成计数器记账
     → 命中违规 → action 执行
  6. 全部通过 → allow;同时 emit trace 合规事件
```

恢复通道(AgentLTL 红线的落实):
- **deny feedback wording 契约**:`reason` 必须包含 (a) 规则 id,(b) 违反条款的
  原文(message 模板渲染后),(c) 当前状态摘要(已用计数/序列进度),
  (d) 一句可操作的修正建议。模板:
  `trace-contract[test-before-commit]: commit 前必须先运行 test。当前序列:
  edit(src/a.ts)×3, test×0。建议:现在运行 test,通过后再 commit。`
  因为上游把 reason 包成 `Error: …` tool result(上节接缝 5),模型下一轮
  必读得到,续轮即可 course-correct——不是死胡同。
- **ask**:返回 `{ kind: 'ask', reason: <同上格式的条款渲染> }`,审批 UX/
  通道归宿主 ApprovalService;用户在 ASK 里点拒绝 → 上游给 deny reason
  `the user rejected tool "X"`,模型同样可读。`escalateAfter` 只在
  同一规则反复 deny 时把 action 提升为 ask,打破"模型撞墙循环—人从不被问"。
- listener **永不 throw**:求值异常一律记 `trace.gate_error` 审计事件后 allow
  (fail-open 于门,fail-closed 于账;与 overview 原则 2 的 listener 约束同构)。

**会话状态**:contract 求值状态(计数器、序列 NFA 进度、具名捕获绑定)按
session 键存于插件内存,`session/disposed` 时落一条汇总 telemetry 后释放;
session/event 流是恢复数据源(重启后可用 scorer 对窗口重放逐事件重建状态,
与 overview"事件流可恢复"对齐)。

**命令**:`/trace attach <file>`(绑定/切换)、`/trace status`(当前契约 +
窗口内进度 + 已触发违规)、`/trace report`(调 scorer 生成本 session 报告)、
`/trace detach`。命令注册 seam 见风险节。

**Scorer flow(离线/直播)**:
1. 输入:session 事件流重放(MVP:读持久 log);live 模式即订阅 `session/event`
   增量评分,但门状态与评分状态分离,互不污染。
2. 对每条规则重放求值器,产出:合规率、每条规则命中/违规计数、违规时刻表。
3. 违规分类到 ToolFailBench 四类:Tool-Skip(序列缺 token)、Result-Ignore
   (tool/result 为 error 且下一步无 repair 调用)、Output-Fabrication
   (final 断言引用了窗口内不存在的调用结果)、Unnecessary-Tool-Use
   (计数超预算或重复同参调用)。
4. 指标经 `session-telemetry/record` ops channel 发出:
   `trace.compliance_pct`、`trace.violations{rule, category}`、
   `trace.ask_escalations`;`/trace report` 输出 markdown 汇总表。
5. **doc 12 eval-harness 的数据源**:评分结果同时以 trace.report 事件写回
   session log,eval 导出 schema 直接消费(overview 原则 5)。

### 与 permission-rules 的边界

permission-rules(cc-plugins)是**身份/模式授权**:这个 principal 能不能调
这个工具,答案与任务上下文无关,策略长期稳定。trace-contracts 是**per-task
行为预算**:同一身份下,"这个修复任务里 bash 还能调几次、commit 之前必须先
test、push 之前 build 必须绿",答案随 session 状态变化,随任务 attach/detach。
二者在 pre-execute 瀑布中应是**两个独立 listener,先后串联、各管各的**;
身份授权 deny 是终态(no recovery semantics),契约 deny 带恢复通道。
如果宿主装了 cc permission engine,本插件照旧只用上游 `approval/request`
seam,不 import、不探测其内部(overview 原则 1:编译期零依赖)。

## 里程碑切分

### M1: contract schema + loader + pre-execute gate(allow / deny-with-feedback)

schema 校验(zod-like)+ 两级文件加载(precedence:session > project > user)
+ 序列增量匹配器(NFA)+ 计数器 + JSON-schema param 求值 + gate listener,
deny reason 按"恢复通道 wording 契约"渲染;`mode: off/audit/enforce` 三档生效。
**验证**:单测用 mock pipeline 驱动 `waterfall('tools/pre-execute')` ——
(a) `edit* test+ commit?` 下跳 test 直接 commit 被 deny 且 reason 含规则 id、
条款原文、状态摘要;(b) 计数超限在 enforce 下 deny、audit 下只记账;
(c) gate 内部抛错被吞并记 `trace.gate_error`、调用放行;(d) 无契约时
纯直通(next() 被调用)。

### M2: ask 路径 + /trace 命令 + 会话状态

gate 返回 `{kind:'ask', reason}`;`escalateAfter` 升级逻辑;per-session 求值
状态仓库 + `session/disposed` 汇总释放;`/trace attach/status/detach` 三命令;
状态从事件流重放恢复(重启场景)。**验证**:单测注入假 ApprovalService
(`allowed-once / rejected / unavailable` 三分支各自落到正确后续决策);同一规则
deny×N 后第 N+1 次返回 ask;dispose 后状态消失且汇总 record 发出;对一段录像
事件流重建状态后与内存状态逐字段相等。

### M3: post-hoc/live scorer + telemetry + 模板包 + docs

事件流重放评分器,ToolFailBench 四类分类器,`session-telemetry/record` ops 指标
三件套,`/trace report` markdown 输出;契约模板包:`tdd-flow.yml`、
`docs-only-flow.yml`、`release-flow.yml`;README(含与 01 的集成说明)。
**验证**:对一条含已知违规的录像流,评分器输出合规率与分类与人工标注一致
(金样例 ≥3 条,覆盖四类中的至少三类);指标 record 的 `telemetry.op`、
attributes、body 形状对上 schema;模板包三份契约经 schema 校验全绿。

## 验证计划

- 单元(M1/M2):mock pipeline + 假 ApprovalService,门禁全绿(`pnpm new:plugin`
  脚手架自带);重点覆盖恢复通道 wording 契约的四个要素齐全。
- 集成(M3):用 dsh 真实跑两个任务(一个守 TDD 契约、一个故意违规),
  `/trace report` 的违规时刻表与手工核对一致;确认无 approval 服务时 ask
  fail-closed 为 deny(上游既定行为,本插件只断言不依赖)。
- 观测:遥测里出现 `trace.compliance_pct` / `trace.violations{rule,category}` /
  `trace.ask_escalations`;audit 模式下收集 2 周误拦率作为 enforce 默认值的校准依据。

## 风险与开放问题

1. **`/trace` 命令注册 seam 未验证**:上游插件如何注册 slash command 尚未定位到
   具体 API。检查:`grep -rn "registerCommand\|command/" packages/core packages/host
   --include="*.ts"`(在 deepseek-harness 仓库),若 upstream 无命令 seam,
   M2 命令降级为插件导出的程序化 API + doc 12 侧入口。
2. **ops 指标的注入点**:`session-telemetry/record` 是捕获侧的变换 waterfall,
   "插件如何主动 emit 一条 ops record"的确切入口(capture coordinator 的公开
   方法 or waterfall 触发方)未完全确认。检查:读
   `packages/session/session-telemetry/src/index.ts` 全文中 `capture`/coordinator
   的导出面;若仅能被动变换,fallback 为写 trace.report 事件进 session log,
   由 ledger channel 携带。
3. **state 探针依赖 01 尚未存在**:01 tool-manifest 未完成前 state 规则一律走
   downgrade=audit;M3 前若 01 未就绪,state 规则整体标注 experimental。
4. **序列 pattern 的表达力边界**:类 regex 语法不覆盖 FO-LTL 全部分支语义;
   需要跨 window 的"最终必须"类性质(例:session 结束前必须 test)在 M1 不
   支持,留给 scorer 离线判定,文档明示。
5. **deny 风暴**:模型对同一条款反复撞墙时依赖 `escalateAfter` 升级 ask 把人
   拉进来;若升级后人持续拒绝,会话应有外部停止手段——这属于 goal 层(doc 04)
   职责,本插件只保证不静默。
