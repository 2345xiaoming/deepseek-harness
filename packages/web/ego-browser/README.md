# @deepseek-ai/dsh-ego-browser

浏览器自动化 toolkit：DSH agent 无需闭源 ego lite 运行时，即可直接驱动本机 Chrome（headless）完成网页自动化——快照、导航、点击、JS 求值、截图、等待，外加一个 `browser_run` 逃生舱暴露 ego-browser harness v2 的完整 helper 面。

## 亮点

- **自包含 CDP-over-WebSocket 桥**：复刻 ego-browser harness v2 期望的 `globalThis.ego` 接口——传输面（`sendCDPMessage`/`onCDPMessage`/`onSendCDPMessageError`/`listTabs`/`createTab`/`snapshot`）+ 任务空间面（`listTaskSpaces`/`createTaskSpace`/`useTaskSpace`/`claimTaskSpace`/`completeTaskSpace`/`closeTaskSpace`/`handOffTaskSpace`/`takeOverTaskSpace`/`animationHighlightMouseToPosition`/`setAgentTaskState`，以单一合成 agent-owned 空间承载本机 Chrome）。没有闭源运行时；运行时依赖仅 `acorn`（v2 的 run/help 解析用），`WebSocket` 由 Node 22 自带。
- **懒启动**：插件加载（`apply`）只注册工具；首个真实浏览器调用才 spawn Chrome。没跑浏览器工具的会话零进程开销。
- **复用整套 harness**：CDP 会话管理（15s 超时、SESSION_LOST 自动重连、10k 事件缓冲、dialog 跟踪、OOPIF 自动 attach、网络跟踪）、Page/TaskSpace 对象模型与 native-operation gate 串行化、元素解析（`@N` ref / `loc=css:` / `loc=role:` / `xpath=`）、ref 刷新与稳定 locator、页面台账（page ledger）、学习子系统（site skills）全部来自 ego-browser v2 源码，经移植保留。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_snapshot` | `scope?` `only_within_viewport` / `full_page` | 可访问性快照：文本大纲 + `@N` refs 图例，agent 据此交互 |
| `browser_goto` | `url`, `timeout?` | 导航当前标签并等待加载 |
| `browser_click` | `target`（`@N` / `loc=` / `xpath=` / CSS）, `timeout?` | 点击元素 |
| `browser_js` | `expression` | 页面内求值 JS 表达式，返回序列化结果 |
| `browser_screenshot` | `path?`, `fullPage?` | 截图 PNG，返回文件路径 |
| `browser_wait` | `selector` / `loadState`, `timeout?` | 等待元素（attached/visible）或加载态 |
| `browser_run` | `js` | 逃生舱：执行任意 helper JS，暴露完整 v2 helper face（扁平函数：`snapshot`/`gotoAndWait`/`click`/`js`/`cdp`/`waitForElement`…；任务空间：`taskSpace()`/`newTaskSpace()`/`claimTaskSpace()`…；site skills：`runSiteTool`/`learnContext`），`console.log` 被捕获返回 |

## 装配

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

## 配置

`schemastery` 配置对象：

```json
{ "enabled": true }
```

`enabled: false` 时插件不安装桥、不注册工具。

## Chrome

- 二进制查找顺序：`DSH_EGO_BROWSER_CHROME` 环境变量 → `google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser`（PATH + 常见目录）。
- 启动参数：`--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>` + 容器必需的 `--no-sandbox`；端口从 `DevToolsActivePort` 读取。
- 生命周期由插件持有：`ctx.effect` dispose（热重载/卸载）时回收进程并删除临时 profile。

## 与 DSH 现有 web 工具的定位差异

`web_search` / `web_fetch` 是模型面的搜索与抓取；`browser_*` 是**可交互**的浏览器自动化（快照带 refs、真实点击/输入/表单填充、页面内 JS、截图、文件上传）。需要"打开页面 → 观察 → 操作"时用本插件；只查资料用 `web_search`。

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

## 移植说明

`src/runtime/` 是从 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) tag `v2.0.0-beta.4`（`package/ego-browser/src`）移植的 harness 源码：import 后缀 `.js`→`.ts` 适配 DSH 的 `moduleResolution: bundler`，并以 `// @ts-nocheck` 豁免其原 `strict:false` 下的隐式 any（vendor 移植豁免；本包自写代码保持严格检查）。v2 移植删除了旧线独有的 `video-recorder.ts`/`driver/screencast.ts`/`driver/locator.ts`/`driver/downloads.ts`/`locator-query.ts`（其职责并入 `element-resolver.ts`/`page-model.ts` 新架构），新增 `page-model.ts`/`page-ledger.ts`/`page-discovery.ts`/`native-gate.ts`/`public-api-schema.ts`/`snapshot-result.ts`/`clipboard.ts`/`skill-migration.ts` 等。移植版 `helpers.ts` 的 task-space 入口函数需显式返回类型标注（声明合成对匿名类私有成员不可命名）。桥实现见 `src/bridge/`（`chrome.ts` 生命周期、`ws-cdp.ts` CDP 传输 + 任务空间 shim、`snapshot.ts` AX 快照）。