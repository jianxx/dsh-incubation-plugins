# 01 tool-manifest — 工具元数据共享基座

> 状态: design (not started) | Tier: 1(基座) | 包: packages/verification/tool-manifest | 依赖: 无(仅 cordis + dsh core 类型) | 消费者: 02 claim-contracts, 09 token-wall, 10 verified-tools

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
  `dsh-cc-plugins/packages/interaction/permission-rules/src/index.ts:153`
  (`class PermissionRulesService extends Service`,构造函数内 `super(ctx, 'permissionRules')`,
  `static inject = ['tools']`,并用 `declare module '@deepseek-ai/cordis' { interface
  Context { permissionRules: ... } }` 做类型声明合并)。tool-manifest 照此模式挂
  `ctx.toolManifest`;`toolManifest` 键在 deepseek-harness 与 dsh-cc-plugins 两仓
  grep 零命中,无冲突。
- **工具枚举 API**(核心消费缝):
  `deepseek-harness/packages/core/tools/src/index.ts` 中
  `ToolRuntime extends Service`(:787,`super(ctx, 'tools')`),公共面:
  `get(name, scope?): ToolDefinition | undefined`(:1204)、
  `schemas(scope?): ToolSchema[]`(:1234)、`guard()`(:1110)、
  `tools/change` 事件(:207,注册/注销通知,供覆盖率 lint 增量刷新)。
  `ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }`
  (`deepseek-harness/packages/llm/llm/src/types.ts:312`)。
- **glob 匹配语义**(与 permission-rule 对齐):
  `permission-rules/src/parser.ts:27` `matchContent`——`*` 为通配、`:*` 为前缀,
  manifest 的 `pattern` 字段复用同一语义,避免第二套匹配方言。
- 执行流:`tools/pre-execute` 监听器形态见 permission-rules/src/index.ts:216。

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
| `read`,`list`,`glob`,`grep`(fs-search) | `readonly` | `none` | `atomic` | 只读;幂等键 = path/pattern 参数,纯内容寻址 |
| `write`,`str_replace_editor` | `write-local` | `none` | `atomic` | 改本地文件,失败即无写;幂等键 = file_path+内容哈希 |
| `bash`,`pwsh` | `side-effecting` | `egress-payload` | `timeout-ambiguous` | 命令可触网可改动系统;超时不代表未执行;不重试,retryProbe 由调用方自带 |
| `skill` | `readonly` | `none` | `atomic` | 仅加载指令文本入上下文,本体无写;引起的后续动作归后续工具负责 |
| `todo` | `write-local` | `none` | `atomic` | 会话内状态;幂等键 = 完整条目集 |
| `goal` | `authority-change` | `none` | `atomic` | 改变 agent 目标栈,属于权限/意图面变更,gate 类插件须单独过问 |
| `subagent`,`fork` | `side-effecting` | `none` | `timeout-ambiguous` | 派生的子代理会自行调用工具;child 是否已启动在超时点不可知 |
| `report`(subagent 回报) | `write-local` | `none` | `atomic` | 只写父会话上下文 |
| `list_agents` | `readonly` | `none` | `atomic` | 纯查询 |
| `jobs`,`workflow`,`ralph` | `side-effecting` | `none` | `timeout-ambiguous` | 调度/编排后台执行;提交后主执行体可能已在跑 |
| `web_search` | `external-disclosure` | `egress-payload` | `atomic` | query 出网至搜索提供方,本身就是披露动作;同一 query 重发不新增披露,幂等键 = query+日级时间桶 |

(web_fetch 在上游已禁用,不入清单;若日后启用,默认 `external-disclosure` +
`egress-payload` + `publish` 仅当目标为公共站点。)

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
- **user-overlay 文件监听**:dsh 是否有现成配置文件 watch 设施(类似 settings
  的 installSettingsSection)未核实;M1 先一次性读取,热更新降级为 open question。
- **幂等键的 agentId 来源**:需要稳定的 per-agent 标识参与哈希;具体从
  `ToolExecution.agent` 取哪个字段,待 doc 10 立项时以其执行上下文为准核实。
- **内容级参数 glob**:pattern 只匹配工具名;若消费者需要"bash 的某类命令单独
  分级"(permission-rules 的 content matcher 场景),预留扩展位但本期不做,
  避免清单变成第二套权限规则语言。
