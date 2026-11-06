# Spec: MCP 设置页（dsh-mcp-settings）

Status: ready-for-agent

## Problem Statement

用户想在 DSH 里使用 MCP 服务器时，唯一路径是手工编辑 profile 的 cordis.patch.yml：往插件行里塞 `dsh-mcp-client` 实例、手写 transport 配置、改一行 `disabled` 来开关。没有页面能看到"我配了哪些 MCP 服务"，没有开关，连接失败也没有反馈——非 YAML 用户被完全挡在 MCP 能力之外，熟练用户也要靠重启/改文件管理自己的服务列表。

## Solution

Web GUI 设置页新增顶级 **MCP** section。页面列出由该页管理的 MCP 服务器，每行显示名称、transport 摘要与连接状态徽标（🟢 已连+工具数 / 🔴 最后错误 / ⚪ 已停用），带开关；页面提供添加、编辑、删除表单，支持 stdio 与 streamable-http 两种 transport。所有增删改与开关免重启即时生效：运行中的会话里对应 `mcp__<server>__*` 工具立刻出现或消失。配置持久在一个 settings namespace 里，重启后自动恢复挂载。以混合形态外部插件交付（Host 半区 + client 半区），经持久安装进 web profile。

## User Stories

1. 作为 DSH 用户，我想在设置页一个表单里填写命令/参数（或 URL/headers）来添加一个 MCP 服务器，这样我不必学习 patch YAML 语法。
2. 作为 DSH 用户，我想在一页上看到我添加的所有 MCP 服务，这样我能知道当前环境里有什么扩展可用。
3. 作为 DSH 用户，我想用开关暂时停用某个服务而不删除配置，这样我能在不用时关掉它、之后一键恢复。
4. 作为 DSH 用户，我想重新启用后它的工具立刻回到会话工具集，这样我不必重启应用。
5. 作为 DSH 用户，我想添加成功后立刻在当前对话里看到徽标变绿并显示注册的工具数，这样我确认连上了而不是盲等。
6. 作为 DSH 用户，我想编辑一个已有服务的命令或 URL，这样配置错了不用删除重建。
7. 作为 DSH 用户，我想删除不再需要的服务，这样列表保持干净，它占用的 serverName 释放出来。
8. 作为 DSH 用户，我想让 env / headers 里的 API key 在网络读取中被逐键脱敏，这样密钥不会出现在任何响应里。
9. 作为 DSH 用户，我想在编辑表单里留空密钥字段提交时保留原值，这样修改 transport 不会意外清掉密钥。
10. 作为 DSH 用户，我想在密钥字段里写 `${VAR}` 引用宿主环境变量，这样高敏感密钥可以不落盘。
11. 作为 DSH 用户，我想在添加了一个连不上的服务时仍保存配置、行上显示 🔴 错误摘要，这样我能改好配置再试而不丢表单。
12. 作为运行中的 agent 会话，我想被停用的服务的工具从工具集消失，这样我不会调用不可用的工具。
13. 作为 DSH 用户，我想重启后配置仍在且启用的服务自动重新挂载，这样管理动作是一次性的。
14. 作为 DSH 用户，我想手工写进 patch 的 mcp-client 行不出现在页面上也不被页面改写，这样两个配置渠道互不干涉。
15. 作为 DSH 用户，我想页面文案跟随我选择的界面语言（中英），这样与其它设置项体验一致。
16. 作为 DSH 用户，我想在名称不符合 serverName 字符集或与其它条目重名时被表单拒绝并说明原因，这样错误发生在保存前。
17. 作为 DSH 用户，我想删除条目时有确认步骤，这样不会手滑丢掉正在用的服务配置。
18. 作为并发编辑的用户（两个页面/实例），我想写入经 revision fencing 仲裁，这样后写者得到冲突提示而不是静默覆盖。
19. 作为外部进程/手工编辑 settings.yaml 的人，我想页面通过文件热-watch 反映文档级变更，这样真相源不被 GUI 独占。
20. 作为维护者，我想整个特性是一个可注入、可持久安装、可干净卸载的混合插件，这样它不动主线 packages/ 就能交付验证。
21. 作为维护者，我想挂载失败（serverName 保留冲突、工具名冲突）表现为该行的错误状态而不是拖垮宿主进程，这样单个坏配置无害。

## Implementation Decisions

- **交付形态**：混合形态外部插件（Host 半区 + client 半区），经插件持久安装通道进入 web profile，重启自动装配；不经运行时临时注入交付。
- **真相源**：新建 settings namespace `mcp.servers`。页面全部读写走既有 settings 分层服务（路径寻址 mutate、revision fencing、文件 provider 热-watch），落盘 harness home 的 settings 文档（0600）。不读写 profile patch 文件，不引入 `~/.mcp.json` 式外部格式。
- **Schema**：`servers` 为以 serverName 为键的 dict；每条含 `enabled`、判别字段 `transport: stdio | streamable-http`，stdio 取 `command/args/env/cwd`，http 取 `url/headers`。字段校验镜像 mcp-client 的 Service Definition Config（含 serverName `[A-Za-z0-9_-]{1,32}`）。`env` 与 `headers` 的每个值标 secret role。

- **挂载机制**：Host manager 经 settings 变更事件驱动，对每条启用项用进程内插件挂载（`ctx.plugin(McpClient, config)`，即 ACP 会话挂载的同款机制），目标为根作用域 ctx → 工具落进全局工具层，所有活动会话即时可见；`fiber.dispose()` 即净卸载（连接断开、工具注销、serverName 保留释放）。不走 loader.create / dynamicCordisRunner（前者会被配置对账盖 `disabled`，后者是 VM 沙箱无法加载 npm 插件）。
- **变更语义**：任何字段变更 = dispose 后重挂（连接换代）；`enabled: false` 或删除 = 只 dispose；`${VAR}` 值在挂载前对宿主进程环境展开；mcp-client 的重连预算在 mount 后照常工作。
- **状态投影**：manager 维护每条目运行状态（连接结果、工具数、最后错误），经插件自带的 Typert Remote 只读暴露；状态不进真相源，状态视图不含密钥值。工具注册滞后挂载一轮异步 `tools/list`，徽标随之翻转。
- **密钥线协议**：`env`/`headers` 的值标 secret role → wire 读取逐键缺席 + `{path, set}` sidecar；更新用稀疏 patch（缺省键保持已存值）；客户端表单密钥字段空白 = 不写入（沿用设置卡片既有的写-only 控件语义）。落盘明文（0600）是仓库既有安全模型，不另造加密。
- **UI**：注册 `settings.section` slot（顶级"MCP"，排在 Plugins 后）。列表行：名称、transport 摘要、状态徽标、开关、编辑、删除（带确认）。添加/编辑为模态表单，transport 判别切换字段集。文案走插件自带 locale namespace（zh 为键源、en 对齐），受硬编码文案门约束。
- **命名与冲突**：条目键即 serverName，全局唯一；重名/非法字符保存前拒绝；运行期保留冲突（含 patch 手工行占用同名）捕获后转该行错误状态，不影响其它条目与宿主。
- **改名语义**：编辑不允许改 serverName（改名 = 删除重建），避免条目身份与工具命名空间漂移。

## Testing Decisions

- 好测试只断言外部行为：settings 文档进 → 工具注册表与状态视图出；不断言 manager 内部（登记表、fiber 字典）实现细节。
- **主缝隙（复用现有进程内装配缝隙）**：真实 settings service + manager 插件 + 工具运行时 + 真实 MCP fixture 服务器（mcp-client 测试族已有 stdio / streamable-http 两种 fixture 服务器先例），驱动 `mcp.servers` 增/改/开关/删，断言 `mcp__*` 工具出现、换代、消失，状态视图随连接成功/失败翻转，校验拒绝（重名、非法名），以及 wire 读取的逐键脱敏与稀疏更新保密钥（settings 包 redact 测试族已证明 dict 值级脱敏可用）。本特性测试全部落在插件自己的测试目录，不改 mcp-client 测试。
- **次缝隙（复用现有 web e2e 缝隙）**：一条金路径走查——真实 host 启动，浏览器进设置页 MCP section，表单添加 stdio 服务至 🟢，关开关后验证会话工具集消失。先例是 apps/web 设置模态框族 e2e。
- **快照**：外部插件阶段不占主线 recorded-session 快照树；转正进 packages/ 时按仓库测试政策补免密快照（fixture MCP 服务器可作为 fixtures）。

## Out of Scope

- 展示/接管 patch 手工配置的 mcp-client 行（两渠道互不可见）。
- per-profile 的 MCP 列表分叉（真相源天然全局）。
- 展开查看某服务注册的工具明细列表。
- OAuth / headers 令牌刷新等鉴权流。
- 模型侧管理工具（让 agent 自己增删 MCP 服务）。
- 主线 packages/ 化、Service Definition 正规 capability-seam 拆分、上游文档双语化——转正时另立 spec。
- MCP server 推荐/市场类发现功能。

## Further Notes

- 设计经逐轮 grilling 确认（交付载体、真相源、展示范围、transport、页面位置、操作集、生效时机、持久性、作用域、密钥、状态、失败处理）。
- 两项关键事实已在调研中证实：进程内 `ctx.plugin` 挂载使工具进全局层且 dispose 即净（ACP 生产先例）；secret role 对 dict 值逐键脱敏且"缺省保持原值"是设置卡片既有语义。
- 风险：`serverName` 保留表全局唯一，页面条目与 patch 手工行同名时该条目挂载报错转 🔴（设计内行为）；多实例同时运行各自进程挂载同一份配置是预期语义（配置共享，连接进程内）。

## Comments
