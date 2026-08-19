# 01 tool-manifest — 工具元数据共享基座

> 状态: design (not started) | Tier: 1(基座) | 包: packages/verification/tool-manifest | 依赖: 无(仅 cordis + dsh core 类型) | 消费者: 02 claim-contracts, 09 token-wall, 10 verified-tools
> 缝已对照 deepseek-harness **0.1.0-rc.7**（@`99f6f02fec`）复核；下文 path:line 引用均指该版本。

## 设计目标与用户问题

**目标**:为全部 gate/verify 类插件提供唯一的 per-tool 元数据注册表(效果分类/幂等配方/外泄分级/失败语义),内置核心工具清单 + 用户覆盖层,未知工具 fail-closed。
**用户问题**:今天想给 agent 加任何"这个调用安不安全/能不能重试"逻辑的人,只能自造一份硬编码工具清单;多份清单各自漂移后,同一工具在一处被放行、另一处被拦截,用户面对的是互相矛盾的行为,且没有一处权威答案可查。



## 动机(为什么必要)

三层验证栈(trace property / action gate / claim contract)与 TokenWall 类外泄防线,
都需要回答同一组 per-tool 问题:这个工具有没有副作用?重试安全吗?参数里有没有
会出网的 payload?失败之后世界处于什么状态?

若没有统一注解基座,每个插件都会自造一份工具分类表:doc 04/08/09 的评审已发现
**重复注解风险**——permission-rules 自己维护 `fileEditTools`/`readOnlyTools` 清单,
verified-tools 需要幂等配方,token-wall 需要外泄分类,三份清单各自漂移、互相矛盾
(同一工具在 A 插件里是 readonly、在 B 插件里要审批)。Verified Tool Calls
(2608.02645)的核心前提是"工具调用携带可验证的效果声明";TokenWall 的前提是
"每个出口都有统一的披露分级"。两者都要求**唯一注解机制**(00 概述·共享原则 4)。

本包提供:`ctx.toolManifest` 服务 + 内置清单 + 用户覆盖层,是所有 gate/verify
类插件读取工具元数据的唯一入口。

## 现状与缺口

dsh 现状:`ctx.tools`(ToolRuntime)是 cordis 服务,`register(definition)` 注册
`ToolDefinition`(name/description/parameters + output schema + execute),经
waterfall `tools/pre-execute` → `tools/execute` → `tools/post-execute` 派发,另有
单调 guard 层。工具自描述只到 JSON Schema 层——**没有任何效果/幂等/外泄语义**。

permission-rules(dsh-cc-plugins)已示范了缺口:为做 plan-mode/acceptEdits 判定,
它在 Config 里内置 `DEFAULT_FILE_EDIT_TOOLS`、`DEFAULT_READ_ONLY_TOOLS` 硬编码
清单。这是"每个消费者自带一份工具分类"的第一处实例化;docs 09/10 落地后会变成
三处互不兼容的机制。缺口 = **一处权威、可覆盖、fail-closed 的 per-tool 元数据注册表**。

## 设计

### 表面与接缝

已逐一核实的接缝(文件:行号):

- **服务注册模式**(cordis `Service`):
  `dsh-cc-plugins/packages/interaction/permission-rules/src/index.ts:154`
  (`class PermissionRulesService extends Service`,构造函数内 `super(ctx, 'permissionRules')`,
  `static inject = ['tools']`,并用 `declare module '@deepseek-ai/cordis' { interface
  Context { permissionRules: ... } }` 做类型声明合并)。tool-manifest 照此模式挂
  `ctx.toolManifest`;`toolManifest` 键在 deepseek-harness 与 dsh-cc-plugins 两仓
  grep 零命中,无冲突。
- **工具枚举 API**(核心消费缝):
  `deepseek-harness/packages/core/tools/src/index.ts` 中
  `ToolRuntime extends Service`(:787,`super(ctx, 'tools')`),公共面:
  `get(name, scope?): ToolDefinition | undefined`(:1204)、
  `schemas(scope?): ToolSchema[]`(:1234)、`guard()`(:1114)、
  `tools/change` 事件(:207,注册/注销通知,供覆盖率 lint 增量刷新)。
  `ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }`
  (`deepseek-harness/packages/llm/llm/src/types.ts:333`)。
- **glob 匹配语义**(与 permission-rule 对齐):
  `permission-rules/src/parser.ts:27` `matchContent`——`*` 为通配、`:*` 为前缀,
  manifest 的 `pattern` 字段复用同一语义,避免第二套匹配方言。
- 执行流:`tools/pre-execute` 监听器形态见 permission-rules/src/index.ts:217。

工具枚举的**读取方向**:tool-manifest 监听 `tools/change` + 调用 `ctx.tools.schemas()`
做覆盖率统计;**绝不**反向要求 dsh 工具注册时携带新字段(上游零改动,纯插件侧叠加)。

### 数据模型 / 配置

```ts
// 单条清单条目(全字段除 pattern/description 外均可缺省 → 由默认值兜底)
interface ToolManifestEntry {
  pattern: string            // 工具名 glob,语义同 permission-rule matchContent('*' / ':*')
  description: string        // 人类可读的分类理由(审计用,不进模型上下文)
  effectClass?: 'readonly' | 'write-local' | 'side-effecting'
              | 'external-disclosure' | 'authority-change' | 'irreversible'
  idempotency?: {
    argFields: string[]      // 参与哈希的参数路径(如 ['file_path','content'])
    timeBucketSec?: number   // 时间桶粒度;0 = 不含时间(纯内容寻址)
  }                          // 确定性幂等键 = hash(argFields 值 + agentId + floor(now/bucket))
  retryProbe?: {             // 供 doc 10 verified-tools 重试前验尸
    kind: 'shell-command' | 'tool-call'
    command?: string         // kind=shell-command 时的探针命令(模板可引用参数)
    tool?: string            // kind=tool-call 时被调用的探针工具名(须为 effectClass=readonly)
    args?: Record<string, unknown>
    expect: string           // 后置条件表达式(如 exit=0 且 stdout 匹配 glob)
  }
  disclosureClass?: 'none' | 'egress-payload' | 'publish'
  failureSemantics?: 'atomic' | 'timeout-ambiguous' | 'partial-visibility'
}

interface ManifestFile {
  version: 1
  entries: ToolManifestEntry[]
  provenance?: { source: 'builtin' | 'plugin-declared' | 'user-overlay'; ref: string }
}
```

**来源优先级**(后者覆盖前者,同优先级内后注册覆盖先注册,load 时冲突告警):
`plugin-declared < builtin < user-overlay(~/.dsh/tools.manifest.json) <
project(.dsh/tools.manifest.json)`。覆盖以单条 entry 的字段合并为粒度,
provenance 始终随最终生效字段记录,供审计追溯"这条分类是谁定的"。

**fail-closed 默认姿态**(设计要点,非权宜):lookup 未命中任何 pattern 的工具,
返回合成条目 `{ effectClass: 'side-effecting', failureSemantics: 'timeout-ambiguous',
disclosureClass: 'none' }`(幂等配方缺省 = 不可重试)。理由:未知工具按有副作用、
超时后果含糊处理,是消费者(02/09/10)唯一安全的共同假设——宁可误拦、不可误放
(与 permission-rules 的 deny-缺省同源);`disclosureClass: 'none'` 看似放松,但
egress 判定由 token-wall 对 payload 内容独立把关,清单层不替它背锅。

### 关键行为流

- **注册流**:插件 `ctx.toolManifest.register(entries)`(返回 dispose,遵循 cordis
  惯例);builtin 清单随包装载;覆盖层在 start 时读文件,热更新走设置文件监听
  (重读 → 重建合并视图 → 触发 `tool-manifest/change` 事件,消费者重取)。
- **查询流**:`lookup(toolName)` → 按优先级从高到低取首个 pattern 命中的条目
  → 缺省字段逐字段回落到低优先级条目 → 全缺省回落到 fail-closed 合成条目 →
  返回 `{ entry, provenance, defaulted: string[] }`(标出哪些字段是兜底的)。
- **覆盖率流**:lint(见 M2)对 `ctx.tools.schemas()` 每个 `name` 调 `lookup`,
  凡 `defaulted` 含 `effectClass` 者记为"未覆盖",输出清单 + 建议条目骨架。

### 内置清单

供 M2 随包发布(JSON),逐工具分级理由:

| 工具 | effectClass | disclosureClass | failureSemantics | 幂等/理由 |
|---|---|---|---|---|
| `read`,`read_image`,`glob`,`grep`(fs-search) | `readonly` | `none` | `atomic` | 只读;幂等键 = path/pattern 参数,纯内容寻址 |
| `write`,`edit`,`str_replace_editor` | `write-local` | `none` | `atomic` | 改本地文件,失败即无写;幂等键 = file_path+内容哈希 |
| `bash`,`pwsh` | `side-effecting` | `egress-payload` | `timeout-ambiguous` | 命令可触网可改动系统;超时不代表未执行;不重试,retryProbe 由调用方自带 |
| `run_code` | `side-effecting` | `none` | `timeout-ambiguous` | 在代码运行时执行模型编写的程序;超时不代表未执行;绑定通信只在执行环境内 |
| `skill` | `readonly` | `none` | `atomic` | 仅加载指令文本入上下文,本体无写;引起的后续动作归后续工具负责 |
| `todo_write` | `write-local` | `none` | `atomic` | 会话内状态;幂等键 = 完整条目集 |
| `get_goal` | `readonly` | `none` | `atomic` | 纯查询当前目标与 revision |
| `create_goal` | `write-local` | `none` | `atomic` | 创建会话目标记录(要求直接人类请求);幂等键 = objective 文本 |
| `update_goal` | `authority-change` | `none` | `atomic` | edit/pause/resume/complete/blocked 改变会话续跑策略,属于权限/意图面变更,gate 类插件须单独过问 |
| `subagent` | `side-effecting` | `none` | `timeout-ambiguous` | 派生的子代理会自行调用工具;child 是否已启动在超时点不可知 |
| `report`(subagent 回报) | `write-local` | `none` | `atomic` | 只写父会话上下文 |
| `list_agents` | `readonly` | `none` | `atomic` | 纯查询 |
| `interrupt_agent`,`send_message` | `side-effecting` | `none` | `atomic` | 向运行中的子代理注入/中断——改的是另一个 agent 的运行,不是本地文件 |
| `job_output`,`job_list` | `readonly` | `none` | `atomic` | 纯查询后台任务状态与输出 |
| `job_kill` | `side-effecting` | `none` | `timeout-ambiguous` | 终止后台任务;已执行的步骤不因 kill 而回滚 |
| `ralph`,`workflow` | `side-effecting` | `none` | `timeout-ambiguous` | 编排 fresh-child / 多代理后台执行;提交后主执行体可能已在跑 |
| `web_search` | `external-disclosure` | `egress-payload` | `atomic` | query 出网至搜索提供方,本身就是披露动作;同一 query 重发不新增披露,幂等键 = query+日级时间桶 |
| `web_fetch` | `external-disclosure` | `egress-payload` | `atomic` | 默认注册(`packages/web/tool-web/src/index.ts:41,54`,`fetch: true`);抓取的 URL 本身即披露 payload |
| `lsp` | `readonly` | `none` | `atomic` | 对语言服务器表面的纯查询 |
| `terminal_open`,`terminal_close`,`terminal_list`,`terminal_read` | `side-effecting` | `none` | `atomic` | 创建/销毁/观察共享终端会话——open/close 会改会话状态,故不入 readonly |
| `terminal_send`,`terminal_signal` | `side-effecting` | `none` | `timeout-ambiguous` | 驱动终端会话内命令执行;超时不代表未执行(同 bash 家族理由) |
| `schedule_create`,`schedule_delete` | `write-local` | `none` | `atomic` | 只改写一条持久提醒记录;幂等键 = 记录字段(见脚注) |
| `schedule_list` | `readonly` | `none` | `atomic` | 纯查询提醒记录 |
| `session_search`,`session_trace`,`session_event_read`,`session_event_search`,`session_event_trace` | `readonly` | `none` | `atomic` | 对已持久化 session/事件历史的纯查询;幂等键 = 查询参数,纯内容寻址 |

schedule_create/delete 只改写一条持久提醒记录;该记录的用户可见效果(未来的通知)是延迟发生的副作用,而非本次调用即生效。schedule_* 是提醒,不是调度器。

- `fork` 不是独立工具:tool-subagent 注册一个工具,名字取自 `toolName` 配置
  (`packages/subagent/tool-subagent/src/index.ts:83`,默认 `subagent`;随包
  profile 还以 `subagent_fork` 别名暴露同一包)。提供方选择是
  `SubagentProvider` 层的事,不是 tool-manifest 的行。
- `plan` 是斜杠命令(`packages/plan/plan-mode/src/index.ts:271`,
  `commands.register`),不是工具;该包的工具是 `exit_plan_mode`,把完成的
  计划呈交直接人类评审——出现在 profile 中时归 `authority-change`
  (权限/意图面变更)。
- 动态 MCP 工具继续落入 fail-closed 默认条目(未知 →
  `side-effecting` / `timeout-ambiguous`);MCP server 作者可发布
  plugin-declared 条目让特定工具豁免。

## 里程碑切分

- **M1 — schema + loader + 服务**:类型定义与 schemastery 校验;多来源合并与
  字段级回落;`ctx.toolManifest`(`register/lookup/list` + `tool-manifest/change`
  事件)+ `declare module` 类型合并;单元测试覆盖:优先级、fail-closed 兜底、
  glob 命中、provenance 记录。
  验证: `pnpm typecheck && pnpm test` 全绿;单测断言未知工具 lookup 返回
  `side-effecting/timeout-ambiguous` 且 `defaulted` 非空。
- **M2 — 内置清单 + 覆盖率 lint**:内置核心工具 JSON 清单;仓库脚本
  `pnpm lint:tool-manifest` 对一个拉起全部核心工具的最小 dsh app 调
  `schemas()` 做覆盖报告,未覆盖工具列出并给出条目骨架;CI 挂为非零退出。
  验证: 脚本输出 coverage 100%(核心工具全命中);手动注销一个假工具条目后
  脚本退出码非零并点名该工具。
- **M3 — 消费者 API 冻结说明 + 文档**:README 写明 lookup 契约(返回值含
  provenance/defaulted、fail-closed 语义、change 事件),标注"02/09/10 的编译期
  依赖只许到本包类型出口";一份给 dsh-cc-plugins 的迁移建议(permission-rules
  硬编码清单可改读 manifest,运行时可选)。
  验证: 用一个 spike 消费端(仅 `lookup('bash')` 并打印)在本包类型出口上
  typecheck 通过;README 的契约段落与实现单测一一对应。

## 验证计划

1. M1/M2 的观察标准已内嵌于各里程碑"验证"行(单测 + 脚本退出码,均可在无 dsh
   运行时依赖的假 ctx 上跑,符合编译期零依赖约束)。
2. 集成冒烟:在孵化仓 examples 下用 `pnpm new:plugin` 骨架拉起 dsh app +
   tool-manifest,确认 `ctx.toolManifest` 挂载、`lookup('web_search')` 返回
   `external-disclosure` 且 provenance=`builtin`。
3. 回归门禁:00 概述要求的 CI 三连(typecheck/test/build)+ lint:tool-manifest。

## 风险与开放问题

- **scope 维度的枚举**:`ctx.tools.schemas(scope?)` 的 `scope` 语义(per-agent
  变体工具)未逐行核实——覆盖率 lint 是否需要遍历所有 agent scope,待 M2 落地时
  以 `grep -n "ScopeKey" packages/core/tools/src/index.ts` 核实并补测。
- **user-overlay 文件监听**:已核实——settings 面已自带该设施
  (`installSettingsSection` 加 `settings/updated` 提交事件,
  `packages/settings/settings/src/index.ts:863,:778`);剩余 open question 是
  overlay 应否做成 settings 命名空间(天然继承热更新),而非单独 watch 文件。
- **幂等键的 agentId 来源**:需要稳定的 per-agent 标识参与哈希;具体从
  `ToolExecution.agent` 取哪个字段,待 doc 10 立项时以其执行上下文为准核实。
- **内容级参数 glob**:pattern 只匹配工具名;若消费者需要"bash 的某类命令单独
  分级"(permission-rules 的 content matcher 场景),预留扩展位但本期不做,
  避免清单变成第二套权限规则语言。
