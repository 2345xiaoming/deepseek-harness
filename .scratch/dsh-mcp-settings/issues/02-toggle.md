# 02: 开关（enabled 语义）

**What to build:** 用户在 MCP section 的每一行用开关临时停用/启用一个服务而不删配置：关闭 → 连接断开、工具从会话工具集消失；重新打开 → 即时重挂、工具恢复。状态持久，重启后按 `enabled` 恢复。

**Blocked by:** 01（Tracer bullet）

**Status: implemented (verification pending review)

- [ ] 行上开关经 settings 稀疏更新写 `enabled`（revision fencing），不碰其它字段
- [ ] `enabled: false` → 对应 fiber dispose：连接关闭、`mcp__*` 工具注销、serverName 保留释放
- [ ] 重新启用 → 用当前配置重挂，工具回到全局工具层，免重启
- [ ] 停用态条目保留全部配置；编辑禁用中的条目不触发挂载
- [ ] 重启后仅 `enabled` 条目被重挂
- [ ] 主缝隙测试：关 → 工具 schema 消失；开 → 恢复；关态下改配置不误挂
