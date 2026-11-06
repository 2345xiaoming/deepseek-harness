# @dsh-external/dsh-mcp-settings

设置页 MCP section：增删改开关 MCP 服务器，免重启即时挂载。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # host 编译 + client typecheck
npm run build:client                              # client bundle（lib/client.js）
# 注入器环境内：dev_inject_plugin <本目录> 或 dev_install_package <本目录>（持久化）
```

## 行为

- 真相源：插件自身 loader 条目 `dsh-mcp-settings` 的 volatile `config.servers`。settings 页的写入走
  `configForms → configEditor`（改写所在 profile 的 `cordis.patch.yml`）→ loader volatile 提交 →
  `loader/volatile-update`；manager 就地重挂受影响条目，进程不重启。
  手工写在 patch 里的 mcp-client 行出现在页面的"配置文件中的 MCP 服务"区（只读展示 + 可开关）。
- 每个启用条目由 manager 以进程内插件挂载一个 `dsh-mcp-client`（root 作用域 → 工具进全局工具层，活动会话即时可见）；停用/删除即 dispose；配置变更 = 换代。
- stdio（command/args/env/cwd）与 streamable-http（url/headers）两种 transport。
- env/headers 值标 secret role：settings describe 逐键脱敏 + `{path,set}` sidecar；编辑表单密钥留空 = 保持已存值；值支持 `${VAR}` 引用宿主环境，缺失变量 = 该行错误。
- 状态徽标：🟢 已连接（工具数）/ 🔴 错误（含"初始连接失败仍重试"）/ ⚪ 已停用 / 🟡 连接中。
- patch 配置行（loader 中的 `@deepseek-ai/dsh-mcp-client` 条目）投影进同一页面：只读配置展示 + 开关；开关 = 运行时 `entry.update({disabled})` + 向声明该行的 profile `cordis.patch.yml` 追加 id-targeted `disabled` 行（watchUserPatches 重放，重启仍保持）。
- 可配置项（同一 `config`）：`statusErrorAfterMs`（默认 10000ms）——启用后超过该时长仍无工具时标记为初始连接失败（重连预算继续，工具出现自动转 🟢）。
- 校验：`internal/config` waterfall 拒绝 schema 表达不了的 section（serverName 字符集、transport 字段配对、URL 绝对性），写入在落盘前被拒。

## 已知偏差（相对 spec 决策）

- 状态投影走 **webserver 路由**（`/@dsh-external/dsh-mcp-settings/status`，client 轮询 3s）而非 Typert Remote：外部插件无法加入主仓 `packages/api/remotes` 的装配，webserver 路由是注入器生态的 host API 惯例；client 与宿主同源假设成立（同一 Web 应用）。
- 密钥"已配置"占位：client 表单快照不暴露 `secrets` sidecar，表单以"留空保持已存值 + 提示"表达同一语义。
- 演示 GIF：录制时截图工具与交互上下文不一致，成品帧序无法验证；静态帧保留在 `.playwright-mcp/gif-frames-mcp-demo/`（gitignored），未发布动画成片。
- settings 命名空间即插件条目 id `dsh-mcp-settings`（新设置模型下命名空间由 loader 条目 id 决定，不再有独立的命名空间注册）。

## 测试

```bash
vitest run --config vitest.config.ts   # 17 条：挂载/开关/换代/删除/http/密钥/脱敏/VAR/状态路由/校验/loader 行投影
```

`tests/helpers.ts` 提供两种引导：`boot()` 把 manager 作为 builtin 条目挂在真实 Loader 下（配置更新走
volatile 提交）；`bootWithEntries()` 直接挂载 manager 并配可伪造的 loader 服务，用于 patch 配置行投影测试。
