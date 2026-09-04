# @dsh-external/dsh-mcp-settings

设置页 MCP section：增删改开关 MCP 服务器，免重启即时挂载。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # host 编译 + client typecheck
npm run build:client                              # client bundle（lib/client.js）
# 注入器环境内：dev_inject_plugin <本目录> 或 dev_install_package <本目录>（持久化）
```

## 行为

- 真相源：settings namespace `mcp-servers`（落盘 harness home 的 settings 文档）。手工写在 patch 里的 mcp-client 行出现在页面的"配置文件中的 MCP 服务"区（只读展示 + 可开关）。
- 每个启用条目由 manager 以进程内插件挂载一个 `dsh-mcp-client`（root 作用域 → 工具进全局工具层，活动会话即时可见）；停用/删除即 dispose；配置变更 = 换代。
- stdio（command/args/env/cwd）与 streamable-http（url/headers）两种 transport。
- env/headers 值标 secret role：wire 读取逐键脱敏 + `{path,set}` sidecar；编辑表单密钥留空 = 保持已存值；值支持 `${VAR}` 引用宿主环境，缺失变量 = 该行错误。
- 状态徽标：🟢 已连接（工具数）/ 🔴 错误（含"初始连接失败仍重试"）/ ⚪ 已停用 / 🟡 连接中。
- patch 配置行（loader 中的 `@deepseek-ai/dsh-mcp-client` 条目）投影进同一页面：只读配置展示 + 开关；开关 = 运行时 `entry.update({disabled})` + 向声明该行的 profile `cordis.patch.yml` 追加 id-targeted `disabled` 行（watchUserPatches 重放，重启仍保持）。
- 可配置项（`cordis.yml` config）：`statusErrorAfterMs`（默认 10000ms）——启用后超过该时长仍无工具时标记为初始连接失败（重连预算继续，工具出现自动转 🟢）。

## 已知偏差（相对 spec 决策）

- 状态投影走 **webserver 路由**（`/@dsh-external/dsh-mcp-settings/status`，client 轮询 3s）而非 Typert Remote：外部插件无法加入主仓 `packages/api/remotes` 的装配，webserver 路由是注入器生态的 host API 惯例；client 与宿主同源假设成立（同一 Web 应用）。
- 密钥"已配置"占位：client scope 快照不暴露 `secrets` sidecar，表单以"留空保持已存值 + 提示"表达同一语义。
- 演示 GIF：录制时截图工具与交互上下文不一致，成品帧序无法验证；静态帧保留在 `.playwright-mcp/gif-frames-mcp-demo/`（gitignored），未发布动画成片。
- namespace 命名 `mcp-servers` 而非 spec 的 `mcp.servers`：settings provider 的 namespace 规则 `/^[a-z][a-z0-9-]*$/` 拒绝点号。

## 测试

```bash
vitest run --config vitest.config.ts   # 14 条：挂载/开关/换代/删除/http/密钥/脱敏/VAR/状态路由/校验
```
