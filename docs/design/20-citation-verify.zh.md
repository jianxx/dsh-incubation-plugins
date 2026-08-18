# 20 citation-verify — 三层引用归因门(link / content / support)

> 状态: design (not started) | Tier: 3 | 包: packages/science/citation-verify | 依赖: 无编译期依赖;运行时能以 verifier 角色被 [19 evidence-registry](19-evidence-registry.zh.md) 注册为 claim_level 2/4 档;可选集成 15 scholar(编号预留,文档规划中)

## 设计目标与用户问题

**目标**:一个 `citation_check(claims[])` 工具 + 双审计门,把 agent 写出的每条带引用论断按三层判定——`link`(引用标识可解析、资源存在)、`content`(引文片段能在源文档中定位且与源 span 对齐)、`support`(源内容实质性支持该论断)——并产出版本化、可落盘复核的判决工件。

**用户问题**:用户在深研/综述类会话里拿到的产出"看上去有引用"——链接能点开、主题沾边——但没人核过"这条引用是否真的支撑这个论断"。标题只承诺了引用 UX,不等于证据链;假引用一旦进 wiki/报告/知识库,就只能靠用户人肉逐条点开核对,而这恰恰是他们以为自己已经外包出去的那份工作。

## 动机(为什么必要 — 引用外观 ≠ 证据支持)

两篇文献把这一层拆得很清楚,本设计直接沿其分层落地:

- **Cited but Not Verified**(arXiv 2605.06635):research agent 最危险的失败模式不是"没有引用",而是**有引用但不支持具体 claim**——输出链接可打开、主题相关,事实支持却显著弱于表层引用质量。该工作把 source attribution 评价显式拆为三层:Link Works / Relevant Content / Fact Check。本文档的三层判定即此三层的工程化命名:link = "链接有效",content = "内容对得上引文",support = "事实核查"。**Citation UX 不是 evidence verification**——这句话刻在动机里,提醒每一层都是独立闸门,过 link 不过 support 仍是失败。
- **Auditing RAG Hypotheses**(arXiv 2607.19415):把可归因检查从事后诊断推进为**生成即门控**——检索段用稳定证据 ID(`obs:`/`jump:`/`lit:`/`path:`)组装上下文并产出结构化假设,V1 门机械查"引用 ID 是否真实存在于上下文",V2 门做内容兼容性审计;报告 run 中 136 条假设 V1 **零无效引用**。结论:机械门放最前,能极便宜地消灭一整类幻觉;贵的语义门只对过了机械门的内容投资。

工程后果:第一,机械层必须先跑且必须全自动(doi/arxiv 解析 + GET/HEAD 或 scholar 命中),零模型成本;第二,semantic support 门的判决必须版本化落盘,否则不可复核——LLM 裁判的不可复现性在"风险 1"给缓解措施;第三,输出不是一句"pass/fail",而是逐层 verdict + 证据指针,供 [19 evidence-registry](19-evidence-registry.zh.md) 的 belief 门控当作 claim_level 2/4 档 verifier 证据消费。

## 现状与缺口

dsh 现状(已核实,见下节"表面与接缝"):

- 工具有统一注册面(`ctx.tools.register`,强制 output schema + render),工具结果契约准入属 doc 02 的轮级领地——**当前没有任何插件校验"外部文献引用"这个领域命题**。
- 统一观测出口存在:`session-telemetry/record` waterfall(ops channel),doc 02 已示范 `<plugin>/<op>` 命名法;doc 12 的 trial exporter 消费 ops 旗标做 L2 过程度量——审计日志有现成通道与下游消费者。
- scholar seam(15,编号预留的姊妹工作项,文档规划中)尚不存在;doi/arxiv 解析与 HEAD 可达性检查在仓内零先例。

缺口精确为三层:(a) 无引用标识解析与存在性检查(link);(b) 无"引文片段 ↔ 源 span"对齐(content);(c) 无"源实质支持论断"的裁决(support)。另有工程缺口:判决工件无稳定 ID、无落盘位置,审计不可回放。

**与 02 claim-contracts 的边界**:02 管**轮级诚实性**——agent 自述"测试已通过"是否和本会话的工具事件对得上账,判定域是**会话内事件**。本插件管**领域归因**——论断和它引用的**外部文献**是否对得上,判定域是外部世界。两层互不替代:一条 claim 可以轮级 supported(agent 确实调用了 web 搜索)而 citation 层 fail(搜到的那篇论文并不支持该论断)。

## 设计

### 表面与接缝(exact names + verified paths,文献锚点在动机节)

以下每条均在上游 dsh 源码核实;姊妹工作项(15)未落地的只出现在"风险与开放问题"与联测里程碑。

1. **工具注册缝 — `ctx.tools.register(definition)`**
   `deepseek-harness/packages/core/tools/src/index.ts:1037`(返回 dispose 函数)。
   注意硬性要求:`ToolDefinition` 必须声明 `output: { schema, render, presentationMeta? }`,
   否则即抛 `TypeError`(`:1039-1042`,已核实)。`citation_check` 的判定结果走结构化
   `output.schema`,`render` 负责给模型看的人类可读摘要。
2. **遥测缝 — `session-telemetry/record` waterfall**
   `deepseek-harness/packages/session/session-telemetry/src/index.ts:43`(签名),
   `SessionTelemetryRecord` 结构 `:55-`:`channel: 'ledger'|'ops'`、`severity`、
   `attributes`、`body`;sink `emit()` 非阻塞入队(:104)。ops channel 的 record
   带 `telemetry.op` attribute(同文件注释,已核实)。审计日志遵循 doc 02 的
   `claim-contracts/admission` 命名法:`cite-check/result`(逐 claim)、
   `cite-check/gate`(enforce 拦截)。
   重要性质:coordinator 对抛异常的 listener 做容纳处理(`coordinator.ts:205-216` 的
   `redact()`,`contain` 内运行,throw = 扣下该条 record,fail-closed)——
   我们的发射必须是 fire-and-forget,不依赖任何返回值。
3. **eval 导出对齐 — doc 12**
   [12-eval-harness](12-eval-harness.zh.md) 的 trial exporter 以插件归因 telemetry
   作为 activation 证据之一;`cite-check/*` op 记录作为本文档的 L2 过程度量落进
   trial transcript。schema 字段沿 12 的 head-line fingerprint 约定,不自造度量词汇
   (overview 原则 5);如有扩展需求,评审时与 12 对齐后修订本文档。
4. **19 注册点缝 — `cite://<check_id>`(空降契约)**
   [19 evidence-registry](19-evidence-registry.zh.md) 的 belief_update gate 要求
   `gate_ref` 可解析:本文档承诺 `cite://<check_id>` → 落盘工件
   `.science/cite-checks/<check_id>.json`,Artifact 内含 tools 版本、prompt 模板版本
   与逐层 verdict,供 19 的 M2 校验"引用可解析 + 档位达标"。格式即本文档
   "数据模型"一节,**19 只依赖这个 URI 契约与文件格式,编译期零依赖**。
5. **15 scholar seam 预留(可选运行时集成)**
   claim 携带 `evidence_id`(15 的稳定证据 ID,语形如 `lit:` 前缀)时,`citation_check`
   优先走 scholar 的 span 缓存做 content 比对,跳过 HTTP 抓取。此为**运行时可选集成**:
   15 未注册时同条 claim 走 HTTP 路径,行为不降级失败(判别逻辑见行为流)。编译期
   零依赖(overview 原则 1)。
6. **消费方挂点 — 不私改他人流程(空降契约)**
   enforce 档是**被消费者调用**的:写作 skill / Wave 3 science-report 在
   "提交/发布型"动作(写 wiki 页/report 终稿)前,把待发布段落里的引用论断交给
   `citation_check` 并把 `fail` 当出门条件。本插件**绝不**去改 other-plugins 的流程
   或注册 pre-execute 拦截别人的写工具——这是工具提供方 + 契约文档,而非守门进程。

### claim_level 档位映射(与 19 的注册契约)

[19 evidence-registry](19-evidence-registry.zh.md) 给假设标 `claim_level 1–5`,
每个 level 要求对应强度的 verifier 门。本插件承诺承担两档(映射表以 19 为准,
此处是 20 侧的自我声明,供 19 的 M2 校验比对):

| 19 档 | 语义 | 20 的承担面 | gate_ref 形态 |
|---|---|---|---|
| 2 规则校验 | 机械可判的形式检查 | V1 机械门(link + content) | `cite://<check_id>` 且结果里 V1 全 pass || 4 领域审计 | 语义级实质核查 | V1 + V2(含 support) | `cite://<check_id>` 且 results 含 support verdict |

档 3(执行复核)由 03 trace-gate 类运行证据承担,档 5(形式验证)超出本插件范围
——声明**不做**即契约的一部分:19 不应把 `cite://` 引用于 3/5 档,M2 的档位
校验应据本文档此表拒绝(防止"拿引用检查装执行复核"的档位僭越)。

### 数据模型 / 配置

`citation_check` 入参(JSON):

```ts
{
  claims: [{
    id: string                    // 调用方命名,结果回指
    text: string                  // 论断文本
    citation: {
      kind: 'doi' | 'arxiv' | 'evidence_id' | 'url'
      value: string               // doi 字面 / arxiv id / 15 的 evidence_id / url
      quote?: string              // 声明者给出的源文摘引,content 层的比对对象
    }
    importance?: 'low' | 'high'   // 默认 low;support 门抽样策略的输入(见 V2)
  }]
}
```

输出(`output.schema` 的形状,渲染摘要在 `render`):

```ts
{
  check_id: string                // 稳定 ID,cite:// URI 的最后段;内容寻址(输入+模板版本 hash)
  results: [{
    claim_id: string
    link:    { verdict: 'pass'|'fail', detail: string }   // 解析成功 + 资源可达
    content: { verdict: 'pass'|'fail'|'skip', detail: string } // quote 定位成功率;无 quote 时 skip
    support: { verdict: 'pass'|'fail'|'skip', score: number,   // 仅 V2 命中者跑
               rationale: string, judge: { model, template_version } }
    overall: 'pass' | 'fail'      // 见行为流的双门聚合规则
  }]
  totals: { pass: number, fail: number, by_layer: {...} }
}
```

判决工件 `.science/cite-checks/<check_id>.json` 落盘内容 = 输出全集 +
`{ tool_version, template_version, judged_at, source_meta(url/doi status, fetched_bytes_hash) }`,
作为 19 的 gate_ref 解引用对象与人工复核入口(doc 00 "无观察不声称",工件即观察面)。

插件配置(`config:` 段,三档继承 overview 原则 3):

```ts
{
  mode: 'off' | 'audit' | 'enforce'     // 默认 audit
  support: {
    threshold: number                   // score < 阈 → fail,默认 0.7
    judgeModel?: string                 // 独立裁判模型配置;默认与宿主同,风险 3 论循环
    samplePolicy: 'all' | 'high-only' | { sampleRatio: number }  // V2 抽样默认 all
    templateVersion: string             // 随包携带,升级时显式 bump
  }
  link: { timeoutMs: number }           // 默认 10s;HEAD 与 GET fallback 共用
}
```

### 关键行为流

**机械门(V1,全自动,零模型调用)**:逐 claim——`link`:`kind=doi` 解析为
`doi.org/<doi>`、`kind=arxiv` 解析为 `arxiv.org/abs/<id>` 后 HEAD(429/405/超时可
降级 GET 且 range 截断),2xx/3xx = pass,4xx/网络错 = fail;`kind=evidence_id` 时
查 15 注册表(缺席 → `link: fail, detail: 'scholar seam unavailable'`);`kind=url`
直接 HEAD。**同一条引用结果按 (kind, value) 会话内缓存**,报告重引用不重复打网。
link 层的 detail 代码表(data model 节已列)是审计与 golden set 断言的稳定接口。
`content`:`quote` 存在时——从 link 命中的源拉文本(或 15 的 span 缓存),规范化
(大小写/空白/连字符)后做包含与模糊包含(编辑距离 ≤ 5% 长度)双重判定,均失则
fail 且 detail 指出"quote 不在源中";HTML 源先剥标签取正文(readability 式提取属
实现细节)。`quote` 缺省时 `content: skip`(没有锚点就不装作核查过了,这是诚实性
约束,不是偷懒)。

**双审计门聚合**(Auditing RAG 的 V1/V2 映射):V1 = `link` ∧ (`content` 为 pass 或
skip);V1 失败者 `overall: fail` 直接短路——**不过机械门的内容不投资语义门**。
V2 = `support`:仅 V1 命中者进入,按 `samplePolicy` 抽样(`high-only` 时只跑
importance=high);LLM 裁判以固定模板(任务:给定 claim 文本 + quote/span,回答
0/0.5/1 的支持度与一句理由),`score < threshold → fail`。随包携带的模板 v1 大纲
(版本化对象,非自由 disclosure):角色("你是事实核查裁判,只依据给定源片段")→
输入三段(论断 verbatim / 引文 quote / 源 span 窗口)→ 输出契约(
`{support: 0|0.5|1, rationale: ≤40 字}` 的 JSON,禁散文)→ 判定提示("部分支持
或主题相关但不断言 = 0.5;源未谈及 = 0")。裁判不可用(配置缺模型)
时 fail-closed 为 `support: skip, verdict: fail` 仅当 mode=enforce,audit 档记
`unverifiable-style skip` 并在 telemetry 打 `severity: warn`(继承 EG-VAR 的
abstain-is-not-violation 语义,见 doc 02 动机节)。`overall` = 所有已跑层全过才 pass。

**双门在 Auditing RAG 坐标里的位置**:V1 门对应其"引用 ID 有效性"检查(Cited ID
是否存在于上下文),我们把它从 prompt 内 ID 泛化到 doi/arxiv/url 的存在性;V2 门
对应其"内容兼容性"审计。文献里 136 条假设 V1 零无效的乍看乐观数字,成立前提是
**证据 ID 由系统分配而非模型自造**——同理本插件要求 quote 为 verbatim 摘录、
evidence_id 为 15 分配,模型自由生成的标识符在 link 层天然大概率 fail(即文献中
机械门所消灭的那一整类幻觉)。

**三档行为**(overview 原则 3):
- `off`:工具仍可被显式调用(返回结果),但不发任何 telemetry,gate 挂点视为缺席。
- `audit`:正常判定 + telemetry(`cite-check/result` 逐条 + 汇总)。消费者可照常发布。
- `enforce`:同样的判定;约定消费者把 `overall: fail` 当发布 veto——
  本插件侧只保证**返回结构带有 fail 与层细节**,并额外发 `cite-check/gate` op
  (attributes 含 `check_id`, `failed_claims`)。veto 动作在消费者侧(空降契约,
  本仓不私改 skill/report 流程)。

**判决落盘与版本化**:每次调用落一工件(内容寻址 check_id = sha256(
canonical(claims + template_version + tool_version)),同输入重跑复用同 ID)。
support 模板升级即 bump `template_version`,历史工件永不可变——可复核性是
"LLM 裁判可审计"的承重墙(见风险 1)。

**审计遥测词表**(ops channel,命名沿 doc 02 先例、下游对齐 doc 12 导出):

| op | 触发点 | attributes | severity |
|---|---|---|---|
| `cite-check/result` | 每次调用一次(汇总) | `check_id`, `claims`, `pass`, `fail`, `v1_fail`, `v2_fail` | fail>0 时 `warn`,否则 `info` |
| `cite-check/gate` | enforce 且存在 fail claim | `check_id`, `failed_claims`(逗号分隔 id) | `warn` |

body 携带完整 results JSON(与落盘工件同形);按 overview 原则 5,若 12 落地后
导出 schema 另有约定,以 12 为准改词表、不改语义。

**15 集成路径**:`kind=evidence_id` 的 claim 直接拿 15 的 span 缓存做 content 比对,
不触碰网络;若 15 未部署,该 kind 在 link 层即 fail 并写明原因(不是 crash)。
这个偏好顺序反过来也服务 15:15 落地后,凡写库内容引用文献的都应优先给 evidence_id,
换取确定性的 span 对齐。

## 里程碑切分(每个 M = 一个 PR 粒度 + "验证:" 可观测标准)

- **M1 — link + content 机械层 + 工件落盘 + 单测**:`citation_check` 工具注册、
  doi/arxiv/url 的 link 解析(注入式 HTTP client,单测全 mock)、quote 规范化与
  span 匹配、`.science/cite-checks/` 工件写入、telemetry op 发射、
  `pnpm new:plugin science citation-verify` 骨架。
  **验证**: 驱动方式 = vitest 单测,mock HTTP 注入 200/404/429/timeout 四态;
  可观察结果 = 四态下 link verdict 正确,quote 在/不在源中的 content 判定正确,
  工件文件按 check_id 落盘且内容寻址(同输入二次调用复用同文件);
  通过条件 = `pnpm typecheck && pnpm test` 全绿,覆盖全部四态与规范化边界 case。
- **M2 — support LLM 裁判层 + prompt 模板版本化**:judge 实现(LLM 调用抽象,
  模型可配)、模板文件随包携带 + `template_version` 入工件、score 阈值判定、
  抽样策略、裁判缺席的 fail-closed/skip 分档。
  **验证**: 驱动方式 = 单测(mock 裁判返回固定 score)+ 一次真实模型冒烟
  (README 记命令与输出);可观察结果 = score 跨阈值翻转 overall、模板版本
  出现在每个工件、裁判缺席在 enforce 下产出 fail+skip 且在 audit 下产出
  warn telemetry;通过条件 = 单测全绿 + 冒烟工件人工可读。
- **M3 — 三档配置 + 审计日志完备化**:mode 解析(off 静默 / audit 记录 /
  enforce 加 gate op)、`cite-check/result` 与 `cite-check/gate` 全链路、
  README(含 graduation criteria 与给写作 skill/science-report 的接入说明)。
  **验证**: 驱动方式 = 合成调用序列(同输入在三档下各跑一遍);
  可观察结果 = off 零 telemetry、audit 有 result 无 gate、enforce 双发;
  通过条件 = telemetry 条目断言精确到 op 名与 check_id attribute。
- **M4 — 15/19 联测(运行时可选,不阻塞合入)**:15 落地后 evidence_id 路径
  走 span 缓存;19 以 `cite://<check_id>` 作为 claim_level 2/4 gate_ref 消费;
  完整跑一次"registry belief_update 引 20 判决"的端到端。
  **验证**: 驱动方式 = 脚本化会话(`dsh --profile headless` + llm-mock,
  参照 [12-eval-harness](12-eval-harness.zh.md) 当前接缝表);
  可观察结果 = 19 的 belief_update 对缺 gate_ref / 档位不足被拒、对
  合法 cite:// 引用接受,且 telemetry 链路完整;
  通过条件 = 端到端断言全过。15/19 未就绪时本 M 顺延,前三个 M 不受阻塞。

## 验证计划

- **层一(纯函数)**:link 规范化(doi/arxiv/url 全 kind)、quote 规范化与包含
  判定、抽样策略、阈值判定、check_id 内容寻址稳定性。
- **层二(mock 集成)**:注入 HTTP client 覆盖 2xx/4xx/429/timeout/畸形 URL;
  mock 裁判覆盖 score 全谱与超时;工件文件 round-trip。
- **层三(合成会话)**:`dsh --profile headless` + llm-mock 驱动写作场景,
  产出含伪造 DOI 的段落,断言 enforce 档下 `cite-check/gate` 出现且
  overall=fail(见 DoD 3)。
- **层四(golden set)**:30 条人工标注集(真支持 / 链接错 / 内容错 /
  不支持 四类,来源:公开论文 + 手工构造错配),机械层准确率 100% 为通过线;
  support 层 F1 ≥ 0.8 且对"链接错/内容错"全部判 fail(短路语义)。
  标注集与判定脚本入库(`bench/` 风格,不入 packages 发布面)。
- 门禁命令:`pnpm typecheck && pnpm test`(worktree 内先
  `bash scripts/link-worktree-deps.sh`,见 CLAUDE.md)。

## 风险与开放问题

1. **support 裁判的可复现性**:LLM 判断随模板与模型漂移。缓解:模板版本化入工件 +
   判决落盘 + 同输入内容寻址;再可复现性靠固定 `judgeModel`(不接受默认升级)。
   检查项:M2 落地钉一条"模板升级 → 历史工件 ID 不变、新工件版本即异"的测试。
2. **付费墙/反爬**:HEAD/GET 可能 403 但实际存在。策略:link 层 verdict 只表达
   "可达性",403/401 场景 detail 如实标注,不误报为不存在;support 层无源可读时
   按 abstain(skip)处理而非 fail(audit 档)。假阳性拦截代价高于假阴性放行,
   audit 档的松弛是有意的不对称。
3. **裁判模型与受检方同源的循环风险**:如果写作与裁判是同一模型的同一缺陷分布,
   "支持"判定可能系统性趋同偏高。缓解:`judgeModel` 可配为独立模型,README
   推荐异源配置;抽样策略在 enforce 档默认 `all` 而非抽样的原因也在于
   提高发现循环失败的概率。开放问题:是否需要 N 模型投票,待 golden set 数据说话。
4. **15 时间差**:evidence_id 路径在 15 落地前只提供 fail-loud 的退化行为。
   若 15 取消,该 kind 保留但降级为 alias-of-url —— 需要评审决议,不在本文档预断。
5. **check_id 内容寻址 vs 判决可调**:模板版本进 hash 意味着修模板即换 check_id,
   19 侧引用的旧 cite:// 仍然可解析(文件不动),但"同一论断重判"不会产生
   新工件——这是特性(历史可回放),需要在 19 文档里写清"gate_ref 是时点快照"。
6. **enforce 挂点的消费方纪律**:本插件只给 verdict,veto 与否在调用方;
   若消费方忘记检查 overall,fail 信息会静默丢失。缓解:enforce 档的
   `cite-check/gate` op 作为独立可审计面,doc 12 activation 检查可以把
   "有 gate op 但产出物仍发布"作为违例信号。检查项:M4 联测时验证。

## 单元验收(Definition of Done)

- [ ] [auto] golden set 30 条:机械层 link/content 判定准确率 100% 通过线,
  CI 挂为门禁(`pnpm test` 内嵌跑集)。
- [ ] [auto] golden set:support 层对标注集 F1 ≥ 0.8,且"链接错/内容错"两类
  全部判 fail(V1 短路语义的回归保证)。
- [ ] [auto] enforce 档负例:脚本化会话(headless + llm-mock)中伪造 DOI 的
  写作提交触发 `cite-check/gate` op,且 `overall: fail` 出现在返回结构。
- [ ] [auto] 审计日志契约:`cite-check/result` / `cite-check/gate` 的 op 记录
  含 `check_id` attribute 且 sink `emit()` 非阻塞(mock sink 断言非 await)。
- [ ] [auto] 工件可复核:同输入二次调用 check_id 复用、模板版本入工件、
  `.science/cite-checks/` 下文件不可变(写入失败测试)。
- [ ] [联测] 19 belief_update 以 `cite://<check_id>` 作为 claim_level 2/4
  gate_ref 的端到端接受路径(M4)。
- [ ] [manual] README graduation criteria 一节就绪;一次真实 profile
  下 audit 档跑 ≥5 个会话,人工抽查 gate op 无误拦。
