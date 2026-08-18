# 18 hpc-runner — 科研重计算的 HPC/云批后端与计算级断点续跑

> 状态: design (not started) | Tier: 2(领域基座) | 包: packages/compute/hpc-runner | 依赖: 主仓 ctx.jobs 生产者缝(形态 A;M0 spike 裁决) | 消费者: 育种领域包(22 GBLUP 首跑)、一切小时级计算任务

## 设计目标与用户问题

**目标**:为科研重计算(GWAS 全基因组扫描、GBLUP 大矩阵求逆、量子传感的长时间
采样分析这类分钟到数十小时量级的作业)提供一条 agent 可达的 HPC/云批执行通道:
作业描述生成 → 集群提交 → 状态轮询 → 日志与产物回收 → **计算级断点续跑**
(进程被 kill、集群节点回收、会话换窗之后,从 checkpoint 指针续算而非从头再来)。
**用户问题**:今天用户让 agent 跑一个 8 小时的 GBLUP,agent 只能在本地 bash 里
硬等(上下文烧光)或者拼一串 ssh/sbatch 裸命令:提交后没人跟踪状态、节点失败
后毫无续跑机制、长会话中途换窗时正在跑的作业变成无人认领的孤儿。agent 会写
计算代码,却不会"养"一个计算任务。

## 动机(为什么必要)

三条独立证据轴共同指向"科研 agent 必须有受管的重计算通道,而它今天不存在":

1. **任务尺度证据**:量子传感等研究现场的单个分析/控制任务已是数十小时量级
   (llm-wiki/wiki/syntheses/scientific-research-agents.md 综述中量子传感报告
   18.9h 级长任务);XFEL(From Overload to Insights,同综述)的 21 条系统需求里
   明确包含 **HPC 访问**与"不向第三方传输用户数据"——重计算与数据驻留是科研
   设施的硬约束,不是可选优化。
2. **主仓位形**:dsh 主仓的 `packages/jobs`(后台作业注册表 + 生产者模型)与
   `packages/e2b`(provider-composition 远程执行世界 POC)证明"通用执行基座 +
   可换 provider/生产者"是主仓认可的架构方向;但主仓现存的生产者只有
   `bash`/`subagent` 两种本地 kind(`types.ts` 的 `JobKindMap` 初始条目),
   没有任何"集群提交型"生产者先例。
3. **会话尺度的天然对齐**:HPC 作业与 [05 long-run-protocol](
   ./05-long-run-protocol.zh.md) 的长跑对象是同一枚硬币的两面——会话会换窗,
   计算不能死;05 的 handoff 约定"只传验证过的状态指针",正好为"跑中作业移交"
   提供了已立项的协议载体。

不做这件分析级工作流的直接后果已在研发现场出现:育种团队的 GBLUP 首跑既需要
这条通道(见 M3 之后的联测门槛),也是它的第一个真实验收场景。

## 现状与缺口

已逐一核实(路径:行号在"表面与接缝"逐项列出,均为主仓
/Users/bytedance/workspace/github.com/deepseek-harness 当前工作树):

- `ctx.jobs` 是 cordis 服务键上的 **JobRegistry** 抽象(`declare module` 声明
  合并),进程内提供者是 jobs-local 的 `LocalJobRegistry`(纯内存簿记)。
  生产模型是 **producer-driven**:任何人可经声明合并扩展 `JobKindMap` 增加
  新 kind,再以 `JobStart{kind, label, owner?, run(): JobHooks}` 调
  `ctx.jobs.start` 注册作业;"生产者拥有执行资源,运行时拥有身份与生命周期",
  与 HPC 提交者角色天然同构。**这是已确认的扩展点形态**。
- tool-jobs 插件已在该缝上挂出模型面控制器:`job_output`(有界 wait)、
  `job_list`、`job_kill`,并把完成通知经注入/busy 或 wakeup/idle 送达属主
  agent——新 kind 的作业**免费继承**这套工具面与通知流。
- schedule 包提供 durable 的一次性/固定频率提醒(agent 作用域,落 session
  event log),固定频率下限 `MIN_EVERY_INTERVAL_SECONDS = 300`——可作
  低频轮询驱动,但不能做秒级心跳。
- **缺口三件**:①没有任何 HPC/云批生产者(sbatch 渲染、提交、状态机映射、
  日志回收);②没有**计算级**断点约定——jobs 的生命周期只管到"作业终态",
  不管"作业内部的 checkpoint_rev";③没有跨会话/跨重启的作业移交——
  jobs-local 是纯内存注册表,进程重启后注册表清空而集群作业仍在跑,
  需要 re-attach 约定。

**明确不做**:不搬运数据(数据位置与移动策略归 sandbox/approval 层,本文档只
声明边界);不做调度器策略优化(队列选择由用户/包配置,不自动调优);不替换
jobs-local 注册表(它是身份与生命周期簿记,见"形态裁决")。

## 设计

### 表面与接缝(verified + cited)

1. **生产者注册缝(形态A 的枢纽)**:`JobKindMap` 是为声明合并设计的开放 map:
   "Plugins extend this map by declaration merging"
   (`packages/jobs/jobs/src/types.ts:23-26`,初始条目 `bash`/`subagent`);
   `ctx.jobs.start(spec: JobStart): JobId`(`packages/jobs/jobs/src/index.ts:82`),
   `JobStart = { kind, label, outputLimitBytes?, owner?, run(): JobHooks }`
   (`jobs/src/types.ts:46-70`);`JobHooks = { cancel(reason?): void,
   done: Promise<JobOutcome>, readOutput?(): string }`(`:72-95`)——
   done **必须在进程层面 resolve 于资源释放之后**,与"HPC 作业到达终态且
   日志已拉取"的语义对齐;owner 缺省则成为 unowned job,支持跨会话认领前的
   暂存形态。owner 绑死注册时的 Agent,"agent 处置即取消并等待作业"——
   **对 HPC 作业这是错误默认**:取消 hooks 必须区分"会话死了,作业续跑"
   与"用户真要 scancel",详见关键行为流的取消语义。
2. **生命周期与终态**:`JobStatus = 'running'|'stopping'|'completed'|'killed'|
   'failed'`(`types.ts:17`),终态恰好一值;生产者专属事实放
   `JobSnapshot.detail`(队列名、slurm 状态、checkpoint_rev 摘要)。
3. **模型面工具继承**:tool-jobs 的 `job_output/job_list/job_kill`
   (`packages/jobs/tool-jobs/src/index.ts:260/334-392`,internal 经
   `ctx.jobs.wait/read/list/get/kill`,`packages/jobs/jobs/src/index.ts:90-133`);
   完成通知由 `ctx.jobs.onJobDone`(`:143`)驱动,tool-jobs 按
   `CompletionDelivery` 注入 busy 属主或 wakeup idle 属主
   (`tool-jobs/src/index.ts` Config,`completionDelivery` 默认 `wakeup`)——
   HPC 作业数小时后完成时 agent 会被唤醒看到终态与产物指针;控制器须先
   `attachController`(`jobs/src/index.ts:176`),tool-jobs 已挂,本插件不重复挂。
   registry 变更广播缝 `onJobsChanged`(`:167`)留给未来 UI。
4. **轮询驱动缝**:schedule 是 agent 作用域的 durable 提醒机制——一次性
   (`after_seconds`/`at`)与固定频率(`every_seconds`,下限
   `MIN_EVERY_INTERVAL_SECONDS = 300`,`packages/schedule/schedule/src/
   domain.ts:24`),记录落 session event log,过期补发最近一条。提交作业时
   建一条 `every_seconds=300` 的轮询提醒,提醒触发即轮询远端状态、更新
   `JobSnapshot.detail`、必要时拉增量日志;作业终态后删除。**300s 下限即
   本设计的轮询粒度上限保证**——状态查询本就走 stdout 大小受限的 squeue/
   sacct,不追求秒级;需要更密时由 run_code 内联一次性轮询垫付(见行为流)。
   会话内 while+sleep 自旋是反例:烧上下文且无持久性。
5. **事件流纪律**:自定义 session 事件类型对仓外插件封闭
   (`packages/core/session/src/known-event-types.ts:7-15`,05 已引用核实)
   ——本插件**不新增任何 session 事件**;作业事实走 jobs registry(天然),
   审计与告警走 telemetry ops(05 同纪律)。
6. **远程 exec 位形先例**:e2b 证明"替换 fs/subprocess 两个 OS 适配层即可
   换取整个远程执行世界"(`packages/e2b/README.md`,provider-composition
   POC);HPC 不复制此法——集群的入口面是**批命令 CLI**(sbatch/squeue/sacct/
   scancel)而非持久执行世界,所以我方远端面是一个薄 `ClusterTransport`
   抽象(ssh 包装默认实现 + 直连本机 mock 实现),不碰 ctx.fs/ctx.subprocess。
   主仓另有 code-runtime(`ctx.codeRuntime`,run_code 的宿主)与 sandbox 层,
   数据移动审批归彼处,本文档不展开。
7. **run_code 垫付轮询**:`run_code` 由 Code Mode 暴露,宿主是
   `ctx.codeRuntime` 服务(`packages/code-runtime/code-runtime/README.md`);
   供模型在等待窗口内写"循环查状态直到 X"的一次性程序,不替代 durable 轮询。

### 形态裁决:M0 spike(两形态都写清,裁决后再冻结)

- **形态A(首选)——jobs 生产者扩展**:声明合并加 `JobKindMap['hpc']`,`run()`
  里完成"渲染 sbatch 脚本 → 经 transport 提交 → 拿到 slurm job_id → 起
  schedule 轮询提醒",`JobHooks.cancel` 按原因路由(见行为流),
  `JobHooks.done` 在 sacct 终态 + 日志回收后 resolve,`readOutput` 返回
  最近拉取的日志尾部。收益:复用 tool-jobs 全套模型面与完成通知,复用
  job_id/状态机语义,05 handoff 只需在移交指针里写一个 job_id。
- **形态B(降级)——独立服务 + 自有工具面**:若 spike 证实缝不合身(判据下
  列),落 `ctx.hpcRunner` 服务 + `hpc_submit/hpc_status/hpc_logs/hpc_cancel/
  hpc_resume` 工具组合,自行管理提醒与通知。降级理由必须写进 spike 报告。
- **M0 判据(全部可在假集群上检验)**:(a) `JobKindMap` 声明合并在孵化仓
  typecheck 通过;(b) owner 处置语义——agent dispose 是否强制 cancel 在跑
  作业(若是,如何以 unowned 注册 + 手工 owner 校验绕开而不破坏授权模型);
  (c) done 的 "must not reject、reject 转 failed" 约定与远端轮询错误路径的
  相容性;(d) 跨进程重启用 unowned start 做 re-attach 是否合乎 registry
  授权语义。**任一否决项成立 → 形态B;全过 → 形态A**。

### 数据模型 / 配置

作业目录约定(计算项目根下,用户侧可见、可审计):

```text
.hpc/jobs/<slurm_job_id>/
  submit.json      # 冻结的提交请求:script 路径、渲染参数、资源声明、提交时刻
  script.sbatch    # 实际提交的渲染产物(内容寻址,重提即同脚本)
  checkpoint.json  # 计算级断点指针(见下)——领域任务与 agent 的共同读写面
  poll.jsonl       # 轮询流水:每次 {at, slurm_state,indexer_state, log_tail_hash}
  logs/            # 分段拉回的 stdout/stderr(tail 增量,命名 <seq>.log)
  artifacts/       # 终态后登记的产物清单(路径 + sha256),供 17 消费
```

**checkpoint.json — 计算级断点约定(三种字段,全部领域程序自检自写)**:

```json
{
  "checkpoint_rev": 7,
  "state_ptr": "checkpoints/gblup_rev7.npz",
  "resumed_from": 6,
  "written_at": "2026-08-20T10:20:00Z",
  "validator": "python tools/check_ckpt.py checkpoints/gblup_rev7.npz"
}
```

契约:`state_ptr` 必须指向**自治可重载**的状态文件;`resumed_from` 构成 rev
链,resume 后新 rev = resumed_from + 1;`validator` 是可选的离线校验命令,
hpc_resume 提交前若声明则先在本地/mock 跑通。未遵守该约定的领域任务仍可用
submit/poll,但 **checkpoint/resume 工具显式拒绝**(fail-closed:不能让 agent
以为能续跑一个根本没存状态的作业)。

配置(schemastery,与 [01 tool-manifest](./01-tool-manifest.zh.md) 的三档哲学
同构):

```ts
transport?: { kind: 'ssh'; host: string; user?: string; keyPath?: string }
          | { kind: 'mock'; stateDir: string }        // mock slurm stub 的状态目录
slurm?: {
  partition?: string; account?: string;               // 集群侧默认位形
  pollEverySeconds?: number                            // 默认 300(>= schedule 下限)
  maxLogTailBytes?: number                             // 默认 64KiB,溢出截断保留尾部
  sbatchTemplatePath?: string                          // 下文内建模板的覆盖位
}
checkpointPolicy?: 'strict' | 'off'                    // 默认 strict:无约定即禁 resume
manifest?: { submitEffect: 'side-effecting' }          // 01 注解的内建条目挂钩
```

sbatch 渲染模板(内建默认,可被 `sbatchTemplatePath` 覆盖;模板变量与
submit.json 一一对应):

```bash
#!/bin/bash
#SBATCH --job-name={{job_name}}
#SBATCH --cpus-per-task={{cpus}}
#SBATCH --mem={{mem}}
#SBATCH --time={{time}}
#SBATCH --partition={{partition}}
{{#if gpus}}#SBATCH --gres=gpu:{{gpus}}{{/if}}
set -euo pipefail
# checkpoint 续跑由作业体自行读 checkpoint.json 的 state_ptr
{{command}}
```

manifest 工具注解(随包发布,喂给 01):`hpc_submit` / `hpc_resume` =
`side-effecting`(写集群队列,超时后果含糊——提交可能已发生);
`hpc_status` / `hpc_logs` / `hpc_checkpoint_read` = `readonly`;
`hpc_cancel` = `side-effecting`(向集群发 scancel);幂等键:submit/resume 带
`submit.json` 内容哈希,重复提交同一渲染产物由集群侧幂等(sbatch 会重复排队,
**故 submit update 路径在提交前列表查重**,见行为流)。

### 关键行为流

**submit 流**(`hpc_submit` 工具;enforce 档下的完整路径):

1. 参数 = 作业名 + 命令/脚本骨架 + 资源声明 + (可选)checkpoint 复苏指针。
   渲染 sbatch → 写 `submit.json`/`script.sbatch` → 查重:同一 render hash 已有
   `running` 作业 → 直接返回既有 job 而非重复提交。
2. 经 transport 执行 `sbatch script.sbatch`,解析 slurm job_id,登记作业目录;
   用 `ctx.jobs.start` 注册(kind 声明合并为 `hpc`;owner 决策与 unowned 形态
   在 M0 spike 记录),返回模型面 `job_id`(registry id 与 slurm id 双双回显)。
3. 建 schedule 提醒 `every_seconds = pollEverySeconds`(默认 300),reminder
   载荷含 registry job_id + 作业目录路径。
4. **17 集成点:submit 成功即 `run_begin(hpc)`**(sibling doc 17-run-provenance,
   规划中;文件契约落地前用 telemetry ops 垫记同样字段,不阻塞)。

**poll 流**(schedule 提醒触发;全程 try/catch,提醒 handler 绝不 throw):

1. 读作业目录 → transport 跑 `squeue -j <id>`;未命中(已出队)再跑
   `sacct -j <id> --format=State,ExitCode` 取终态。
2. 状态迁移写入 `poll.jsonl`;`JobSnapshot.detail` 更新为
   `<slurm_state>@<partition> rev=<checkpoint_rev>`。
3. 增量拉日志:tutorial `tail -c <maxLogTailBytes>` 记入 `logs/`;远端不可达
   → 本轮记 warn 并在 detail 标 `poll-stale`(**不**转 failed,集群网络抖动
   是常态,连续 N 次失败才升级)。
4. 到达终态(COMPLETED/FAILED/CANCELLED/TIMEOUT):拉取最终日志 → 登记
   `artifacts/`(产物路径 + sha256)→ 删轮询提醒 → resolve `JobHooks.done`
   (`completed`/`failed`/`killed` 映射;超时按 `failed`,detail 注 TIMEOUT)
   → tool-jobs 的完成通知自动送达属主 agent。
   **17 集成点:终态自动 `run_log_artifact`(输出目录 hash + 产物清单指针)**。

**cancel 流**(`hpc_cancel`;也响应 registry `kill`):

- 用户显式 cancel → transport `scancel` → 状态轮询确认 CANCELLED 后按 `killed`
  收口;registry 层 `kill` 到达时若原因是会话处置而非用户意图,且作业被配置为
  "detach-on-owner-loss"(默认开,注释理由:HPC 作业按小时计价排队,会话死了
  不该杀作业),则 cancel hook **只停本地轮询与 agent 归属,不 scancel**,
  done 以 `killed`(detail: `detached`)本地收口;job_id + 作业目录仍可供新
  会话 re-attach。**这是与 jobs 默认 owner 语义的关键偏离,M0 spike 必须验证
  该偏离不破坏 registry 前置不变量**(pre-flights access and cleanup)。

**re-attach 流**(进程重启 / 新会话接管):

1. 新会话拿到 job_id(05 handoff 指针、用户转述、或 `.hpc/jobs/` 目录扫描)。
2. `hpc_attach(job_id)`:读作业目录 → transport 查 squeue/sacct 现态 →
   以 unowned kind 重新 `ctx.jobs.start`,`run()` 直接进入 poll 循环——
   Jobs 注册表是身份簿记,re-attach = 为既有远端作业领取新本地身份。

**checkpoint/resume 流**(M2 起):

- `hpc_checkpoint(job_id)`:transport 读远端 `checkpoint.json`(validator 在场
  先本地跑校验),回显 rev 链;不写不干预,**领域程序自持断点节奏**(量子传感
  式的分钟级 checkpoint 由作业脚本自己决定,不占 agent 上下文)。
- `hpc_resume(job_id | workdir)`:冻结新 submit(命令前插 `resume_from=<rev>`
  环境变量或脚手架参数),渲染新 sbatch 提交,`resumed_from` 链递增;旧 job
  的 registry 记录保留为终态血缘。**断点正确性归属领域程序**:agent 侧只保证
  "指针传递 + 渲染忠实 + 不重复扣费",DoD 里的断点演练用 fixture 作业验证
  端到端等价。

**与 05 handoff 的对齐**(M3):05 的 handoff 工件 `Evidence` 节追加
`hpc: { job_id, workdir, checkpoint_rev }` 一行即完成移交;新会话经
`agent/session-start`(05 seam 7)注入 handoff 后第一条动作即可
`hpc_attach`。05 不动,18 消费。

### 数据驻留边界

submit 只提交**作业描述**(脚本 + 资源声明 + 指针),数据始终留在集群侧文件
系统;数据上下行(若有)由用户/上层 approval 流程显式触发,不经由本插件的
默认路径。原因:XFEL 需求清单明写"不向第三方传输用户数据";数据位置与移动
策略的权威层是主仓 sandbox/approval,本插件不做第二个闸门,只在工具注解与
README 里把边界写死。

## 里程碑切分

- **M0 — provider 形态 spike(一个 PR)**:依"形态裁决"四条判据在假集群
  (transport mock)+ 真 jobs registry 上各写一个最小 spike;产出 =
  `docs/design/18-m0-spike-report.md`(判据逐条过/不过 + 裁决结论)。
  验证:{驱动方式: 以孵化仓 vitest 拉起真 `LocalJobRegistry` 与假 ctx,
  执行声明合并 + start/cancel/re-attach 四用例; 可观察结果: spike 报告 +
  测试退出码; 通过条件: 四条判据全部有结论且形态被唯一选定}。
- **M1 — slurm submit + 轮询(形态A 核准后;一个 PR)**:`ClusterTransport`
  (ssh + mock 两实现)、sbatch 渲染、hpc_submit/hpc_attach、schedule 轮询、
  mock slurm stub CLI(本地状态机:PENDING→RUNNING→COMPLETED/FAILED/TIMEOUT,
  响应 sbatch/squeue/sacct/scancel)。验证:{驱动方式: auto 测试全程打 mock
  transport,fixture 集群状态机脚本驱动; 可观察结果: job 注册快照序列、
  poll.jsonl 流水、终态 done 的 outcome; 通过条件: 提交→PENDING→RUNNING→
  COMPLETED 全链路快照与日志回收断言全绿,重复 submit 渲染幂等}。
- **M2 — checkpoint/resume 约定 + 工具(一个 PR)**:checkpoint.json schema +
  strict 档拦截;hpc_checkpoint/hpc_resume;validator 钩子。验证:{驱动方式:
  fixture 作业(写 rev 链的 sleep+计数脚本)在 mock 集群上 kill→resume;
  可观察结果: resumed_from 链、产物输出; 通过条件: resume 后终态产物与
  无中断基线逐字节一致;无 checkpoint 约定的作业 resume 被拒且报错含约定
  指引}。
- **M3 — 05/17 集成(一个 PR)**:handoff 的 hpc 指针节 + attach 续接;
  run_begin/run_log_artifact 接线(17 未落地时保持 telemetry 垫记)。
  验证:{驱动方式: 合成会话走 05 风格 fork + resume 注入,携 hpc 指针;
  可观察结果: 新会话首步 attach 成功、registry 新身份接管同一 slurm id;
  通过条件: 移交后 poll/cancel/终态通知全部可达,父会话侧无残留轮询}。

## 验证计划

1. **单元**:模板渲染矩阵(资源声明缺省/全满/覆写)、mock slurm 状态机的
   全部迁移与非法跳转、checkpoint.json 解析容忍(缺 rev/断链/validator 失败)。
2. **mock 集群全链路(联测级 auto)**:M1/M2 的端到端用例即主验收——见 DoD。
3. **断点演练(auto)**:M2 的 kill→resume→基线对比,含"validator 拒绝坏
   checkpoint 不提交"负例。
4. **真实集群首跑(manual)**:与育种 GBLUP 首跑合并执行(checklist 见 DoD,
   场景归属本系列 22 号育种领域包,规划中)——真实 ssh transport、真实队列
   等待、真实 sacct 终态、亲手 kill 一次看续跑。
5. **回归门禁**:typecheck/test/build CI 三连 + docs 检查(manifest 注解同步
   lint 若 01 的 lint 已存在则挂上)。

## 风险与开放问题

- **R1 owner 语义偏离**:`owner` 提供则 agent 处置即取消——detach-on-owner-loss
  需要以 unowned 注册 + 应用层会话鉴权替代,授权面从 registry 移到本插件;
  M0 spike 若证实 unowned 作业无法被"原会话优先"约束,形态A 判据(b)否决转
  形态B。**检查方法**:精读 `LocalJobRegistry` owner 校验与处置路径
  (`packages/jobs/jobs-local/src/index.ts`)后写结论。
- **R2 poll 粒度**:schedule 下限 300s,短作业(<5 min)的完成感知延迟可接受
  (完成通知依赖轮询),但交互式调参场景会显得"钝";开放:是否允许 run_code
  垫付一次性高频轮询作为模型面选项(默认不开,防止烧 token)。
- **R3 远端 preflight 的归属**:`hpc_submit` 需要确认集群侧环境(模块加载/
  分区/配额)——这是 [21 domain-pack](./21-domain-pack.zh.md) preflight 的
  remote 一档,分工为:21 定义 preflight 机制与本地档,18 的 submit 模板职责
  = 在 sbatch 渲染产物中内嵌远端自检段(版本/env/路径断言先行,fail-fast 于
  集群侧),本地 preflight "过" ≠ 集群 "过"。
- **R4 mock 与真实 slurm 的语义漂移**:squeue/sacct 的状态词、退出码、字段
  版本差异恒定存在;mock 只锁定我们*消费的*子集契约,真实首跑(manual)是
  矫正点。
- **R5 日志体**:HPC 作业日志可达 GB——默认尾拉 64KiB,全量回收归 artifacts
  sha 登记 + 用户自决;不向 agent 上下文灌日志正文(detail 仅状态行)。
- **R6 数据驻留的执行**:边界靠注解与文档表达,技术上 hpc_submit 的命令仍可
  内嵌 curl 上传;这与 09 token-wall / approval 层的联防有关,本期不复制
  闸门,接受"文档级边界"并在风险登记。

## 单元验收(Definition of Done)

勾选口径:[auto] = CI 可断言;[manual] = 人工执行并回填证据;[联测] = 与
他包同仓联动的端到端断言。

- [ ] [auto] mock 集群全链路:提交 → PENDING→RUNNING→COMPLETED 状态迁移
  序列 → 日志尾部回收 → done 收口;断言快照序列与 poll.jsonl 模式(schema
  校验)双向一致。
- [ ] [auto] 重复 submit 同一渲染产物 → 复用既有 job,不产生第二个 slurm id。
- [ ] [auto] 断点演练:fixture 作业(可写 rev 链)运行中 kill → resume →
  终态产物与无中断基线逐字节一致;`resumed_from` 链完整。
- [ ] [auto] 负例:无 checkpoint 约定的作业调 resume → fail-closed 拒绝,
  报错文本含约定格式指引;坏 checkpoint(validator 失败)不提交。
- [ ] [auto] cancel 两路:用户 cancel → scancel 到终态 killed;owner-loss
  (模拟会话处置)→ 本地收口 detail=`detached`,远端作业仍 running(M0 若
  裁决形态B,本项改写为独立服务的等价行为)。
- [ ] [auto] schedule 轮询接线:提交后恰好一条 every 提醒存在;终态后提醒被删;
  连续 N 次 transport 失败只升级告警不伪造终态。
- [ ] [auto] 遥测 ops 词汇:hpc/submit、hpc/poll、hpc/terminal、hpc/resume、
  hpc/attach 的 attributes 形状被 spy 断言。
- [ ] [联测] 05 handoff 携带 hpc 指针 → 新会话 attach → poll/终态通知链路
  在合成会话集成中断言(沿用 05 合成驱动风格)。
- [ ] [联测] 17 接线:submit 出现 run_begin(hpc)、终态出现 run_log_artifact
  (17 未落地时断言 telemetry 垫记字段同形;17 落地后切换到真接口,测试不变)。
- [ ] [auto] 01 manifest 内置条目清单:submit/resume/cancel=side-effecting、
  status/logs/checkpoint_read=readonly,lint 覆盖 100%。
- [ ] [manual] 真实集群首跑 checklist(与育种 GBLUP 首跑合并,见本系列
  22 号,规划中):① ssh transport 连通与 sbatch 真实提交;② squeue/sacct 真实
  状态词与 mock 词典 diff 归零或登记差异;③ 手工 kill 一次作业验证续跑路径;
  ④ 终态日志回收与 artifacts hash 复核;⑤ 数据驻留边界确认:全程无数据上
  下行默认动作。
- [ ] [manual] README 与 18-m0-spike-report.md 形态裁决结论一致;
  降级理由(若形态B)在文档与代码注释双层留痕。
