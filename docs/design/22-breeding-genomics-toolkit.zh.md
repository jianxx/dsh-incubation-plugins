# 22 breeding-genomics-toolkit — 育种基因组计算工具包(domain-pack 首实例)

> 状态: design (not started) | Tier: 4(领域实例层) | 包: packages/domain/breeding-genomics-toolkit | 依赖: 01 tool-manifest、10 verified-tools;14 evidence-spine、16 analysis-workbench、17 run-registry、18 hpc-runner、21 domain-pack 规范(均并行撰写中,以最终稿为准);配套: 23 breeding-data-adapters | 消费者: breeding-ai-workspace(中国农科院智能设计育种团队)`projects/genomic-selection` 及后续育种项目

## 设计目标与用户问题

**目标**:作为 21-domain-pack 规范(并行撰写中,以最终稿为准)的第一个领域实例,
为 breeding-ai-workspace 补上"计算层"——把基因型质控 / 填充 / GWAS / 基因组选择(GS)
四条管线封装成带幂等键、资源量级标注、强制 run 谱系的 dsh 工具。两条铁律:

1. **封装成熟工具,不自研统计算法**(plink2 / bcftools / Beagle / minimac4 /
   rMVP / GAPIT3 / R sommer / BLUPF90 家族);
2. **统计与参数决策人在环**——MAF/HWE 阈值、GWAS 模型选择、GS 模型族、交叉验证
   折数等科学判断由 agent 提出建议、人确认后执行,门控走 approval 层
   (共享原则 1),执行强度沿用 off/audit/enforce 三档(共享原则 3)。

**用户问题**:育种团队的 agent 工作区今天在文献/记忆层很强(扫文献、摄论文、
wiki 取证、复现状态机),但一个 GBLUP 都跑不起来——没有任何科学计算依赖,
`projects/genomic-selection/` 七槽骨架全是 `.gitkeep` 占位。没有封装层时 agent
跑计算的现状是:临时 bash 调 plink,参数散落在聊天记录里;断网重跑即重复计算;
结果没有 run_id、没有 sidecar、进不了谱系;统计阈值是谁拍的也无据可查。用户要的
是一条**可回放、可追溯、参数决策有人背书**的 qc → 填充 → GWAS/GEBV 管线。

## 动机

三个已核实的事实支撑立项:

1. **工作区成熟面在文献/记忆层,空白面正是计算层**。breeding-ai-workspace 的
   `skills/INDEX.md` 登记 8 个 active skills(paper-scan 双源 arXiv+OpenAlex、
   paper-ingest、wiki-query、paper-reproduce 状态机、innovation-scan 等),全部面向
   论文与知识;`pyproject.toml` 依赖面只有 dev 组 `[pre-commit, PyYAML]`,无任何
   GWAS/GS/科学计算依赖;首个计算项目 `projects/genomic-selection/` README 规划了
   "参考群体基因型+表型 → GBLUP/ssGBLUP 估 EBV/GEBV → 交叉验证 r/bias → output/
   报告"的完整管线,但七个槽位目前只有 `.gitkeep`。计算层是本包的填入位。
2. **计算封装的价值在编排与谱系,不在算法**。GBLUP/ssGBLUP/GWAS 的统计正确性
   直接决定育种选择决策,成熟实现已被领域反复校验;重写一遍只会引入风险。
   agent 的边际价值在于:参数 canonical 化、幂等不重复烧钱、谱系完整可回放、
   阈值决策留痕——这正是 01/10 基座已提供的通用机制,本包只做领域实例化。
3. **统计决策必须人在环**。GWAS 选 FarmCPU 还是 MLM、GS 用 GBLUP 还是 ssGBLUP、
   质控阈值放宽还是收紧,属于科学判断而非工程判断。工作区自身的 `rules.yml`
   契约(schema_version: breeding.rules/v1)就是为这类 deterministic hard rule
   预留的位置,本包的决策门控与之对齐:agent 提方案,人(approval 层)拍板,
   判定写入项目 sidecar 与事件日志。

## 现状与缺口

### dsh 主仓与孵化基座(逐一核实,文件:行号)

- 工具注册/枚举与 `tools/execute` 包装缝:见 01-tool-manifest §表面与接缝与
  10-verified-tools §表面与接缝(均已带行号核实)。本包四个领域工具是普通 dsh
  工具:注册走 `ctx.tools.register`,幂等/参数预校验/验后重试复用 10 的通用
  包装,不在本包重造。
- **ASK 门控**:`ctx.approval.request(...)` →
  `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
  (`deepseek-harness/packages/interaction/user-approval/src/index.ts:257`;
  结果类型 `types.ts:28`)。注意 `request()` 必须发生在 open turn 内;subagent /
  background 等无 answerer 环境返回 `'unavailable'` → fail-closed(见风险 7)。
- **命令执行**:经 `@deepseek-ai/dsh-shell` 抽象
  `run(spec: ShellExecSpec): Promise<ShellRunResult>`
  (`packages/shell/shell/src/index.ts:93`),走沙箱语义,不直接 `child_process`。
- **遥测**:`session-telemetry/record` waterfall
  (`packages/session/session-telemetry/src/index.ts:43`),本包的工具执行、
  决策门控、幂等命中事件以 ledger 记录汇入统一事件流(共享原则 5)。
- **状态落盘**:`writeFileAtomic`(`packages/fs/fs-local/src/index.ts:36,200`);
  领域级缓存目录(参考面板、引擎镜像元数据)挂 harness HOME:
  `dshHomePath('domain-breeding', ...)`(`packages/util/home-paths/src/index.ts:98`,
  `DSH_HOME_DIR_NAME='.dsh'` 于 `:12`)。
- **14 / 16 / 17 / 18 / 21**:evidence-spine 总纲("实证证据统一载体")、
  本地分析工作台(dataset 工具)、run registry(run_id / run_get)、HPC 提交器、
  domain-pack 规范与 validator —— 均并行撰写中,本包只按其**工作项名与既定
  职责**对接,最终接口以各稿定稿为准(见风险 8)。

### breeding-ai-workspace(逐一核实)

- `skills/INDEX.md`:8 个 active skills 全部位于文献/记忆层(见动机 1)。
- `pyproject.toml`:仅 dev 组依赖 `[pre-commit, PyYAML]`;科学计算能力为零。
- `projects/genomic-selection/README.md`:七槽参考实现占位;目标含 GBLUP /
  ssGBLUP / BayesB / RR-BLUP 模型族、EBV/GEBV 输出、预测准确度 r 与 bias 跟踪;
  明确"数据集契约见 docs/data-sources.md,本项目不复制 schema"。
- 七槽契约(`docs/specs/2026-06-26-breeding-ai-workspace-design.md` §4.4):
  `raw/` **不可变**输入(dated 文件名 `YYYY-MM-DD-<source>-<slug>`)、
  `output/` 交付物(dated 命名 `<date>-<artifact-type>-<slug>`)、
  `tools/` 项目私有脚本。本包产物遵循该布局,不另起目录规范。
- sidecar / 事件契约(`tools/trace-analyzer.py:35-82,196-198`):
  每次 run 落 `output/<id>.events.ndjson`,配对 `<id>.run.yml`
  (manifest 含 `checks.required[].gate_id`、`skills.invoked` / `skills.skipped`);
  事件类型含 `run.finished`(status=done)、`gate.finished`(gate_id+status)、
  `command.finished`(command_id+exit_code)、`gate.result`;
  AGENTS.md 另要求关键决策点写 `decision` 与 `evidence.used` 事件。
  **本包在工作区内跑动时产出的 sidecar/事件必须同构,否则 trace-analyzer 的
  `gate_not_run_but_done` 等检查会失效。**
- `docs/data-sources.md`:登记模板已就位,条目全部"待登记"——由 23
  breeding-data-adapters 填充;本包消费 23 产出的 dataset descriptor(见下)。

**缺口小结**:工作区有输入槽(raw/)、有谱系契约(sidecar+事件)、有文献大脑,
独缺一层"封装成熟生信引擎、自带幂等与谱系、统计决策可门控"的计算工具面。
本包即该层。

## 设计

### 表面与接缝

**dsh.domain.yml(领域清单)**:按 21-domain-pack 规范(并行撰写中,以最终稿
为准)声明本包的工具清单与 preflight 档位,preflight 结果供 21 validator 消费:

```yaml
apiVersion: dsh.domain/v1        # 以 21 规范定稿为准
pack: breeding-genomics-toolkit
tools: [genotype_qc, plink_filter, impute, gwas, genomic_prediction]
preflight:
  engines:                        # 每格"二选一/必备"档位
    genotype_qc:        { any_of: [plink2] }
    file_ops:           { any_of: [bcftools, vcftools] }
    impute:             { any_of: [beagle, minimac4] }
    gwas:               { any_of: [rMVP, GAPIT3] }          # R 包,要求 R>=4.2
    genomic_prediction: { any_of: ["R+sommer", blupf90] }   # sommer 为首选档
  environment:                    # 二选一,二档互斥
    backend: conda                # 或 container
    conda:     { env_file: environment.yml, lock_sha256: <hex> }
    container: { image: registry.example/breeding-gs:2026.06, image_sha256: <hex> }
  licenses:
    blupf90: user-provided        # 学术许可证,用户自备,包内不分发(见风险 3)
```

**四个领域工具 × manifest(01)注解**:每个工具都是 verified-tools 形态——普通
dsh 工具 + 01 清单条目。open 项:01 的 entry schema 未定义资源量级字段,本包以
`x-resources` 命名空间字段扩展挂在 plugin-declared entry 上(未知字段容忍度待
与 01 定稿核实,见风险 4):

| 工具 | 引擎 | effectClass | idempotency.argFields | x-resources(典型量级) |
|---|---|---|---|---|
| `genotype_qc` | plink2 | write-local | `[inputs_digest(run_id 无关), params]` | 2-4 cpu / 8 GB / 分钟级(5k×50k SNP) |
| `plink_filter` | plink2 | write-local | 同上 | 同上 |
| `impute` | beagle \| minimac4 | write-local | 同上(含参考面板指针) | 8-32 cpu / 32-128 GB / 小时级 |
| `gwas` | rMVP \| GAPIT3 | write-local | 同上(含模型参数) | 4-16 cpu / 16-64 GB / 十分钟-小时级 |
| `genomic_prediction` | sommer(R) 或 blupf90 | write-local | 同上(含 CV 折数/seed) | 4-16 cpu / 16-128 GB / 十分钟-小时级(ssGBLUP 见风险 2) |

一律 `disclosureClass: 'none'`(计算工具不主动出网;外部数据获取归 23,
外泄把关归 09 token-wall);`failureSemantics: 'timeout-ambiguous'` 配
retryProbe = 输出目录 `.done.json` 标记存在且 sha256 校验通过(10 的流 2 机制)。

**与工作区的物理接缝**(已核实,见"现状与缺口"):输入文件永远驻留项目 `raw/`
(或经 23 descriptor 引用,不可变);产物落 `output/`;sidecar `.run.yml` +
`.events.ndjson` 同构;强制 run_id(17)挂谱系。

**执行后端**:本地小数据(默认阈值 ≤5k 样本 × 50k SNP,可配)在 16
analysis-workbench 的本地执行面跑动;超阈值渲染 18-hpc-runner 的 submit 模板
(sbatch / bsub,模板随包附带 `templates/hpc/`)后提交。规模化阈值、队列名、
账号均为 profile 级配置,不写死。

### 数据模型 / 配置

**输入数据契约**(统一 schema,`schemas/` 目录以 JSON Schema 发布;23 的
descriptor `schema_ref` 指向此处;16 dataset 工具按同一 schema 消费):

- **genotype**:VCF(`.vcf.gz` + tabix 索引)或 PLINK 三件套(bed/bim/fam);
  版本化 schema id `breeding.genotype/v1`。
- **phenotype csv**(最小列集 + validator):每文件单性状;
  必需列 `id`(个体号,唯一非空)、`trait`(数值型表型值);
  可选列 `env`(环境/试点/年份批次)、`block`(区组)。
  validator 行为:id 重复 → fail;trait 非数值 → fail;env/block 缺失须整列缺失
  或给出显式 `NA`,半缺失 → fail(防止模型公式静默变化);schema id
  `breeding.phenotype/v1`。
- **pedigree**(可选):三列 `id,sire,dam`,首代亲本允许缺失;schema id
  `breeding.pedigree/v1`(ssGBLUP 必需,GBLUP 不使用)。

**幂等键配方**(工具级,与 01 `idempotency` 机制互补——01 管会话级参数去重,
本配方管跨会话的计算去重):

```ts
inputsDigest = sha256( concat( sort( inputs.map(f => f.sha256) ) ) )
idemKey = sha256({
  tool, engine, engineVersion, environmentHash,   // conda lock / container image
  inputsDigest, canonical(params)                 // params 键排序、数值归一化
})
// 输出目录存在同 idemKey 的 .done.json → 短路返回既有结果指针,不重复计算
```

`.done.json` 内容:`{ idemKey, engineVersion, outputs: [{path, sha256}],
run_id, finished_at }`——它同时是 10 verified-tools retryProbe 的 postcondition
证据与 17 谱系回放的落点。

**profile 级配置**:

```ts
breedingGenomics: {
  statsGate: 'off' | 'audit' | 'enforce'   // 统计决策门控,默认 audit
  backend: 'local' | 'hpc'                 // local → 16;hpc → 18 submit 模板
  scaleThreshold: { samples: 5000, snps: 50000 }  // 超此转 hpc
  engines: { impute: 'beagle', gwas: 'rMVP', gs: 'sommer' }  // 二选一默认值
  referencePanel: { descriptorRef?: string } // 指向 23 的 dataset descriptor
  resources: { hpc: { queue, account, walltime } }           // 渲染 18 模板用
}
```

### 关键行为流

**流 0 — preflight**(21 validator 复用):逐引擎探测 `any_of` 命中
(`plink2 --version` / `Rscript -e 'packageVersion("sommer")'` 等)、校验
conda lock / 容器镜像 hash 与 dsh.domain.yml 一致、BLUPF90 许可路径存在且非空;
产出 preflight report JSON(每格 pass/fail + 实际版本)。任一必需格 fail →
工具注册降级为"可用但执行即拒绝",report 写入 ledger。

**流 1 — 通用执行流**(四个工具共享骨架):

1. 参数 schema 预校验(10 的 `tools/pre-execute` 机制,违例 deny + corrective
   feedback)。
2. **run 挂靠(强制)**:执行上下文必须带 17 的 run_id(由 16/agent 会话注入或
   显式参数传入)。缺 run → fail-closed 拒绝执行并提示先登记 run——这是 14 总纲
   "实证证据统一载体"在本领域的具体化:任何计算产物必须可被 run_get 回放。
3. 统计参数若属"决策类"(阈值/模型族/CV 折数)且 statsGate=enforce → 进流 2。
4. 计算 idemKey;输出目录同键 `.done.json` 存在 → 短路返回
   `{ deduped: true, result: <.done.json 摘要> }`,ledger 记 `breeding.dedup-hit`。
5. 后端选择:规模 ≤ 阈值 → 本地(16 面);> 阈值 → 渲染 18 submit 模板提交,
   工具返回 pending 句柄,完成事件经 18 回收(并行撰写中,以最终稿为准)。
6. 引擎执行:渲染命令模板(plink2 / java -jar beagle.jar / Rscript 驱动脚本 /
   blupf90+ 参数卡),经 dsh-shell `run()` 或 18;stdout/stderr 留档。
7. 落产物:结果文件(按七槽 dated 命名)+ `.done.json`(writeFileAtomic)+
   sidecar/事件:`command.finished`(exit_code)、`gate.finished`
   (如 `gwas-schema-check`)、收尾 `run.finished`;`session-telemetry/record`
   记执行时长/资源/引擎版本。

**流 2 — 统计决策门控**(statsGate 三档):

- agent 生成 proposal:`{ decision: 'maf-threshold', value: 0.05,
  rationale: '...', expectedImpact: '...' }`;
- `enforce`:`ctx.approval.request({ reason: <proposal 摘要> })` →
  `allowed-once` 执行;`rejected/cancelled` 中止并回执;`unavailable`
  (background 无 answerer)fail-closed,proposal 落 `.run.yml` 的
  `pending_decisions` 等待人工追认;
- `audit`:直接执行,proposal 写 `.events.ndjson` 的 `decision` 事件 +
  `evidence.used`(工作区 AGENTS.md 既定字段);
- `off`:不生成 proposal(不推荐,仅调试)。

**流 3 — genomic-selection 参考串联**(端到端示例):

1. 23 adapter 取得 基因型 VCF + 表型 csv,descriptor 落 `data/<dataset_id>/`;
   项目 `raw/` 以 dated 引用登记。
2. `genotype_qc`:maf≥0.05、missing≤0.1、HWE p≥1e-6(statsGate 确认后)。
3. (可选)`impute`:Beagle 模板 + `referencePanel.descriptorRef`。
4. `genomic_prediction`:GBLUP(R sommer `mmer`/`mmer2` 内核;A 阵/G 阵构建、
   方差组分、GEBV 输出)+ 5 折交叉验证(折 seed 固定并记入 idemKey),
   逐折 r、bias 汇总 `results.json`(16 dataset/results schema,以定稿为准)。
5. 产物:`output/<date>-gebv-report.md` + `.run.yml` + `.events.ndjson`;
   trace-analyzer 复检无 high findings。

## 里程碑切分(每 M 一个 PR)

- **M0 — 领域包骨架 + dsh.domain.yml + preflight + 合成 fixture 工厂**:
  `pnpm new:plugin domain breeding-genomics-toolkit` 脚手架;domain yml loader;
  preflight 流 0 全量;fixture 生成脚本(固定 seed 的 200 样本 × 1k SNP 模拟
  基因型 PLINK/VCF + 模拟表型 csv,供全部后续 M 的单测复用);
  phenotype/pedigree validator。
  验证:驱动方式 = 单测(mock ctx 调 preflight 函数)+ fixture 生成器单测;
  可观察结果 = preflight report JSON 各引擎格命中/缺失明细、fixture 输出通过
  validator;通过条件 = 无引擎环境下 report 明确 fail 且点名缺失引擎、fixture
  两次生成字节一致(seed 固定)。
- **M1 — genotype_qc + plink_filter**:plink2 包装、QC 阈值参数化(maf/hwe/
  missing)、VCF↔PLINK 转换(bcftools/vcftools 档位)、流 1 全量(本地后端)。
  验证:驱动方式 = M0 fixture 单测;可观察结果 = QC 后 bed/vcf 通过 schema 校验、
  `.done.json` 携带 idemKey;通过条件 = 重跑同参数触发 dedup(引擎进程计数
  ===1),缺 run_id 调用被拒绝并提示。
- **M2 — impute**:Beagle/minimac4 命令模板渲染、参考面板 descriptorRef 解析、
  输出 VCF 回填 qc 链。
  验证:驱动方式 = fixture(无参考面板走 Beagle 无面板模式)+ 模板渲染快照
  测试;可观察结果 = 填充后 VCF 基因型列完整性校验通过、模板渲染与快照一致;
  通过条件 = 引擎缺失时 preflight fail 且工具拒绝执行。
- **M3 — gwas**:rMVP/GAPIT3 R 驱动脚本(FarmCPU/BLINK/MLM 模型参数化)、
  曼哈顿图/QQ 图产物、gwas 结果 csv schema(标记、chr/pos、p、effects)。
  验证:驱动方式 = fixture + 模拟 QTL 信号(表型按已知 5 个位点合成);
  可观察结果 = 结果 csv 通过 schema 校验、合成信号位点进入 top hits;
  通过条件 = 5 个合成位点全部落在结果 p 值前 1% 内(fixture 可断言)。
- **M4 — genomic_prediction + 管线集成冒烟**:GBLUP(sommer 首选,BLUPF90 家族
  可选档)、ssGBLUP 可选档(+pedigree)、候选群 GEBV 预测、5 折 CV 汇总
  results.json(r/bias);qc → GBLUP → CV 全链冒烟。
  验证:驱动方式 = fixture 全链 + 集成测试(本地后端);可观察结果 =
  results.json 通过 16 results schema 校验(以定稿为准)、
  17 run_get 可回放全链谱系(以定稿为准);通过条件 = fixture 上 CV 相关
  r > 0(合成信号下应显著 > 0)、谱系树完整(每步产物有 sha256 与 run_id)。

## 验证计划

1. M0–M4 的观察标准内嵌于各里程碑"验证"行;单测全部跑在合成 fixture 上,
   无需真实数据与网络。
2. **集成冒烟**[auto]:公开小数据(rice 3K 子集,或 M0 合成 fixture 放大版;
   文档附 `scripts/fetch-fixture.sh` 获取脚本,经 23 的 NCBI adapter 拉取)走
   qc → GBLUP → 5 折 CV,产出 results.json(16 schema 校验通过)+ 谱系完整
   (17 run_get 可回放)。
3. **工作区对齐检查脚本**[auto]:对目标项目断言七槽目录就位、sidecar
   `.run.yml` 字段(`checks.required[].gate_id`、`skills.invoked/skipped`)与
   `.events.ndjson` 事件类型(run.finished / gate.finished / command.finished /
   decision / evidence.used)同 trace-analyzer 期望一致;在
   breeding-ai-workspace 的 `projects/genomic-selection/` 上跑通。
4. **首个真实内部数据跑动**[manual]:checklist 见"单元验收"。
5. 回归门禁:`pnpm typecheck && pnpm test && pnpm build` 全绿(共享原则 6)。

## 风险与开放问题

1. **授权与数据合规**:内部育种数据(基因型/表型/系谱)的授权边界先行;包内
   不内置任何内部库连接,credentials 一律环境变量/预热命令(呼应工作区
   data-sources.md "不在本仓库写入密钥")。
2. **ssGBLUP 大矩阵内存量级**:H 阵内存 ≈ 8·N² 字节(5 万个体 ≈ 20 GB,
   10 万 ≈ 80 GB)。文档给出资源指引表并按 N 动态改写 x-resources;超本地阈值
   强制 hpc 档。
3. **BLUPF90 许可证**:学术许可、不可再分发——preflight 只检查用户提供路径
   存在可用([manual] 资产),包内不携带二进制;商业化部署由其许可证条款决定,
   列为使用方责任。
4. **manifest 扩展字段**:01 的 entry schema 未定 `x-resources`,loader 对未知
   字段的容忍度待与 01 定稿核实;若不容忍,退化为 description 内嵌机器可读
   JSON(M0 spike 定案)。
5. **R 生态钉版**:rMVP/GAPIT3/sommer 版本漂移会毁掉幂等键语义——conda lock
   或 renv.lock 必须随包;容器档以 image sha256 为准,升级镜像需显式 PR。
6. **impute 引擎敏感性**:Beagle 无面板模式仅适合小缺口;minimac4 需 m3vcf
   参考面板。preflight 只能浅检文件存在,面板与群体匹配性由 statsGate 的人判断。
7. **approval 在 background 环境 `unavailable`**:enforce 档下统计决策会
   fail-closed 成 pending_decisions;若实证发现体验塌方,M4 后评估"后台档自动
   降为 audit + 强制 pending 清单"。
8. **14/16/17/18/21 接口漂移**:五者均并行撰写中,本包所有对接点
   (results schema、run_id 注入、submit 模板、domain.yml apiVersion)以适配器
   层隔离,定稿后只需改适配层;开工顺序保证 M0/M1 只依赖已存在的 01/10。

## 单元验收(Definition of Done)

- **[auto] 集成冒烟**:公开小数据(rice 3K 子集或合成 fixture 放大版,
  `scripts/fetch-fixture.sh` 获取)走 qc → GBLUP → 5 折交叉验证,产出
  results.json 通过 16 results schema 校验(以定稿为准),谱系完整——
  17 run_get 可回放每个中间产物的 sha256 与 run_id。
- **[auto] 工作区对齐检查**:脚本断言 breeding-ai-workspace 七槽目录契约、
  `.run.yml` sidecar 字段与 `.events.ndjson` 事件类型兼容 trace-analyzer
  (在 `projects/genomic-selection/` 跑通,exit 0)。
- **[manual] 首个真实内部数据跑动 checklist**:
  (a) 数据授权书/审批记录就位;(b) 集群提交走 18 hpc-runner 模板、
  submit 命令人审后执行;(c) statsGate=enforce 下全部统计决策有 human
  approval 记录;(d) 结果(CV r/bias、GEBV 排名)经领域人审签;
  (e) sidecar/事件补齐进项目仓库,trace-analyzer 无 high findings。
