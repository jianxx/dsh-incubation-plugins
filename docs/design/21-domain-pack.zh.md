# 21 domain-pack — 领域知识注入的唯一合法形态:配置包 + preflight 校验

> 状态: design (not started) | Tier: 2(领域基座) | 包: packages/domain/domain-pack | 依赖: schemastery(schema 校验)、ctx.skills / ctx.tools(消费缝) | 消费者: 育种领域包(22 GBLUP、23 GWAS,规划中)、一切垂直领域接入方

## 设计目标与用户问题

**目标**:把"给一个通用 agent 装上某个科研领域"收敛为一张**机器可读的
`dsh.domain.yml` 配置包** + 一套 **preflight 校验器**:包声明领域名/版本/
工具引用/skills 目录/数据集适配器/环境要求,校验器逐项查证(命令存在?文件
存在?环境变量齐?可 import?值域合法?),有任何一项不过就阻断领域注册并给出
修复指引。装领域从"祈祷提示词写对"变成"跑校验器看红绿灯"。
**用户问题**:今天要把 agent 用于育种 GBLUP,用户只能把领域知识铺进提示词:
"记得 PLINK 在 /opt 下、表型文件第一列是 IID、GBLUP 要先求 G 逆——"提示词
既不可校验也不可复用;换一个项目、换一台机器,没人知道环境还成立不成立,
直到任务在中途炸掉、浪费数小时算力与上下文。

## 动机(为什么必要)

**"纯提示词灌注领域知识"是反模式**,证据是消融而非直觉:

- Vibe-FDTR(热物性反演工作流,llm-wiki/wiki/syntheses/
  scientific-research-agents.md)用配置驱动 + 过程化 skills 在两级 benchmark
  上达 100%/98.9% 成功率;消融后**去领域包 → agent-only 形态在真实多步任务上
  0%**,去 skills → 36.7%;同时较裸 code-agent 省 87.7% token、省 60% 时长。
  结论:经验证的**机器可读配置 + 过程化知识**是可靠执行的前提,提示词只是
  最后那层胶水。
- TRACE(2200+ 领域模块的 seismic discovery 系统,同综述)与"配置驱动包"
  同构:可枚举、可校验、可组合的**领域工件**才是规模化路径;它的强信号是
  domain tools + formal constraints + interpretable intermediate state,恰是
  本设计 skills/tools/preflight 三列的对应物。

主仓的 artifacts 面已就位:skills 有 provider registry、工具有 manifest
注解基座([01 tool-manifest](./01-tool-manifest.zh.md))、技能有治理管线
([08 skill-lifecycle](./08-skill-lifecycle.zh.md))。**缺的是把"领域"本身
立为一等 artifact**:一个能被打包、被版本化、被质门的单元。本插件的主体是
**校验器**——包只是它的输入,引擎(会话/执行)它一概不做。

## 现状与缺口

已逐一核实(路径:行号在"表面与接缝"逐项列出):

- 主仓 `packages/skill/skill` 是 skill 能力缝的 Service Definition:
  `ctx.skills` 聚合各 provider 目录、按名字裁决胜出者;provider 经
  `ctx.skills.registerProvider` 注册(08 deployment 已核,同文件技能注册
  `:440` 先例);`BUNDLED_SKILL_RANK` 与优先级模型就位。skills 目录被
  机器枚举消费,天然适配"domain-pack 挂一个 skills 目录"。
- 孵化仓脚手架 `scripts/create-plugin.mjs`(`pnpm new:plugin <group> <name>`,
  package.json `:18`)已把"新立包 + 注册构建面"流水线化:生成 package.json/
  tsconfig/src/index.ts/tests/README 骨架并回写 tsconfig.paths、project
  references、pnpm-lock、README Layout 表。domain-pack 的脚手架照此形态加
  一条 `pnpm new:domain-pack <name>`。
- cordis.patch.yml 装载链已核:主仓 `packages/boot/app-boot` 的 profile.ts
  定义 `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`(`:39`),app-boot
  index.ts 载入 bundle 的 patch 覆盖清单(`:213`  watched 路径、`:290`
  overlay patch list 装载);孵化仓 README 的两锚点 name 解析(安装侧优先,
  profile 目录兜底)保证 `@jianxx` 前缀包不被遮挡——domain-pack 作为 bundle
  成员可经现有 profile 机制装载,**不需要新装载器**。
- **缺口三件**:①`dsh.domain.yml` 的 schema 与版本约定不存在;②没有
  preflight 校验器——环境假设四散在提示词与 README;③没有准入档位——
  缺依赖时是阻断还是只告警,无处配置。

**明确不做**:不写执行引擎(工作流编排归会话与 [05 long-run-protocol](
./05-long-run-protocol.zh.md)、[18 hpc-runner](./18-hpc-runner.zh.md)
等消费方);不做远程 preflight 的执行通道(远程一档由 18 的 submit 模板
内嵌自检承担,见风险 R2);不替代 08 的技能治理(领域内 skills 仍走其
准入与效用统计,本插件只递送)。

## 设计

### 表面与接缝(verified + cited)

1. **schema 校验缝**:schemastery 是 cordis 生态 Config 的既定校验库
   (先例:`packages/jobs/tool-jobs/src/index.ts` 的 `export const Config:
   z<Config> = z.object({...})`;`packages/jobs/jobs-local/src/index.ts` 同款)
   ——domain.yml 的 schema 用同一库表达,错误消息自然带字段路径。
2. **skills 目录挂载缝**:`ctx.skills.registerProvider(create)`(08 引用到
   `packages/skill/skill/src/index.ts`;provider 决定来源、注册表聚合);
   domain-pack 以 provider 形态把包内 `skills/` 目录挂入聚合,source 标
   `custom`/包名,**优先级走既有 rank 模型**(`BUNDLED_SKILL_RANK = 600`
   作参照,领域包用略低默认,用户目录仍可压顶)。
3. **工具枚举与注解缝**:包引用的工具须是已注册工具——准入检查用
   `ctx.tools.get(name, scope?)` 形态(01 已核 `packages/core/tools/src/
   index.ts:1204`);manifest 注解要求经 01 的 lookup 判定,fail-closed
   合成条目(01"fail-closed 默认姿态")会让未注解工具在 audit 档被点名。
4. **装载缝**:bundle/profile 的 `cordis.patch.yml` 链(上文核实)负责把
   domain-pack 作为一个 cordis 插件装进 profile;domain-pack 本体遵守
   cordis function-plugin 惯例(`export const name/inject`,`apply(ctx)`),
   与 create-plugin.mjs 生成的 src/index.ts 骨架一致。
5. **命令与提示缝**:preflight 的手动重跑入口挂 `ctx.commands.register`
   (先例 `packages/feedback/command-feedback`、`08` deployment 皆引用)——
   `/domain-preflight [pack]`;模型的"为什么这个领域工具不可用",经
   system prompt section(05 seam 3 先例)在 enforce 档注入一节
   "该包当前被 preflight 阻断 + 修复指引",而不是散装进每次报错。

### 数据模型 / 配置

`dsh.domain.yml`(领域包的单一事实来源;版本化;YAML):

```yaml
version: 1
name: breeding-gblup            # kebab-case,同目录名
domain: animal-breeding         # 领域桶(分组/检索用)
description: GBLUP 评估管线(育种值、G 逆、交叉验证)
tools:                          # 本包额外注册的工具包引用(npm 名 + 版本约束)
  - package: "@jianxx/dsh-incubation-gblup-tools@^0.1"
skills: ./skills                # 目录;经 skills provider 缝挂入
datasets:                       # 适配器引用,不内嵌数据
  - name: pedigree
    adapter: "@jianxx/dsh-incubation-pedigree-adapter@^0.1"
    config: { format: plink-fam }
env_requirements:
  vars: [GBLUP_HOME]            # 必须存在
  python: ">=3.10"
preflight:                      # 可执行检查;逐项 id + 修复指引
  - id: plink-on-path
    kind: command-exists
    command: plink2
    fix: "module load plink/2.0 或安装 plink2 到 PATH"
  - id: gblup-home-readable
    kind: file-exists
    path: "${GBLUP_HOME}/bin/gblup"
    fix: "export GBLUP_HOME=<安装根>;确认 bin/gblup 存在"
  - id: phenotype-schema
    kind: env-schema
    path: "${PHENO_FILE}"
    columns: [IID, SIRE, DAM, phenotype]
    fix: "表型文件首列必须为 IID;检查表头分隔符为空格/Tab"
  - id: numpy-importable
    kind: import-probe
    module: numpy
    fix: "pip install numpy 或激活正确 venv"
```

preflight `kind` 枚举(M1 冻结四个,M2 起允许插件扩展注册新 kind):
`command-exists` / `file-exists` / `env-var` / `import-probe` / `env-schema`
(值域与列模式浅校验,**不**做数据统计审计——那是数据集 adapter 的事)。

**校验器输出形态**(machine + 人读双通道;失败即修复指引,不是裸错):

```json
{
  "pack": "breeding-gblup", "version": 1, "verdict": "fail",
  "results": [
    { "id": "plink-on-path", "ok": false, "kind": "command-exists",
      "observed": "exit 127 (not found in PATH)",
      "fix": "module load plink/2.0 或安装 plink2 到 PATH" }
  ],
  "mode": "enforce",
  "blockedRegistration": true
}
```

准入档位(schemastery Config,与 01/05 的三档哲学同构):

```ts
mode?: 'enforce' | 'audit' | 'off'   // 默认 enforce;audit = 亮红灯但注册照挂
rerunOnSessionStart?: boolean        // 默认 false:装载时跑一次,
                                     // 之后靠 /domain-preflight 手动重跑
strictSkillSource?: boolean          // 默认 true:包内 skills 必须经 08
                                     // 准入后才对模型可见(08 不在场则降级 warn)
```

### 关键行为流

**装载流**(cordis patch 装载 domain-pack 插件时):

1. 解析 profile 指定的包路径,读 `dsh.domain.yml` → schemastery 校验,schema
   非法 → 不注册任何领域资产,命令面与日志给出字段级报错。
2. 依法包声明跑 preflight 全项;记录 preflight 报告(落 `.dsh/domain-packs/
   <name>.report.json` + telemetry ops 词 `domainpack/preflight`)。
3. **enforce 档**:任一 fail → 阻断:不注册 tools、不挂 skills 目录;system
   prompt 注入"包被阻断 + 修复指引"一节;命令回报告。**audit 档**:全挂,
   报告 + prompt 节标明"亮红灯"。**off**:跳过 preflight(只 schema 校验),
   供开发期。
4. 全过 → 注册 tools(经 cordis 依赖包 apply)、挂 skills provider、登记
   datasets 适配器引用。

**手动重跑流**(`/domain-preflight [pack]`):重读 yml(热),重跑 preflight,
更新报告与 prompt 节;enforce 下由 fail→pass 的迁移即"解禁"——补注册此前
被阻断的 assets(幂等:已注册跳过)。刻意不经模型自动重跑:preflight 可能
触发 `module load` 之外的真实命令,自动触发时机归用户。

**模型面可见性流**:被阻断时模型在 prompt 中读到阻断原因与修复指引——
把"工具调用时才炸"提前到"会话开始即知情";audit 档下模型照常可用工具,
但 prompt 节持续标注风险。

**与 08 的交接流**:包内 skills 目录**不直接**进 `ctx.skills` 聚合,而是先
作为 08 的 intake 候选走完准入 lint(strictSkillSource=true 时),08 消耗
candidate→active 状态机胜出后才可见;08 不在场 → 降级直挂 + warn(adapters
断层,见风险 R3)。

**与 01 的交接流**:包引用的工具在装载时经 01 lookup 检查注解:
`effectClass` 缺省(fail-closed 合成条目)在 audit/enforce 两档均计一条
warn(不阻断,工具治理归 01;domain-pack 只做点名)。这让 22/23 包的工具
在 manifest 覆盖率 lint 中天然被盘点。

### 脚手架(new:domain-pack)

跟随 `scripts/create-plugin.mjs` 的既有风格新增
`pnpm new:domain-pack <name>`:

```text
packages/domain/<name>/
  package.json            # cordis peerDep 约定同 create-plugin
  dsh.domain.yml          # 骨架:version/name/domain + 一条 command-exists 示例
  skills/example-skill/SKILL.md
  src/index.ts            # 骨架:apply 读包路径 → 交给 domain-pack 校验器
  tests/<name>.spec.ts    # smoke:加载自身 yml 通过 schema 校验
  README.md               # 章节模板:领域简介/前置环境/preflight 说明/联测门槛
```

注册面与 create-plugin.mjs 一致(tsconfig paths / project references /
pnpm-lock importers / README Layout 行),并额外在 domain-pack 校验器的
发现清单登记一条(`packages/domain/<name>` 可被 profile 按名装载)。

## 里程碑切分

- **M1 — schema + validator 核心(一个 PR)**:`dsh.domain.yml` v1 schema
  (schemastery)、五种 preflight kind 执行器、装载流的三档准入、报告落盘
  与 telemetry。验证:{驱动方式: 以假 ctx(ctx.tools/ctx.skills/commands
  全 spy)装载三个 fixture 包——全过、单 fail、audit 档; 可观察结果:
  报告 JSON、注册 spy 的调用与否、prompt 节文本; 通过条件: enforce 单 fail
  包零注册且报错含 fix 字段;audit 档注册全发生且报告 verdict=fail}。
- **M2 — preflight 报告 UX + 手动重跑(一个 PR)**:`/domain-preflight`
  命令、报告阅读格式(表格 + 修复指引)、fail→pass 解禁补注册、热重读。
  验证:{驱动方式: 合成会话发命令(fixture ctx); 可观察结果: 命令回显、
  二次装载的资产差集; 通过条件: 重跑路径幂等——同一包连续两次 preflight
  不重复注册;fail→pass 后被阻断 assets 恰好各出现一次}。
- **M3 — new:domain-pack 脚手架(一个 PR)**:脚本扩展与模板;文档接入
  README。验证:{驱动方式: `pnpm new:domain-pack demo-pack` 真实执行;
  可观察结果: 产物树、typecheck 结果; 通过条件: 产物经 root vitest/typecheck
  全绿;骨架包被 domain-pack 校验器接受(schema 全过)——脚手架与校验器
  互为测试}。
- **M4 — 08/01 集成点(一个 PR)**:skills 入 08 intake 的接线(可选在场)、
  工具经 01 lookup 的注解盘点 warn。验证:{驱动方式: 假 ctx 分别提供/不提供
  08、01 服务键; 可观察结果: strict 档下 skills 先入 08 候选、不在场时降级
  warn;01 未注解工具被点名; 通过条件: 四种在位性组合行为均成断言}。

## 验证计划

1. **单元**:yml 解析与 schema 报错路径(缺字段/坏 kind/未知版本);
   五种 preflight kind 各自的 pass/fail/修复指引含字段;三档准入矩阵。
2. **负例 auto(DoD 核心)**:故意缺一个 preflight 依赖的 fixture 包在
   enforce 档被阻断,报错文本包含 fix 指引——这条用例就是 Vibe-FDTR 消融
   结论的最小工程化表达。
3. **天然回归**:22/23 两个育种包按本规范实现后,它们的装载/preflight
   即为 domain-pack 的集成回归——方案层面 M4 起把二者列入联测门槛。
4. **脚手架自检**(M3):产物过 typecheck + 门禁,骨架包被校验器接受。
5. **报告 UX 评审(manual)**:enforce 阻断的 prompt 节与命令回显各截一
   屏,评审"修复指引可读、不只是 id"。

## 风险与开放问题

- **R1 preflight 误报率的维护成本**:环境检查天然脆(PATH 差异、module
  系统、容器内外观感不一);误报会直接阻断领域,挫败感最重。对策:
  每 kind 配 `fix` 文档强制;audit 档供灰度;报告里每条带 `observed`
  原文,便于用户判真伪。开放:是否需要 per-check `severity: block|warn`
  覆盖(M2 后评审)。
- **R2 远程 preflight 的归属**:本地 preflight 过 ≠ 集群环境过(HPC 的
  module/配额/文件系统是另一世界)。分工已切:本地档属本插件;远程一档
  由 [18 hpc-runner](./18-hpc-runner.zh.md) 的 submit 模板在 sbatch 渲染
  产物内嵌自检段承担(集群侧 fail-fast),domain-pack 的 yml 里预留
  `preflight_remote: []` 命名空间但不实现执行通道。
- **R3 08 不在场的降级**:strictSkillSource 直挂会让 skills 绕过准入 lint;
  降级只有在 08 缺席配置(profile 未装 08)时才允许,且必须 warn——
  记录此敞口,不作为长期默认。
- **R4 yml 是配置不是代码的安全边界**:`env-schema`/`command-exists` 的
  path/command 字段可能被恶意包塞入危险探测命令(探测本身是只读,但
  side-channel 存在);M1 冻结的五种 kind 全部白名单化执行(无 shell
  拼接,command 直接 exec 不 expansion),扩展 kind 须经代码评审。
- **R5 多包共存与名冲突**:两个 domain-pack 同挂一个领域时 skills 名撞车
  由 ctx.skills rank 裁决(既有语义),本插件不引入第二套冲突规则;
  包级 version 只校验自身 schema 版本,不做依赖版求解(那是 pnpm 的事)。

## 单元验收(Definition of Done)

勾选口径:[auto] = CI 可断言;[manual] = 人工执行并回填证据;[联测] = 与
他包同仓联动的端到端断言。

- [ ] [auto] schema 全字段矩阵:合法 yml 通过;缺 name/version/坏 kind/
  未知 version 各自得到字段路径级报错。
- [ ] [auto] 负例核心用例:fixture 包缺一个 preflight 依赖,enforce 档
  阻断 tools/skills 注册(spy 断言零调用),报告含该 check 的 `fix` 指引
  且 `blockedRegistration: true`;audit 档同 fixture 全注册且 verdict=fail。
- [ ] [auto] 五种 preflight kind 各自 pass/fail 双路;fail 报告含
  `observed` 原文与 `fix` 字段;命令类 kind 不经 shell 解释(白名单执行
  断言:参数注入尝试不改变执行对象)。
- [ ] [auto] 手动重跑幂等:同一包连续两次 `/domain-preflight` 资产注册
  恰好一次;fail→pass 迁移后被阻断 assets 补注册且仅一次。
- [ ] [auto] telemetry ops 词汇:domainpack/load、domainpack/preflight、
  domainpack/blocked、domainpack/rerun 的 attributes 形状被 spy 断言。
- [ ] [auto] `pnpm new:domain-pack demo-pack` 产物树通过 typecheck + 全量
  vitest 门禁;其骨架 yml 被校验器接受(脚手架 ↔ 校验器互验)。
- [ ] [联测] 08 在场:包内 skills 以 candidate 身份入 08 intake,未 admit
  前不对模型可见;08 缺席:降级直挂 + 恰好一次 warn 遥测。
- [ ] [联测] 01 在场:包引用工具的 manifest 注解盘点产生 warn 清单
  (fail-closed 合成条目点名);不影响注册。
- [ ] [联测] 育种 22/23 包按本规范实现并通过自身 preflight——该两包的
  装载链路即天然回归用例;22/23 立项前以骨架 fixture 顶替,链接
  见 22/23 文档(规划中)。
- [ ] [manual] enforce 阻断 UX 评审:prompt 节 + `/domain-preflight` 报告
  各一屏截图,修复指引被评审者读一遍能直接行动。
- [ ] [manual] README 章模板在 demo-pack 产物上填出完整示例,链接回本
  文档 schema 段落。
