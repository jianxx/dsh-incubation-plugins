# 23 breeding-data-adapters — 育种数据源适配器(填 data-sources.md 的"待登记"位)

> 状态: design (not started) | Tier: 4(领域实例层) | 包: packages/domain/breeding-data-adapters | 依赖: 01 tool-manifest、10 verified-tools;15 evidence(论文面)、17 run-registry(dataset hash 字段)、21 domain-pack validator(均并行撰写中,以最终稿为准);消费者: 22 breeding-genomics-toolkit | 服务对象: breeding-ai-workspace `docs/data-sources.md` 登记流程

## 设计目标与用户问题

**目标**:为育种领域的数据源接入提供统一适配层——NCBI、Ensembl Plants 两个公共
库 adapter 先行,内部育种库以**契约模板 + mock 实现**占位,数据方登记后即实例化。
所有 adapter 产出同一个 **dataset descriptor**(数据集描述符),供 22 的计算工具
直接作为输入消费、供 17 run-registry 记录数据集 hash(均并行撰写中,以最终稿
为准)。本包正好是 breeding-ai-workspace `docs/data-sources.md` 里全部"待登记"
条目的机器侧落点。

**用户问题**:今天 agent 要给 GS 管线准备数据,只能临时写 curl 命令下载 VCF——
下载了一半断了不知道、文件是否完整没有校验、版本是哪天拉的说不清、license 从来
没人记、下次复用要重推一遍查询。数据源元数据散落在聊天记录里,不进
data-sources.md 登记,下游 qc 工具拿到的就是一个裸路径,谱系断在第一公里。

**非目标**(写清边界,防 scope 爬行):

- 不做原始测序 reads(SRA fastq/bam)的批量下载——TB 级,属内部库契约实例的
  范畴,公共 adapter 只拉元数据;
- 不做数据库写操作与论文摄取(前者越界,后者归 15);
- 不做数据清洗/格式转换——那是 22 的 qc 工具职责,adapter 只保证"拿到的字节
  与源方一致"。

## 动机

1. **工作区契约已经画好了位置,只缺机器执行**:`docs/data-sources.md` 规定了
   登记模板(来源/访问方式/鉴权/关键字段/样例查询/已知坑)与数据契约约定
   (字段 ID 权威、日期窗口显式、鉴权预热、不写入密钥),但条目全部"待登记"
   ——说明缺的不是文档规范,而是**能产出规范字段的可执行 adapter**。
2. **descriptor 是 22 与 17 的共同货币**:22 的计算工具需要"自描述的输入"
   (sha256 清单 + schema 引用)才能算幂等键与做输入校验;17 需要稳定的
   dataset hash 挂谱系。统一 descriptor schema 一次定义、两处消费,避免 22/17
   各自发明数据格式。
3. **GET-only 只读边界让安全面极简**:公共库接入全部走 HTTPS GET,无写操作、
   无认证 POST;manifest 一句 `egress=read-only` 即可被 09 token-wall(运行时
   可选集成)与 01 清单机制约束,内部库契约模板继承同一姿态。

## 现状与缺口

### dsh 主仓与孵化基座(逐一核实,文件:行号)

- 工具注册与 01 清单注解机制:同 22 所述(见 01-tool-manifest §表面与接缝);
  adapter 工具是普通 dsh 工具,manifest 条目见下文表格。
- **原子写**:`writeFileAtomic`(`deepseek-harness/packages/fs/fs-local/src/
  index.ts:36,200`)——descriptor 文件"先写临时文件再 rename",杜绝半截写。
- **命令执行**:`@deepseek-ai/dsh-shell` `run(spec)`(`packages/shell/shell/src/
  index.ts:93`)——下载经 curl/wget 模板或语言内 fetch,走沙箱语义。
- **遥测**:`session-telemetry/record`(`packages/session/session-telemetry/
  src/index.ts:43`)记录每次下载的 dataset_id / 字节数 / 耗时 / 校验结果。
- **缓存目录**:跨项目复用的公共库结果页磁盘缓存挂
  `dshHomePath('domain-breeding','cache',...)`(`packages/util/home-paths/src/
  index.ts:98`);数据集本体落项目侧 `data/`(见数据模型)。
- **15 / 17 / 21**:evidence(论文面)、run-registry(dataset hash)、
  domain-pack validator 均并行撰写中,本包按其工作项名与既定职责对接,最终以
  定稿为准(见风险 6)。

### breeding-ai-workspace(逐一核实)

- `docs/data-sources.md`:登记模板 + "公共数据库(待登记)"(点名 NCBI /
  Ensembl / UCSC 的参考基因组、变异位点、注释)+"内部育种数据库(待登记)"
  (系谱、表型、基因型、试验设计、环境数据;BLUPF90/ASReml 输入输出约定)。
  **本包的三个 adapter 与这张待登记清单一一对应。**
- 数据契约约定(同文件 §数据契约约定):字段 ID 权威、日期窗口显式声明、
  鉴权预热只写方法、密钥不入库——descriptor 的 `license` / `retrieved_at` /
  `auth` 字段即为这些约定的机器可读化。
- 七槽契约(spec §4.4):`raw/` 不可变输入,dated 文件名
  `YYYY-MM-DD-<source>-<slug>`;本包 `data/` 登记册与 `raw/` 的关系见数据模型。

**缺口小结**:数据源接入缺"可执行 + 可校验 + 可登记"三件套;判决标准(descriptor
schema)本包定义,登记动作(data-sources.md 条目)由 adapter 的 `--emit-card`
输出自动起草、人审入库(尊重工作区"新增数据集是对本文件的 PR"的契约)。

## 设计

### 表面与接缝

**三个 adapter(各一个 M)与 manifest(01)注解**:

| 工具 | 源 | effectClass | 幂等/重试 | 说明 |
|---|---|---|---|---|
| `ncbi_datasets` | NCBI E-utilities + Datasets(esearch/efetch、assembly/sra 元数据) | external-disclosure / write-local | GET 幂等;下载分文件 sha256 | api_key 走环境变量 `NCBI_API_KEY`,速率默认 3 req/s(无 key)/ 10 req/s(有 key),以官方文档为准 |
| `ensembl_plants` | Ensembl Plants REST(variation / genome / archive endpoints) | external-disclosure / write-local | 同上 | 速率默认 ≤15 req/s,以官方文档为准;尊重 `Retry-After` |
| `internal_registry` | 内部育种库**契约模板** + mock 实现 | write-local(mock)/ external-disclosure(实例) | 实例化时按模板填 | 数据方登记 endpoint/auth/dataset 类型/许可后实例化 |

全部 GET-only 只读外部网络:manifest 条目标注 `egress: read-only`(纯查询出网,
不写远端);下载完整性 = 每文件 sha256 校验 + descriptor 原子写;断点续传不依赖
Range(分文件粒度重下,简单可证)。

**与 22 的消费缝**:22 的工具参数(inputs、referencePanel.descriptorRef)接受
descriptor 路径或 dataset_id;22 侧读 descriptor → 校验 schema_ref 兼容
(`breeding.genotype/v1` 等,见 22 §数据模型)→ 把 `files[].sha256` 并入幂等键。
此契约在本包 DoD 中以 [联测] 锁定。

**各 adapter 的参数面**(dsh 工具 JSON Schema 层,全部只读动作):

- `ncbi_datasets.search({ db, term, retmax?, date_from?, date_to? })`:
  db ∈ `assembly | sra | biosample | bioproject`;日期窗口必填其一或显式省略
  (对齐工作区"日期窗口显式声明"约定);返回规范化命中列表
  `{ accession, title, organism, updated_at }[]`。
- `ncbi_datasets.fetch({ accession, kind: 'assembly' | 'sra-metadata',
  include_files?: glob[] })`:assembly 拉参考基因组/注释;sra-metadata 拉 run
  元数据表(不拉原始 reads——TB 级,显式超出本包范围,留给内部库契约实例)。
- `ensembl_plants.search({ species, region? | variation_id? })` 与
  `ensembl_plants.fetch({ variation_id 或 archive_id, include_genotypes?: bool })`:
  覆盖 variation 与 genome 两类端点;输出变异位点表(VCF/JSON 可选)。
- `internal_registry.fetch({ dataset_id })`:按契约模板定义的 kind 分发到
  对应读取实现;M3 只交付 mock(kind=phenotype/genotype 两例),
  真实实例化属于数据方登记后的后续工作项。

**与 17 的谱系缝**(并行撰写中,以最终稿为准):descriptor 的
`dataset_id + files[].sha256` 联合 hash 即 dataset hash,17 落 run 记录;
run_id 注入方式与 22 相同。

**与 15 的边界**(并行撰写中,以最终稿为准):15 evidence 覆盖论文摄取与引用
(呼应工作区 wiki / paper-ingest 面);23 覆盖数据。descriptor 允许带
`related_papers: [DOI]` 指针但不存论文内容,反之 15 不存数据文件——边界写清,
互不复制。判定示例:一篇 GWAS 论文的**原文 PDF 与解读**归 15(paper-ingest
已覆盖);论文 supplementary 里的**基因型矩阵文件**归 23(以一个
`source: internal`-类 adapter 或手工登记的 descriptor 承载);
"某数据集出自某论文"这一事实,两域各存指针、不存对方内容。

### 数据模型 / 配置

**dataset descriptor schema**(`schemas/dataset-descriptor/v1`,JSON Schema 随包
发布;落盘为 YAML 以同人读):

```yaml
schema: breeding.dataset/v1
dataset_id: ncbi-oryza-sativa-3k-core          # 全局唯一,<source>-<slug>
source: ncbi | ensembl-plants | internal
accession: PRJEB6180                            # 源内访问号(如 BioProject / SRA)
version: "2026-06-30"                           # 源数据版本或抓取日期视图
retrieved_at: "2026-06-30T08:00:00Z"            # ISO8601 UTC
files:
  - path: genotypes/core.vcf.gz                 # 相对 dataset 根
    sha256: <hex>
    bytes: 18793412
license: CC0-1.0                                # SPDX 表达式;未知填 UNKNOWN 并附 note
schema_ref: breeding.genotype/v1                # 指向 22 发布的输入 schema
related_papers: ["10.xxxx/yyyy"]               # 可选,指针到 15 的 evidence 域
provenance:
  adapter: ncbi_datasets@<version>
  query: "esearch term=...; efetch id=..."      # 可复现的最小查询
  auth_method: "env:NCBI_API_KEY"               # 只写方法,不写密钥
```

**落盘目录约定**:项目侧 `data/<dataset_id>/descriptor.yml` +
`data/<dataset_id>/files/**`,写入完成即视为**不可变**;同 accession 新版本另开
`dataset_id@version` 目录,绝不原地覆盖。对 breeding-ai-workspace 项目:
`data/` 是七槽之外的**登记册前缘**——项目决定采用某数据集时,把所需文件以
dated 命名登入 `raw/`(spec §4.4 的不可变输入位),`raw/` 条目回指
descriptor 路径;descriptor 本身永久留存,保证重推可复现。

**内部库契约模板**(`templates/internal-source/contract.yml`,M3):

```yaml
source_id: <kebab-case>          # 如 caas-breeding-erp
endpoint: <base-url>             # 不含密钥;连接串密码走环境变量
auth: { method: env-var, var: CAAS_BREEDING_TOKEN }   # 鉴权预热只写方法
datasets:                        # 数据集类型登记(系谱/表型/基因型/试验/环境)
  - kind: phenotype
    schema_ref: breeding.phenotype/v1
license: <SPDX 或内部授权文号>
rate_limit: { rps: <n> }         # 数据方给定后填写
known_pitfalls: [...]            # 对齐 data-sources.md 的"已知坑"
```

**配置**(profile 级):

```ts
breedingAdapters: {
  ncbi:    { apiKeyEnv: 'NCBI_API_KEY', rps: 3 }        // 有 key 升 10
  ensembl: { rps: 15, respectRetryAfter: true }
  cacheTtlDays: 30          // 查询结果页缓存;descriptor 与文件体永不自动失效
  dataDir: 'data'           // 项目相对路径
}
```

### 关键行为流

**流 1 — 查询**:adapter 暴露 `search(query)` / `fetch(accession)` 两个动作;
查询结果页进磁盘缓存(dshHomePath 下,TTL 可配);命中缓存的响应带
`meta: { cache: 'hit', fetched_at }`。速率限制由 adapter 内令牌桶强制,
超速率先排队而非报错。

**流 2 — 下载与校验**(核心正确性面):

1. `fetch(accession)` 解析源返回的文件清单(名称/大小;源方 hash 可得则记录);
2. 分文件下载到 `data/<dataset_id>/files/` 下的 `.part` 临时名,完成即
   本地 sha256;
3. 全部文件完成后,`writeFileAtomic` 一次落 `descriptor.yml`(先 `.tmp` 后
   rename);**任意一步失败:`.part` 保留供重试,descriptor 不存在** ——
   descriptor 存在即"该数据集完整可信"的单一信号,不存在半截态;
4. 重试场景:进程在文件 3/5 处被 kill → 重跑函数按已落文件清单跳过 1-2、
   重下 3-5,最终 hash 集合与一次性完成场景逐位一致(见 DoD [auto]);
5. 完成事件:`session-telemetry/record` 记 `breeding.adapter.download`
   (dataset_id/bytes/files/size),run 上下文(17 run_id)注入时同时挂谱系。

**流 3 — 登记起草**:`--emit-card` 按 descriptor 生成 data-sources.md 登记卡片
markdown(来源/访问方式/鉴权/关键字段/样例查询/已知坑六段),输出到 stdout
或 PR 草稿,人审后入库——adapter 不直接改工作区文件。

**流 4 — preflight**:每个 adapter 一个连通性探测(NCBI:einfo 一次轻量 GET;
Ensembl:`/info/ping`;internal:契约模板声明的 health path),输出
`{ source, reachable, latency_ms, auth_ok }` JSON,供 21 domain-pack validator
聚合(并行撰写中,以最终稿为准);探测失败不致命,降级为 warn 并在 run 记录
注明。

**流 5 — 端到端示例(为 genomic-selection 准备参考基因型)**:

1. agent 调用 `ncbi_datasets.search({ db: 'sra', term: 'Oryza sativa[orgn] AND
   "3000 rice genomes"', date_to: '2026-06-30' })` 拿到 BioProject accession;
2. `fetch({ accession, kind: 'assembly' })` 下载参考基因组;变异位点表经
   `ensembl_plants.fetch` 补齐;
3. 两份 descriptor 落 `data/ncbi-oryza-3k-ref/` 与
   `data/ensembl-plants-oryza-variation-<date>/`,sha256 全量校验;
4. agent 用 `--emit-card` 起草 data-sources.md 登记卡片,提 PR 人审入库
   (工作区契约:新增数据集是对该文件的 PR);
5. genomic-selection 项目把采用的数据以 dated 命名登入 `raw/` 并回指
   descriptor;此后 22 的 `genotype_qc` 直接以 dataset_id 开跑——输入侧
   谱系自始完整。

## 里程碑切分(每 M 一个 PR)

- **M0 — 包骨架 + descriptor schema + data/ 落盘机**:`pnpm new:plugin domain
  breeding-data-adapters` 脚手架;JSON Schema 发布;`data/<dataset_id>/` 落盘、
  `.part`/原子写/不可变约定、sha256 工具函数;fake-source 单测台(本地 HTTP
  桩,可注入中断/慢速/坏 hash)。
  验证:驱动方式 = 单测(fake-source 桩);可观察结果 = descriptor 通过 schema
  校验、中断注入后重试产物与单次完成逐位一致;通过条件 = 下文 DoD 的
  重试-hash 一致性断言在 M0 先行绿(用 fake-source)。
- **M1 — ncbi_datasets adapter**:E-utilities esearch/efetch + Datasets v2
  assembly/sra 元数据;api_key 环境变量;令牌桶限速;golden 查询集。
  验证:驱动方式 = golden 冒烟(固定 accession)+ 单测(mock HTTP);
  可观察结果 = 固定 accession 查询返回非空且必备字段齐(见 DoD)、限速
  令牌桶在 mock 时钟下可断言;通过条件 = golden 冒烟绿 + 无 key 环境也能
  以低档速率完成 smoke。
- **M2 — ensembl_plants adapter**:variation/genome REST;`Retry-After` 尊重;
  golden 查询集。
  验证:驱动方式 = 同 M1;可观察结果 = 固定 accession(variation id)返回
  非空且必备字段齐;通过条件 = golden 冒烟绿 + 429 注入时按 Retry-After
  退避(mock 时钟断言)。
- **M3 — internal 契约模板 + mock 实现 + emit-card + preflight 聚合输出**:
  契约模板 schema、`internal_registry` 的 mock 实现(内存假数据,演示模板
  实例化全过程)、`--emit-card` 登记卡片起草、三 adapter 统一 preflight
  report。
  验证:驱动方式 = 单测(mock 数据源按契约模板驱动)+ 快照测试;
  可观察结果 = mock 实例化产出合法 descriptor、登记卡片快照稳定、preflight
  report 三源字段齐;通过条件 = 契约模板缺必填字段时 loader 明确报错点名。

## 验证计划

1. M0–M3 观察标准内嵌于各里程碑"验证"行;除 golden 冒烟外全部可在无网络
   环境跑。
2. **golden 冒烟**[auto]:每 adapter 一个固定 accession 查询,断言返回非空、
   descriptor 必备字段齐(dataset_id/source/accession/version/retrieved_at/
   files[].sha256/license/schema_ref);CI 标 network-dependent 标签,允许
   单独频道失败重试,但不得静默跳过。
3. **下载韧性**[auto]:fake-source 注入"文件 3/5 处中断",重试后最终
   sha256 集合与一次完成逐位一致;断言 descriptor 不存在半截写(中途任意
   时刻 `descriptor.yml` 要么整体不存在、要么通过完整校验)。
4. **23→22 消费 e2e**[联测]:golden descriptor(或 fake-source 产出)的
   dataset_id 直接作为 22 `genotype_qc` 输入跑通:22 读 descriptor、sha256
   复核、幂等键纳入数据集 hash;17 侧断言 dataset hash 入 run 记录(以其
   定稿为准)。
5. 回归门禁:`pnpm typecheck && pnpm test && pnpm build` 全绿(共享原则 6)。

## 风险与开放问题

1. **速率限制与配额**:NCBI 无 key 3 req/s、Ensembl 以 `Retry-After` 为准——
   均"以官方文档为准"配置化;golden 查询集尽量小,大查询走异步批(ehistory /
   POST 不适用本包 GET-only 边界,超量查询留给人工批次)。
2. **GRIN / riceEMS 等性状库缺公开 API**:无 API 源不硬爬(robots/条款风险),
   一律走内部契约模板人为登记占位;条款允许后再实例化 adapter。
3. **源方元数据漂移**:Datasets v2、Ensembl REST endpoint place 都可能演进;
   golden 冒烟即漂移警报器,失败时按"源方变更"先修 adapter 再追 schema。
4. **license 字段的真实性**:adapter 只能原样记录源方声明,不做法务判断;
   `UNKNOWN` 时强制 `note` 字段说明获取途径,提醒人工确认。
5. **缓存与"最新"的张力**:结果页缓存 TTL 对外可配;descriptor 的
   `retrieved_at` + `version` 双字段保证"新不覆盖旧"——版本语义由源方决定,
   源方不版本化时以抓取日期视图兜底。
6. **15/17/21 接口漂移**:均并行撰写中,dataset hash 格式、validator report
   消费面以定稿为准;对接集中在 descriptor 一层,改动半径可控。
7. **大文件下载的磁盘水位**:descriptor 承诺文件大小,落盘前检查可用空间;
   不足直接 fail-closed 而不是写一半。

## 单元验收(Definition of Done)

- **[auto] golden 冒烟**:三个 adapter(M3 用 mock)各自固定 accession 查询,
  返回非空且必备字段齐,descriptor 通过 `breeding.dataset/v1` schema 校验。
  必备字段 = `dataset_id / source / accession / version / retrieved_at /
  files[](每个含 path+sha256) / license / schema_ref / provenance`;
  golden accession 清单随包维护(`tests/golden/README.md` 记录选取理由与
  上次人工复核日期)。
- **[auto] 下载韧性**:fake-source 中断重试后文件集合 hash 与一次完成逐位
  一致;任意中断时刻 descriptor 无半截写(整体不存在或整体合法)。
  附加断言:`.part` 残留不影响二次重试;磁盘水位不足时 fail-closed 且
  不留下任何部分文件。
- **[联测] 23→22 消费**:descriptor 引用(dataset_id)直接作为 22
  `genotype_qc` 工具输入跑通;sha256 复核、幂等键含数据集 hash、17 dataset
  hash 入 run 记录(以 17 定稿为准)。联测归口:本包提供 golden descriptor
  fixture 与输入断言,22 侧的 qc 执行与谱系断言由 22 的 DoD 覆盖。
