# dsh-open-code-review

把 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（OCR，Apache-2.0）的混合代码评审能力做成 DeepSeek Harness 插件：**确定性工程（选文件 / 配规则 / 打包 / 定位校验）+ LLM 评审 worker（每 bundle 一个隔离子 agent）+ 事实核查过滤**，产出行级 findings。

已通过 `dsh-super-injector` 运行时注入验证（host + client 全量生效）。

## OCR 功能 → DSH 扩展点映射

| OCR 组件 | 本插件实现 | DSH 机制 |
|---|---|---|
| `ocr delegate preview`（确定性选文件） | `src/spec.ts` `planDiffSpec` → `src/git.ts` `selectTargets`（谓词排除，transport 不含策略） | `ctx.tools` 工具（`ocr_preview`） |
| 规则解析（`.opencodereview/rule.json` → 系统规则库） | `src/rules.ts` 分层 + `src/spec.ts` 装配门（含顶层 `include`/`exclude` 优先级契约的唯一家） | 工具（`ocr_rules` → `assembleRules`）+ 装配内部消费 |
| 内置多语言规则集（54 份 rule docs + glob 映射） | `src/assets/rule-docs.ts`（全部移植，Apache-2.0） | 静态资产 |
| Smart file bundling（关联文件成组） | `src/bundle.ts`：资源/i18n 变体、同名伴随文件、同目录关注点聚类，每组 ≤10 文件 | 纯函数 |
| Review plan（预规划） | `src/worker.ts` plan task（移植上游 plan_task）：每 bundle 先产出 `summary` + 按严重级排序的风险点 + 上下文检查意图，注入 review prompt 的 `### Review Plan` 槽；规划失败 fail-open（评审照跑） | Review Worker seam |
| Review agent（工具调用式深度评审） | `src/worker.ts` review worker seam：`createWorker` 构造，subagent adapter（`ctx.subagents.startActivation`，`delivery:'caller'`，只读 `toolFilter` + `maxDepth: 0`）与 llm adapter 两个实现；能力不足 fail loud，不静默降级 | `ctx.subagents`（spawn）+ `ctx.llm` |
| Comment re-location（定位模块） | `src/relocate.ts` 确定性半环：snippet 连续新增行逐字匹配（重复片段取声称行号最近者）+ 改动 hunk 校验；未锚定者走 **LLM re-location 回退**（`src/worker.ts` 的 relocate task，批量一次调用，返回的 snippet 重进确定性匹配）；失败 fail-open | 纯函数 + Review Worker seam |
| Review filter（反思模块） | `src/worker.ts` 契约之家（`FILTER_SYSTEM_PROMPT` 移植含 protected-subject 否决权 + verdict 解析器）；失败 fail-open，绝不销毁 finding（[ADR-0001](docs/adr/0001-fail-open-filter.md)） | LLM worker |
| Review Rules（项目自定义规则） | `.opencodereview/rule.json` 自动加载：默认替换系统规则（与上游一致）；`merge_system_rule: true` 时按上游模板合并（system 在前、user 在后） | 配置面 |
| `ocr scan`（无 diff 全文件审计） | `src/spec.ts` `assembleScanRun`：跟踪文件合成 diff、安全上限 fail loud | 工具（`ocr_scan`） |
| Agent Skill（调用规约 + 分诊 rubric） | `ctx.systemPrompt.section`（`open-code-review:guidance`） | system-prompt 扩展点 |
| Session Viewer（结果浏览） | `GET /@dsh-external/dsh-open-code-review/api/last-run` + `conversation.view` findings 视图（按严重级分组渲染） | `ctx.webServer` + client slots |
| 评论结构（path/line/severity/category） | `Finding` 规范值（critical/high/medium/low × bug/security/…/other） | 工具 canonical JSON |

评审 worker 是**只读受限**子 agent（`toolFilter: read/read_image/grep/glob` + `maxDepth: 0`，防止评审过程改动仓库或递归委派；限制永不降级，[ADR-0002](docs/adr/0002-worker-restrictions-never-degrade.md)），输出 token 走 `maxTokens` 配置。
未移植（超出插件范围）：CLI/TUI 本体、IDE 扩展、CI 集成、Session 持久化回放、MCP server、memory-compression 子任务（v1 简化）。

## 工具面

| 工具 | 作用 | 是否调模型 |
|---|---|---|
| `ocr_preview` | 选文件 + 规则组成员 + 打包计划 | 否（纯确定性） |
| `ocr_rules` | 按路径解析评审 checklist（项目规则 merge 系统规则） | 否 |
| `ocr_review` | 全混合评审：每 bundle 隔离 worker → 定位校验 → 反思过滤 → 汇总 findings + 覆盖率 | 是 |
| `ocr_scan` | 无 diff 全文件审计（同一管线） | 是 |

`ocr_review` 参数：`repo`（默认会话工作目录）、`from`/`to`（分支区间，自动算 merge-base）、`commit`（merge commit 取第一父基线）、`exclude`（追加排除 glob）、`background`（业务背景）、`worker`（通道覆盖）、`concurrency`（本次并发 1–8，大 changesets 用它挤进调用超时预算）。
`ocr_scan` 参数：`repo`、`paths`（默认全部跟踪文件，超出文件数上限时报错）、`background`、`worker`。

输出为 canonical JSON（findings/coverage/bundles/stats），render 面向模型按严重级分组；`positionVerified` 为假的 finding 会标注 `[position unverified]`。

## 配置（cordis.yml 的 plugin config）

```yaml
- name: '@dsh-external/dsh-open-code-review'
  config:
    worker: auto          # auto|subagent|llm；auto 优先隔离子 agent
    subagentProvider: spawn
    maxTokens: 4096       # 单 worker 调用上限
    concurrency: 2        # bundle 并发（工具调用时可用 concurrency 参数按次覆盖）
    plan: true            # 每 bundle 先跑 plan task（预规划，注入 review 提示词；失败 fail-open）
    relocation: llm       # 定位策略：llm（确定性 + LLM 回退）| deterministic（仅确定性）
    exclude: []           # 排除 glob（注意：配置后替换内置默认的 12 条，如 lockfile/dist/node_modules）
    ruleFile: .opencodereview/rule.json
    systemRules: true     # 内置 54 语言规则集是否参与
    llmProvider: ''       # llm 通道路由（与 llmModel 成对；留空/省略即回退会话观测路由）
    llmModel: ''
    guidance: true        # 是否注入模型侧 ocr_* 使用指引
    toolTimeoutMs: 1800000 # 单次工具调用协作式超时预算（毫秒）
    apiRoute: true        # 是否注册 findings API（受 connection 信任栅栏保护：无凭证 401、跨站 403，与官方 API 一致）
```

## 构建与注入

```bash
DSH_CHECKOUT=/root/deepseek-harness bash scripts/build.sh   # host（tsc）
/root/deepseek-harness/node_modules/.bin/tsdown             # client（tsdown）
# 注入器环境内：dev_inject_plugin /root/deepseek-harness/.plugins/dsh-open-code-review
```

## 架构（一次 `ocr_review`）

```text
ocr_review(from,to|commit|workspace)
  └─ assembleDiffRun()              # 纯确定性：ReviewRun = spec + diffs
       ├─ selectTargets()           # git 选文件 + 排除 + 二进制过滤
       ├─ groupRules()              # project→system→default 分层 + 同文分组
       └─ bundleTargets()           # 关联文件成组（≤10/组）
  └─ runReview()
       ├─ diffs 由装配门备齐        # plain diff；git 无差分的文件合成全加 diff
       ├─ 每 bundle 并发 ≤ concurrency：
       │    ├─ worker.run(PLAN_SYSTEM_PROMPT + diffs + checklist)     # 预规划（fail-open）
       │    ├─ worker.run(REVIEW_SYSTEM_PROMPT + diffs + checklist + plan 引导)   # ReviewWorker seam
       │    │     └─ subagent adapter: ctx.subagents.startActivation（隔离上下文+只读工具）
       │    │        llm adapter:      ctx.llm.stream（打包上下文直调）
       │    ├─ positionComments()   # snippet 逐字重定位 / 改动行校验
       │    ├─ relocateBundle()     # 未锚定者：LLM 回退（批量一次）→ 重进确定性匹配
       │    └─ filterBundle()       # review_filter 反思（protected-subject 否决；失败保留全部）
       └─ 汇总 findings + coverage（逐文件 reviewed/skipped 记账）
```

模块分工：`spec.ts`（装配与策略）→ `git.ts`（纯 transport）；`worker.ts`（Review Worker seam + 输出契约之家）；`pipeline.ts`（纯编排，不碰模型与 git）；领域词汇见 `CONTEXT.md`，行为不变量见 `docs/adr/`。

## 第三方资产（Third-party assets）

`src/assets/rule-docs.ts`（54 份语言规则文档 + glob 映射）与 `src/worker.ts`（main task / review filter 的 role、focus rules、protected subjects 等段落）移植自 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Apache License 2.0，Copyright 2026 Alibaba），按其许可保留出处声明；针对 DSH worker 的输出协议（工具调用 → 结构化 JSON）做了适配。调用规约与分诊 rubric 移植自其 `skills/open-code-review*/SKILL.md`。

## 已知简化（v1）

- bundle 内评审无 plan-task 预规划（OCR 的 plan_task）；子 agent 自行决定探索策略。
- 定位校验先走确定性半环（snippet 连续匹配 / 行号落在改动 hunk 内），未锚定的评论走 LLM 回退重试一次；仍失败则以 `positionVerified: false` 呈现。
- 过滤步失败时保留全部评论（fail-open，理由见 [ADR-0001](docs/adr/0001-fail-open-filter.md)）。
- `llm` 通道的路由来自会话捕获（`llm/stream` 观察）或 `llmProvider`/`llmModel` 配置（`''`/省略视为未配置）。
- 领域词汇（Review Worker / Worker Task / Structured Document / Review Spec / Coverage 等）见 `CONTEXT.md`。
- findings API 只记录最近一次 `ocr_review`/`ocr_scan`（`ocr_preview`/`ocr_rules` 不进面板）。
- 运行统计（`worker`/`bundles`/`planRuns`/`planFailures`/`filterRuns`/`relocated`/耗时）以一行文本输出给模型，canonical 值同时携带完整 `stats`。
- 预规划与定位回退都是 **fail-open 但可见**：plan 失败时 `stats.planFailures` 计数 + `bundles[].planError` 记录原因，render 输出 `Plan failures (N)` 区段；定位回退失败则位置保持未核实。
- `maxTokens`（默认 8192）是**单次 worker 请求**的输出上限：被截断的 worker 不会产出结构化文档，其整个 bundle 记为 skipped（coverage 如实记账，不静默）。
- glob 匹配大小写不敏感（与上游 `ToLower`+doublestar 一致）并支持 `[abc]` 字符类；`rule.json` 条目做字段校验，顶层 `include`/`exclude` 过滤已实现（`include` 绕过排除列表、`exclude` 最高优先级）。
- `ocr_scan` 有安全上限：超过 200 个文件或 2MiB 单文件时报错/排除，二进制文件不读取（护栏不做配置项，理由见 [ADR-0003](docs/adr/0003-scan-caps-as-invariants.md)）。
- `toolTimeoutMs`（默认 30 分钟）是评审预算：大工作区先 `ocr_preview` 量级、用 `exclude` 缩窄，或走 `ocr_scan(paths=...)` 分批。已发布 worker 随取消一并 dispose（不留后台燃烧）。
