# 01: Tracer bullet——从页面添加一个 stdio MCP 服务并实时挂上

**What to build:** 用户在 Web GUI 设置页看到新的顶级 "MCP" section，通过添加表单填写 serverName、command、args（stdio），保存后 Host 侧立即挂载该 MCP 服务器，其工具以 `mcp__<serverName>__<tool>` 出现在全局工具层——新会话即可调用；重启宿主后启用的条目自动重新挂载。整个特性是一个可构建、可持久安装、可干净卸载的混合形态插件。

**Blocked by:** None (can start immediately)

**Status: implemented (verification pending review)

- [ ] 混合插件骨架建成，经持久安装通道进入 web profile，重启自动装配；卸载净（无残留 junction / patch 行）
- [ ] settings namespace `mcp.servers` 注册（serverName 为键的 dict；stdio 取 command/args/env/cwd；`enabled` 字段），校验 serverName 字符集与重名，非法/重名在保存前被表单拒绝并说明原因
- [ ] 设置页出现 "MCP" 顶级 section（排 Plugins 后），文案全走插件自带 locale namespace（zh 键源 + en 对齐，过硬编码文案门）
- [ ] 添加表单保存 → Host manager 以进程内插件挂载（根作用域 → 全局工具层），免重启；当前运行会话的后续请求即可见新工具
- [ ] 开机按 settings 文档将全部 `enabled` 条目重挂
- [ ] 主缝隙测试：真实 settings service + manager + 工具运行时 + stdio MCP fixture 服务器——添加 → `mcp__*` 出现在工具 schema；删除条目 → 消失；启动重挂路径各一条
- [ ] 端到端手动验证：浏览器添加一个真实 stdio MCP 服务器，新会话中其工具可被列出
