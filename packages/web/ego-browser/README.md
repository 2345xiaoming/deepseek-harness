---
description: "Browser automation for DSH agents: a self-contained CDP-over-WebSocket bridge drives the local headless Chrome for snapshot, navigation, click, JS evaluation, screenshot, and wait, plus a browser_run escape hatch over the full ego-browser harness v2 helper face."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ego-browser

English | [中文](README.zh.md)

## Summary

With `dsh-ego-browser`, an agent drives the local Chrome (headless) through `browser_snapshot`, `browser_goto`, `browser_click`, `browser_js`, `browser_screenshot`, `browser_wait`, and the `browser_run` escape hatch, without the closed-source ego lite runtime. Chrome starts lazily on the first real browser call, so a session that never runs a browser tool pays no process cost. The shared base bundle mounts the plugin for every profile, and a profile can also enable it on demand.

## Table of Contents

- [Highlights](#highlights)
- [Tools](#tools)
- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Chrome](#chrome)
- [Positioning against the existing DSH web tools](#positioning-against-the-existing-dsh-web-tools)
- [Development](#development)
- [Porting notes](#porting-notes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="highlights"></a>
## Highlights

- **Self-contained CDP-over-WebSocket bridge**: it reproduces the `globalThis.ego` interface that ego-browser harness v2 expects — the transport face (`sendCDPMessage`/`onCDPMessage`/`onSendCDPMessageError`/`listTabs`/`createTab`/`snapshot`) and the task-space face (`listTaskSpaces`/`createTaskSpace`/`useTaskSpace`/`claimTaskSpace`/`completeTaskSpace`/`closeTaskSpace`/`handOffTaskSpace`/`takeOverTaskSpace`/`animationHighlightMouseToPosition`/`setAgentTaskState`), carrying the local Chrome in a single synthetic agent-owned space. There is no closed-source runtime; the only runtime dependency is `acorn` (used by the v2 run/help parsing), and Node 22 ships `WebSocket`.
- **Lazy start**: loading the plugin (`apply`) registers tools only; the first real browser call spawns Chrome. A session that never runs a browser tool pays no process cost.
- **The whole harness is reused**: CDP session management (15s timeout, automatic reconnect on SESSION_LOST, 10k event buffer, dialog tracking with fast failure while a dialog is open, automatic OOPIF attach, network tracking), the Page/TaskSpace object model with native-operation gate serialization, element resolution (`@N` ref / `loc=css:` / `loc=role:` / `xpath=`), refs that keep their identity across snapshots, actions, and turns (`documentId` invalidation detection), iframe snapshot preservation with frame-aware subtree snapshots, download interception (Playwright-style `Download.*`), the page ledger, and the learning subsystem (site skills) all come from the ego-browser v2 source, preserved through the port.

<a id="tools"></a>
## Tools

| Tool | Parameters | Purpose |
|---|---|---|
| `browser_snapshot` | `scope?`: `only_within_viewport` / `full_page` | Accessibility snapshot: a text outline plus the `@N` refs legend the agent interacts through |
| `browser_goto` | `url`, `timeout?` | Navigate the current tab and wait for it to load |
| `browser_click` | `target` (`@N` / `loc=` / `xpath=` / CSS), `timeout?` | Click an element |
| `browser_js` | `expression` | Evaluate a JS expression in the page and return the serialized result |
| `browser_screenshot` | `path?`, `fullPage?` | Capture a PNG screenshot and return the file path |
| `browser_wait` | `selector` / `loadState`, `timeout?` | Wait for an element (attached/visible) or a load state |
| `browser_run` | `js` | Escape hatch: run arbitrary helper JS with the full v2 helper face (flat helpers: `snapshot`/`gotoAndWait`/`click`/`js`/`cdp`/`waitForElement`…; task space: `taskSpace()`/`newTaskSpace()`/`claimTaskSpace()`…; site skills: `runSiteTool`/`learnContext`); `console.log` is captured and returned |

<a id="use-this-package"></a>
## Use this package

The official bundle mounts it: `packages/bundle/base/cordis.patch.yml` carries the `ego-browser` row shared by every profile. The DSH host artifacts must be rebuilt and the process restarted for the change to take effect:

```bash
pnpm build:lib
```

To enable it on demand instead of globally through base, remove or disable the `- id: ego-browser` row in `packages/bundle/base/cordis.patch.yml` and add this to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: ego-browser
      name: '@deepseek-ai/dsh-ego-browser'
      config: {}
```

<a id="configuration"></a>
## Configuration

The `schemastery` config object:

```json
{ "enabled": true }
```

With `enabled: false` the plugin installs no bridge and registers no tool.

<a id="chrome"></a>
## Chrome

- Binary lookup order: the `DSH_EGO_BROWSER_CHROME` environment variable → `google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser` (PATH plus common directories).
- Launch arguments: `--headless=new --remote-debugging-port=0 --user-data-dir=<tmp>`, plus `--no-sandbox`, which containers require; the port is read from `DevToolsActivePort`.
- The plugin owns the lifecycle: `ctx.effect` dispose (hot reload or unload) reclaims the process and deletes the temporary profile.

<a id="positioning-against-the-existing-dsh-web-tools"></a>
## Positioning against the existing DSH web tools

`web_search` / `web_fetch` search and fetch for the model; `browser_*` is **interactive** browser automation (snapshots carrying refs, real clicking/typing/form filling, in-page JS, screenshots, file upload). Use this plugin when the task is "open a page → observe → act"; use `web_search` to look information up.

<a id="development"></a>
## Development

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
## Porting notes

`src/runtime/` is harness source ported from [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) tag `v2.1.0-beta.2` (`package/ego-browser/src`), keeping a 1:1 file correspondence with upstream (it omits only upstream's package entry `index.ts`, which this package's `src/index.ts` replaces). Import suffixes changed from `.js` to `.ts` for DSH's `moduleResolution: bundler`, and `// @ts-nocheck` exempts the implicit any of upstream's `strict:false` (a vendor-port exemption; this package's own code keeps strict checking). The ported surface includes `page-model.ts`/`page-ledger.ts`/`page-discovery.ts`/`native-gate.ts`/`public-api-schema.ts`/`snapshot-result.ts`/`clipboard.ts`/`skill-migration.ts`/`driver/downloads.ts` and others. The bridge lives in `src/bridge/` (`chrome.ts` lifecycle, `ws-cdp.ts` CDP transport plus the task-space shim, `snapshot.ts` AX snapshot).

Local changes to re-apply on a re-port (not accepted upstream; all required on the DSH side):

- `driver/nav.ts`: `gotoAndWait` throws when `Page.navigate` returns `errorText` or `isDownload`, so a failed navigation is not reported as a success.
- `helpers.ts`: `taskSpace`/`useOrCreateTaskSpace`/`claimTaskSpace`/`takeOverTaskSpace` carry explicit return type annotations (declaration synthesis cannot name the anonymous class's private members).
- `page-ledger.ts`: dynamic deletion goes through `Reflect.deleteProperty` (`typescript/no-dynamic-delete` is an error with no autofix).
- `skill-migration.ts`: the restore instruction keeps DSH wording — the upstream text points at upstream's own CLI `ego-browser skill`, which this package does not provide.
- `learning/index.ts`: the `returns` field is retained; the example text follows upstream (`runSiteTool`/`runSiteBrowserTool` are the flat helpers this package actually exposes).
- `page-context-guard.ts`: the character class is written `[a-z_$]` (the regex carries `/i`, equivalent to upstream's `[A-Za-z_$]`).
- Ported-surface lint adaptations: the `clipboard.ts` catch parameter is written `_error`; unused upstream functions in `element-resolver.ts` keep a `no-unused-vars` exemption; the `timer` in `page-model.ts` that a closure reads before it is assigned keeps a `prefer-const` exemption.
- `driver/keyboard.ts`: the `dispatchKey` JSDoc keeps the synthetic-event consequence but drops upstream's reference to its own issue document, which this repository does not carry.
- `../index.ts` (this package's entry): binds `help()` text to that `browser_run` output and reclaims download artifacts on dispose.

<a id="model-experience"></a>
## Model Experience

### Browser tool definitions

#### What the model sees

Every request in a session that mounts the plugin carries the seven tool definitions it registers — `browser_snapshot`, `browser_goto`, `browser_click`, `browser_js`, `browser_screenshot`, `browser_wait`, and `browser_run` — with their fixed English descriptions and parameter schemas. Results are plain text: the snapshot outline with its `@N` refs legend, `navigated to <url>`, `clicked: <target>`, the JSON-serialized `browser_js` value, `screenshot saved: <path>`, the `browser_wait` boolean, and `browser_run`'s captured `console.log` output or `(no output)`. The plugin contributes no system-prompt text.

#### Token effect

The seven definitions and their descriptions are a fixed prefix cost on every request once the plugin is mounted. Each call then appends its text result, and `browser_snapshot` or `browser_run` can add a large block on a big page.

#### KV Cache effect

The definitions do not change between requests, so they preserve an already-reusable prefix; a call appends its result and never replaces earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The whole of `src/runtime/` is exempt from the repository's strict profile by `// @ts-nocheck`, and the CDP payloads keep upstream's loose types; `.oxlintrc.json` therefore excludes that ported surface (and only that surface) from the type-aware rules that loose types necessarily trip. `src/bridge/**`, `src/tools.ts`, `src/index.ts`, and `tests/**` stay under the strict profile.
- Upstream's `*.test.mjs` cases were not ported wholesale: this package covers four contracts — ref identity, iframe ownership, snapshot sanitization, and download path validation — while the remaining upstream cases (CDP call counts, snapshot compression, tombstone limits, the real download completion path, and end to end) still live upstream only.
- `scripts/verify-concrete-terms.ts` exempts `src/runtime/**` and the two specs that assert that plane's iframe attribution field, because the blocked term names an upstream field there rather than an origin label; every other file in this package stays scanned.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run only the `@stylistic/*` rules for style normalization; do not run the full `oxlint --fix` over the ported surface, because rules such as `typescript/no-useless-default-assignment` rewrite optional parameters like the one on `js()` that are kept for strict callers.

</details>
