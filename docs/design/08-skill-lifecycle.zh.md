# 08 skill-lifecycle — 技能工件的准入、效用与回收

> 状态: design (not started) | Tier: 2 | 包: packages/skills/skill-lifecycle | 依赖: 无

## 设计目标与用户问题

**目标**:让技能包成为可治理的运行时工件——准入 lint(形状/资源完整/权限兼容/注入式指令安全)、效用追踪(candidate→active→archived 状态机)、可回滚的版本化存储与出处记录。
**用户问题**:技能目录只会越堆越多:从外面拷来的 SKILL.md 没人审,混进去一个带注入式指令或越权工具要求的坏技能没有任何拦截面;装上之后没人知道哪些真的在用、哪些在帮倒忙;改坏了没法回滚——技能库越大,检索干扰和供应链风险越大,而这一切今天完全不可见。

## 动机

Dynamic Agent Skills 综述把技能拆成八段 lifecycle(evidence acquisition、proposal、
verification/admission、organization/storage、retrieval/composition、maintenance/repair、
distillation/portability、governance/provenance)。`retrieveSkill` 只是中间段:
没有 admission、lineage、utility、rollback,技能库越大,生成错误就越被转化为
检索干扰(retrieval interference)与供应链风险。dsh 今天只有中段(注册 + 检索),
两段治理(准入、回收)缺失。三个补丁方向:

- **Progressive Crystallization**:技能应可被 circuit-breaker DEMOTE(回归/安全失败),
  freeze-once 不可接受 → 需要状态机与 demote 通道,而不是"导入即永久"。
- **SkillOpt**:技能文档的修订是 bounded edit + held-out 验证门 + rejection memory;
  rejection memory 思想直接搬到 admission(同 hash 重复导入直接拒,不重复 lint)。
- **SkillCorpus/SkillCenter**:语料级分发可行,但收益被覆盖率封顶且与 harness 耦合
  → utility 必须 in-situ 度量,不能假定。

运行时子集:八段中 acquisition(evidence 收集)与 distillation/portability(离线蒸馏、
跨 harness 移植)属离线管线,本文档不设计,仅在导入 lint 处留入口。

## 现状与缺口

八段 lifecycle 在 dsh 的现状映射(引用路径均相对 `deepseek-harness` 仓库根;"注入"细节见下节):

| 段 | dsh 现状 | 本工作 |
|----|----------|--------|
| 1 evidence acquisition | 离线(手写/外部搬运),无运行时需求 | 不做 |
| 2 proposal | `ctx.skills.register`(runtime 技能注册,`packages/skill/skill/src/index.ts:440`)存在,但无评审环节 | 复用为"已 admit 技能"的注册出口 |
| 3 verification/admission | **缺失**:任何 provider 产出的 candidate 直接进目录与工具 | **核心**:admission gate |
| 4 organization/storage | registry 有 rank/scope 层去重(`skill/src/index.ts:568-583`, `BUNDLED_SKILL_RANK=600` `:24` / `RUNTIME_RANK=250` `:27`),但无版本化、无内容寻址、无持久化 | 版本化 provenance store |
| 5 retrieval/composition | 已有:核心 `skill` 工具 + `<available_skills>` 目录(见下节) | 复用;rerank/组合不做 |
| 6 maintenance/repair | **缺失**:无使用统计、无效用信号、无 demote | utility 追踪 + demote 提案 |
| 7 distillation/portability | 无 | 不做(离线;导入 lint 提供入坞口) |
| 8 governance/provenance | **缺失**:无来源/哈希/版本记录,无回滚,无审计 | provenance schema + rollback + telemetry |

附加事实(已验证):`skills/change` 事件存在但无 payload,仅在 provider 注册/失效或
`control.invalidate()` 时触发缓存刷新(`skill/src/index.ts:297`、`649-660`);
注入侧双通道(目录 + 工具正文)都经由 provider 的 `list`/`get`,这就是 gate 的天然落点。

## 设计

### 表面与接缝(verified + cited)

1. **注册 API**:`ctx.skills.registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`
   (`skill/src/index.ts:391`);`Context.skills: SkillRegistry`(`:284-288`)。
   Provider 形状(`:248-268`):
   ```ts
   interface SkillProvider {
     readonly name: string
     list(o: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation>
     get(c: SkillCandidate, o: SkillLookupOptions): Promise<SkillDefinition | undefined>
   }
   ```
   `SkillProviderControl = { signal: AbortSignal; invalidate: () => void }`(`:271-276`)。
   技能记录:`SkillSummary`(`:56-71`:name / description / whenToUse? / invocation /
   source / provider / resourceBase?)、`SkillCandidate extends SkillSummary`
   (+ rank / locator / path? / metadata?,`:74-83`)、`SkillDefinition`(+ content,`:86-93`);
   `SkillInvocationPolicy = { modelInvocable, userInvocable }`(`:48-53`);
   `SkillSource` 联合类型(`:39`)。**核心类型没有 allowedTools 字段**,仅 opaque `metadata`。
2. **注入模型视图的两条通道**:
   (a) 模型可见的核心 `skill` 工具(`packages/skill/tool-skill/src/index.ts:81-161`),
   `execute` 走 `ctx.skills.list/get`(`:134/141`),正文经 `renderSkillContent` 包成
   `<skill_content>`/`<skill_instructions>` 注入 transcript(`skill/src/index.ts:171-184`);
   (b) `agent/pre-step` listener 注入持久的 `<available_skills>` 目录 user 消息,
   `source.kind: 'skill-catalog'`(`tool-skill:213-251`,渲染 `:254-277`),
   仅当本插件的工具注册解析成功(`ctx.tools.get(skillTool.name, agent) === skillTool`,`:220`);
   (c) 用户键入 `/name` 手势经另一 `agent/pre-step` listener 注入(`:177-204`)。
   ⇒ **admission gate 必须落在 provider 内部**:`list` 决定目录可见性(候选可被列出并标记),
   `get` 决定正文是否注入(candidate 态返回 `undefined` + 原因)。
3. **可包裹性(结论:不能包,只能替代)**:核心技能聚合走 `ctx.skills.list/get`,
   枚举**所有** provider(`skill/src/index.ts:552-620`),不存在"包住别人 provider"的
   中间件点;同名 provider 同层重复注册直接 throw(`:335-337`),无 replace/unregister;
   跨层是 scope 近层 shadow 远层(`:346-356`,合并 `:552-565`),同层重名技能按 rank 去重。
   ⇒ 本插件**自带 governed file-system provider**,在启用它的 profile 中不再启用核心
   `skill-filesystem`;对已注册第三方 provider 产出的技能不做拦截(文档 + profile 约束)。
   核心 `FileSystemSkillProvider` 类已导出(`packages/skill/skill-filesystem/src/index.ts:146`),
   可作委托目标(构造依赖见开放问题 1)。
4. **权限与工具授予**:`PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`
   (`packages/interaction/permission-rules/lib/types/types.d.ts:34`,
   `PERMISSION_MODES` 常量 `:36`);session 状态键 `'permission/mode': { mode: … }`
   (`packages/core/session/src/types.ts:343`)。工具授予通道:`ctx.tools.restrict(filter)`
   with `ToolRestriction { allow?, deny? }`(`packages/core/tools/src/index.ts:675-686,1071`);
   CC 格式 `allowed-tools` → `ToolRestriction` 的翻译仅在 vendored `skill-claude-code`
   的 lib 产物中存在(`packages/skill/skill-claude-code/lib/types/translate.d.ts:15-22`),
   dsh 内无运行时强制点 ⇒ grant-compat 检查由本插件在 admission 时做。
5. **其余 ctx 面**:`ctx.commands.register({ … })`(先例 `packages/feedback/command-feedback/src/index.ts:101`、
   `packages/session-query/session-log-export/src/index.ts:19`);配置用 zod `Schema<Config>`
   (先例 `skill-filesystem/src/index.ts:76`);文件读写经 `ctx.fs`(skill-filesystem 惯例)。

### 数据模型 / 配置

**治理记录**(与核心 `SkillCandidate` 解耦,本插件自有 store,按内容寻址):

```ts
type SkillKey = string            // `${provider}:${name}`
interface SkillVersion {
  contentHash: string             // sha256(SKILL.md 规范化内容)
  version: number                 // 同 key 单调递增
  sourcePath?: string; sourceUrl?: string
  importedAt: string              // ISO-8601
  parentVersion?: number          // 编辑血缘(SkillOpt bounded edit 的锚)
  lintReport: LintFinding[]       // 见下节
  grants: string[]                // 解析出的 allowed-tools
}
interface SkillGovernanceRecord {
  key: SkillKey
  activeVersion: number | null    // null = 从未 admit
  versions: SkillVersion[]        // 全部历史,contentHash 去重
  state: 'candidate' | 'active' | 'archived'
  rejectionMemory: string[]       // 被拒 contentHash(reimport 直接拒)
  utility: { invocations: number; lastUsedAt?: string
             followErrors: number; followCalls: number }  // 见行为流 2
}
```

**状态机**:`candidate → active → archived`;`archived → active` 只允许经 rollback
(指向历史 version)。每次迁移追加 audit 事件(actor: human|auto, trigger, reason)。

**配置**(zod;遵守共享原则 3 的执行强度连续谱):

```ts
Config = {
  mode: 'off' | 'audit' | 'enforce'          // enforce = 未 admit 不注入
  autoAdmitSources: SkillSource[]            // 默认 ['bundled']（trustedHost 根）
  candidateInCatalog: boolean               // candidate 是否列入目录(带标记),默认 true
  lint: Record<string, 'off' | 'warn' | 'block'>   // 每规则可调
  demote: { minInvocations: number           // 默认 20
            failureRatio: number             // followErrors/followCalls 阈值,默认 0.35
            staleDays: number                // 默认 60
            requireConfirmation: true }      // circuit-breaker 恒需人工确认
}
```

### 关键行为流

1. **发现 → admission → active**。governed provider 扫描技能根(委托核心
   `FileSystemSkillProvider` 或自扫,见开放问题 1);`list` 中对每个 candidate 查 store:
   - 未知 → 跑 admission 管线(顺序):shape → resource manifest → safety lint →
     grant-compat。结论:`active`(干净或来源可信)| `candidate`(干净但未确认,
     `candidateInCatalog` 时列入目录并在 metadata 打标)| 拒绝(写入 rejectionMemory,
     不入目录)。
   - 已知 → 按 store 状态:`active` 放行;`candidate`/`archived`:`list` 依配置列出,
     `get` 返回 `undefined`(正文不注入),拒绝原因为 lint 结论。
   - ASK 确认(人工 admit/demote)走共享 `approval/request` waterfall,不自造通道;
     listener 永不 throw(共享原则 1、2)。
2. **utility 追踪 → demote 提案**。`get` 命中即记一次 invocation(模型经 `skill` 工具
   加载正文必然过 `get`);outcome 用**代理信号**(明说,不排除误判):技能加载后紧邻的
   若干 tool call 的错误率(followErrors/followCalls)对照会返基线,结合 lastUsed 计算
   三类 demote 触发器——failure-correlated(超 `failureRatio`)、stale(超 `staleDays`
   未用)、security(lint 规则升级后旧版本复检不通过)。触发即生成 demote 提案
   (circuit-breaker,人工确认后执行 DEMOTE 到 `archived`);`utility` 数据进 report。
   真正收益留给 doc 12 eval-harness 做 held-out 判定。
3. **rollback**。store 按 contentHash 版本化;rollback = `activeVersion` 指回父版本 +
   `control.invalidate()`(触发 registry 缓存刷新 → `skills/change` → 目录重渲染)。
   任何时刻可 re-activate 任一历史版本;rejectionMemory 中的 hash 永不自动复活。

### 内置 lint 规则清单

每条:`{ id, severity: 'info' | 'warn' | 'block', message }`;`block` 在 enforce 下
落 `candidate` 或拒绝,`audit` 下只记录。初始规则集:

| id | 内容 |
|----|------|
| `shape/frontmatter` | 必需 `name` + `description`;`name` 过 `isSkillName`(skill 包导出);`disable-model-invocation` 正确映射 `SkillInvocationPolicy`(对齐 `skill-filesystem/src/index.ts:992-999`) |
| `shape/body` | 正文非空;无非法指令块 |
| `resource/manifest` | frontmatter 声明的引用文件全部存在于技能目录;`resourceBase` 与目录布局一致 |
| `safety/override-phrase` | 针对 agent 的命令式覆盖语("ignore previous instructions"、"do not follow"、"you must always/never" 等中英模式) |
| `safety/base64-blob` | 超过阈值(默认 128 字符)的 base64/hex 连续块 |
| `safety/network-egress` | 指令中出现非预期网络调用(curl/wget/fetch URL、webhook 地址、硬编码 IP) |
| `safety/secret-ref` | 引用凭据路径或环境变量外泄(`~/.ssh`、`$TOKEN` 拼接回传等) |
| `grant/resolvable` | `allowed-tools` 每个名字 `ctx.tools.get` 可解析;不可解析即 block |
| `grant/mode-compat` | 授予非空且当前 `'permission/mode' === 'plan'`(只读窗口)即 warn;`bypassPermissions` 下提高 egress/secret 两档 severity |

**rejection memory**:被拒 contentHash 持久化;重导同 hash 直接拒并附首次 lint 结论
(SkillOpt rejection memory 的 admit 侧移植),避免重复计算与"改名重导"绕过。

## 里程碑切分

每个 M 均为独立可合入 PR(`pnpm new:plugin skills skill-lifecycle` 脚手架起步,门禁全绿)。

- **M1: governed provider + admission 核心 + provenance store**
  file-system skill-dir provider(shape/resource/grant-resolvable 三条规则)+
  `SkillGovernanceRecord` store(经 `ctx.fs` 落盘,按内容寻址)+ `list/get` 门控 + 单测。
  验证:fixture 技能目录(齐形/缺 description/缺资源文件/不可解析 grant)各得预期结论;
  `active` 技能出现在 `<available_skills>`,被拒技能不出现;store 重启后状态保持。
- **M2: safety lint + 状态机 + `/skill-admin` + telemetry**
  safety 四规则与 mode 三档;`candidate/active/archived` 状态机与 audit 事件;
  `ctx.commands.register` 挂 `/skill-admin list|admit|archive|report`(命名理由:CC 用户侧
  `/skills` 是浏览/调用语义,治理域另起 `skill-admin` 避免歧义与冲突);
  迁移/发现写入 `session-telemetry/record` waterfall(共享原则 5,schema 对齐 doc 12)。
  验证:`/skill-admin admit` 后技能当轮可被 `skill` 工具注入;audit 模式下 block 级
  发现只记不拦;telemetry 事件字段与 doc 12 schema 一致。
- **M3: utility tracking + demote/rollback + import lint + docs**
  invocation/follow-error 统计;三类 demote 触发器 + 人工确认通路;
  rollback(re-activate 历史版本);批量导入 lint(`skill-admin import <dir>` 子命令
  或等价 repo script,输出逐技能报告);README(含 graduation criteria)。
  验证:构造高于 `failureRatio` 的合成事件流产出 demote 提案且未确认前不生效;
  rollback 后 `get` 返回旧 contentHash 正文且 `skills/change` 触发目录刷新;
  import 报告含每条 lint 结论与最终状态。

## 验证计划

- 单测:每条 lint 规则正/反例;状态机迁移单测(含 rollback 与 rejectionMemory);
  store 持久化往返。
- 集成:fixture 技能目录全套(良性/injection 文案/base64 blob/egress/坏 grant/
  缺资源)→ provider → 断言目录内容与 `skill` 工具 `get` 行为;`skills/change`
  失效路径冒烟。
- 手测:真实会话内 `/skill-admin list → admit → 调用 → report → archive → rollback`
  全链路;audit 与 enforce 两档各跑一遍同一 fixture。
- 观测:report 输出 lint 发现分布、误拦率(audit 数据),作为毕业标准 (c) 的证据。
- 门禁:三连全绿;转向验证前按工作流先回 plan mode 明确可观测通过标准。

## 风险与开放问题

1. **委托核心 fs provider 的实例化**:类已导出(`skill-filesystem/src/index.ts:146`),
   但构造签名/对 `ctx` 的依赖未核实。检查:读该文件 constructor 与 `apply`(`:130`)
   的组织方式;若不可独立实例化,退回自扫目录(逻辑薄,仅 frontmatter 解析 + 根枚举)。
2. **`permission/mode` 的插件侧读口**:状态键已确认(`core/session/src/types.ts:343`),
   具体订阅/读取 API 未验证。检查:其它插件如何读 session 状态(找 `permission/mode`
   的消费方,grep 全仓)。
3. **follow-error 统计的事件名**:`agent/post-tool` 或等价工具结果事件未验证。
   检查:梳理 `packages/core` 的 agent 事件表,确认工具调用完成事件及 error 字段。
4. **插件持久化目录**:state 解析 API 未验证。检查:现有有状态插件(如 memory 系)
   经哪个 ctx 服务落盘。
5. **未治理旁路**:profile 同时启用核心 `skill-filesystem` 时,未过 gate 的技能仍进目录
   (聚合语义,`skill/src/index.ts:552-620`)。缓解:文档硬性约束 + 近层 shadow
   (`:346-356`);长期可在 doc 06 control-plane 加 profile 一致性检查。
6. **candidate 的目录呈现**:catalog 渲染属 tool-skill(`tool-skill:254-277`),不 fork
   它 ⇒ candidate 标记只能进 `metadata`,渲染端是否展示不可控;可接受(默认
   `candidateInCatalog: true` 仅为可见性,注入已被 `get` 闸住)。
7. **启发式 lint 的天花板**:误报(误拦良性技能)与绕过(改写文案)都不可避免;
   以 audit 实跑数据调阈,block 规则保持少而准;jailbreak 级对抗不属于本包目标。
8. **非目标(显式)**:运行时技能组合 / 检索 rerank(SkillCorpus 式)与离线技能合成 —
   均不做;覆盖与收益判定作为 follow-up,由 doc 12 eval-harness 提供 held-out 度量后再议。
