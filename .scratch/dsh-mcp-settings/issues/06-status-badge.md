# 06: 状态徽标（Remote 投影）

**What to build:** 用户每行看到真实连接状态：🟢 已连接（含注册工具数）、🔴 最后错误摘要、⚪ 已停用。添加一个连不上的服务时配置仍保存成功、行上直接显示错误——不用翻日志就知道没连上，修好配置随时恢复。

**Blocked by:** 01（Tracer bullet）、02（开关——停用态是徽标的一个取值）

**Status: implemented (verification pending review)

- [ ] Host manager 维护每条目运行状态（连接结果、工具数、最后错误），经插件自带的 Typert Remote 只读暴露
- [ ] 状态不进 settings 真相源；Remote 视图不含密钥值
- [ ] 行徽标三态渲染：🟢（工具数随异步 tools/list 滞后一轮后翻转）、🔴（错误摘要）、⚪（停用）
- [ ] 添加即失败的条目保存并启用成功，行显示 🔴 而非回滚表单；mcp-client 重连预算照常工作，连上后徽标自动转 🟢
- [ ] serverName 运行期保留冲突（含与 patch 手工行撞名）捕获后转该行 🔴，不影响其它条目与宿主进程
- [ ] 主缝隙测试：连不上的 command → 条目在、状态 🔴 带错误摘要；fixture 起服后 → 转 🟢 且工具数正确；撞名 → 行级错误不崩宿主
