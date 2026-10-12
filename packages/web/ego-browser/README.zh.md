---
description: "面向 DSH agent 的浏览器自动化：自包含的 CDP-over-WebSocket 桥驱动本机 headless Chrome，完成快照、导航、点击、JS 求值、截图与等待，并提供覆盖 ego-browser harness v2 完整 helper 面的 browser_run 逃生舱。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-ego-browser

[English](README.md) | 中文

## 概述

有了 `dsh-ego-browser`，agent（智能体）无需闭源 ego lite 运行时，即可通过 `browser_snapshot`、`browser_goto`、`browser_click`、`browser_js`、`browser_screenshot`、`browser_wait` 与 `browser_run` 逃生舱直接驱动本机 Chrome（headless）完成网页自动化。Chrome 在首个真实浏览器调用时才懒启动，没跑浏览器工具的会话零进程开销。共享 base bundle 会为所有 profile 挂载本插件，profile 也可按需启用它。

## 目录

- [亮点](#highlights)
- [工具](#tools)
- [使用本包](#use-this-package)
- [配置](#configuration)
- [Chrome](#chrome)
- [与 DSH 现有 web 工具的定位差异](#positioning-against-the-existing-dsh-web-tools)
- [开发](#development)
- [移植说明](#porting-notes)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="highlights"></a>
## 亮点

- **自包含 CDP-over-WebSocket 桥**：复刻 ego-browser harness v2 期望的 `globalThis.ego` 接口——传输面（`sendCDPMessage`/`onCDPMessage`/`onSendCDPMessageError`/`listTabs`/`createTab`/`snapshot`）+ 任务空间面（`listTaskSpaces`/`createTaskSpace`/`useTaskSpace`/`claimTaskSpace`/`completeTaskSpace`/`closeTaskSpace`/`handOffTaskSpace`/`takeOverTaskSpace`/`animationHighlightMouseToPosition`/`setAgentTaskState`），以单一合成 agent-owned 空间承载本机 Chrome。没有闭源运行时；运行时依赖仅 `acorn`（v2 的 run/help 解析用），`WebSocket` 由 Node 22 自带。
- **懒启动**：插件加载（`apply`）只注册工具；首个真实浏览器调用才 spawn Chrome。没跑浏览器工具的会话零进程开销。
- **复用整套 harness**：CDP 会话管理（15s 超时、SESSION_LOST 自动重连、10k 事件缓冲、dialog 跟踪与 dialog 打开期间的快速失败、OOPIF 自动 attach、网络跟踪）、Page/TaskSpace 对象模型与 native-operation gate 串行化、元素解析（`@N` ref / `loc=css:` / `loc=role:` / `xpath=`）、ref 跨快照/动作/轮次保持身份（`documentId` 失效检测）、iframe 快照保留与 frame-aware 子树快照、下载拦截（Playwright 风格 `Download.*`）、页面台账（page ledger）、学习子系统（site skills）全部来自 ego-browser v2 源码，经移植保留。

<a id="tools"></a>
## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_snapshot` | `scope?`：`only_within_viewport` / `full_page` | 可访问性快照：文本大纲 + `@N` refs 图例，agent 据此交互 |
| `browser_goto` | `url`、`timeout?` | 导航当前标签并等待加载 |
| `browser_click` | `target`（`@N` / `loc=` / `xpath=` / CSS）、`timeout?` | 点击元素 |
| `browser_js` | `expression` | 页面内求值 JS 表达式，返回序列化结果 |
| `browser_screenshot` | `path?`、`fullPage?` | 截图 PNG，返回文件路径 |
| `browser_wait` | `selector` / `loadState`、`timeout?` | 等待元素（attached/visible）或加载态 |
| `browser_run` | `js` | 逃生舱：执行任意 helper JS，暴露完整 v2 helper face（扁平函数：`snapshot`/`gotoAndWait`/`click`/`js`/`cdp`/`waitForElement`…；任务空间：`taskSpace()`/`newTaskSpace()`/`claimTaskSpace()`…；site skills：`runSiteTool`/`learnContext`），`console.log` 被捕获返回 |

<a id="use-this-package"></a>
## 使用本包

官方 bundle 装配：`packages/bundle/base/cordis.patch.yml` 挂载 `ego-browser` 行（所有 profile 共享）。需重新构建 DSH host 侧产物并重启生效：

```bash
pnpm build:lib
```

如需按需启用（而非 base 全局），把 `packages/bundle/base/cordis.patch.yml` 里 `- id: ego-browser` 一行移除/禁用，改为在 profile 的 `cordis.patch.yml` 中：

```yaml
- insert:
    - id: ego-browser
      name: '@deepseek-ai/dsh-ego-browser'
      config: {}
```

<a id="configuration"></a>
## 配置

`schemastery` 配置对象：

```json
{ "enabled": true }
```

`enabled: false` 时插件不安装桥、不注册工具。

<a id="chrome"></a>
## Chrome

- 二进制查找顺序：`DSH_EGO_BROWSER_CHROME` 环境变量 → `google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser`（PATH + 常见目录）。
- 启动参数：`--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>` + 容器必需的 `--no-sandbox`；端口从 `DevToolsActivePort` 读取。
- 生命周期由插件持有：`ctx.effect` dispose（热重载/卸载）时回收进程并删除临时 profile。

<a id="positioning-against-the-existing-dsh-web-tools"></a>
## 与 DSH 现有 web 工具的定位差异

`web_search` / `web_fetch` 是模型面的搜索与抓取；`browser_*` 是**可交互**的浏览器自动化（快照带 refs、真实点击/输入/表单填充、页面内 JS、截图、文件上传）。需要「打开页面 → 观察 → 操作」时用本插件；只查资料用 `web_search`。

<a id="development"></a>
## 开发

```bash
# 类型检查（包级）
cd packages/web/ego-browser && tsc -p tsconfig.json --noEmit

# 构建（跟随仓库根构建）
pnpm build:lib

# 测试（工具注册 + 真实 Chrome 桥集成；无 Chrome 时桥测试自动跳过）
pnpm vitest run packages/web/ego-browser/tests/

# 端到端冒烟（真实 Chrome）
node packages/web/ego-browser/tests/smoke.mjs
```

<a id="porting-notes"></a>
## 移植说明

`src/runtime/` 是从 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) tag `v2.1.0-beta.2`（`package/ego-browser/src`）移植的 harness 源码，与上游保持 1:1 文件对应（仅不含上游的包入口 `index.ts`，由本包的 `src/index.ts` 取代）。import 后缀 `.js`→`.ts` 适配 DSH 的 `moduleResolution: bundler`，并以 `// @ts-nocheck` 豁免其原 `strict:false` 下的隐式 any（vendor 移植豁免；本包自写代码保持严格检查）。移植面包括 `page-model.ts`/`page-ledger.ts`/`page-discovery.ts`/`native-gate.ts`/`public-api-schema.ts`/`snapshot-result.ts`/`clipboard.ts`/`skill-migration.ts`/`driver/downloads.ts` 等。桥实现见 `src/bridge/`（`chrome.ts` 生命周期、`ws-cdp.ts` CDP 传输 + 任务空间 shim、`snapshot.ts` AX 快照）。

重移植时需重新施加的本地改动（上游未收录，均为 DSH 侧必需）：

- `driver/nav.ts`：`gotoAndWait` 在 `Page.navigate` 返回 `errorText` 或 `isDownload` 时抛错，避免把失败导航报成成功。
- `helpers.ts`：`taskSpace`/`useOrCreateTaskSpace`/`claimTaskSpace`/`takeOverTaskSpace` 补显式返回类型标注（声明合成无法命名匿名类的私有成员）。
- `page-ledger.ts`：动态删除改用 `Reflect.deleteProperty`（`typescript/no-dynamic-delete` 为 error 且不可自动修复）。
- `skill-migration.ts`：恢复指令保留 DSH 措辞——上游文本指向其自有 CLI `ego-browser skill`，本包不提供该命令。
- `learning/index.ts`：保留 `returns` 字段；示例文本随上游（`runSiteTool`/`runSiteBrowserTool` 才是本包实际暴露的扁平 helper）。
- `page-context-guard.ts`：字符类写作 `[a-z_$]`（该正则带 `/i`，与上游 `[A-Za-z_$]` 等价）。
- 移植面 lint 适配：`clipboard.ts` 的 catch 参数写作 `_error`；`element-resolver.ts` 中未使用的上游函数保留 `no-unused-vars` 豁免；`page-model.ts` 中闭包先读、随后赋值的 `timer` 保留 `prefer-const` 豁免。
- `driver/keyboard.ts`：`dispatchKey` 的 JSDoc 保留合成事件的后果说明，但去掉了指向上游自有 issue 文档的引用——本仓库没有该文档。
- `../index.ts`（本包入口）：把 `help()` 文本绑到 `browser_run` 的本次输出，并在 dispose 时回收下载产物。

<a id="model-experience"></a>
## 模型体验

### 浏览器工具定义

#### 模型看到什么

挂载本插件的会话中，每个请求都携带它注册的七个工具定义——`browser_snapshot`、`browser_goto`、`browser_click`、`browser_js`、`browser_screenshot`、`browser_wait` 与 `browser_run`——以及各自固定的英文描述与参数 schema。结果是纯文本：快照大纲及其 `@N` refs 图例、`navigated to <url>`、`clicked: <target>`、`browser_js` 的 JSON 序列化值、`screenshot saved: <path>`、`browser_wait` 的布尔值，以及 `browser_run` 捕获的 `console.log` 输出或 `(no output)`。本插件不贡献系统提示词文本。

#### Token 影响

插件挂载后，七个定义及其描述是每个请求的固定前缀开销。之后每次调用追加其文本结果；在大页面上，`browser_snapshot` 或 `browser_run` 可能追加一大块内容。

#### KV Cache 影响

定义在请求之间不变，因此保留已可复用的前缀；一次调用追加结果，绝不改写更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `src/runtime/` 整片以 `// @ts-nocheck` 豁免仓库 strict 剖面，CDP 载荷仍是上游的松散类型；`.oxlintrc.json` 因此把该移植面（且仅该移植面）从松散类型必然触发的类型感知规则中排除。`src/bridge/**`、`src/tools.ts`、`src/index.ts`、`tests/**` 仍走严格剖面。
- 上游的 `*.test.mjs` 未整体移植：本包现覆盖 ref 身份、iframe 归属、snapshot 消毒与 download 路径校验四类约定，上游其余用例（CDP 调用计数、快照压缩、墓碑上限、真实下载完成路径与端到端）仍只在 upstream 侧。
- `scripts/verify-concrete-terms.ts` 豁免 `src/runtime/**` 与断言该移植面 iframe 归属字段的两个用例：该禁用词在那里指上游字段名，而非来源标签；本包其余文件仍在门前。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

风格统一只跑 `@stylistic/*` 规则，不要对移植面跑全量 `oxlint --fix`：`typescript/no-useless-default-assignment` 等规则会改写 `js()` 这类为严格调用方保留的可选形参。

</details>
