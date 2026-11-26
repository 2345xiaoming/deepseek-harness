# 03: 编辑与删除

**What to build:** 用户点行上的编辑按钮回填表单（serverName 锁定不可改，改名 = 删除重建），提交后连接换代、新配置即时生效；点删除弹确认后条目消失、连接净断、serverName 释放可再复用。

**Blocked by:** 01（Tracer bullet）

**Status: implemented (verification pending review)

- [ ] 编辑表单以当前条目回填；serverName 字段只读
- [ ] 任一配置字段变更 → 旧 fiber dispose、新配置重挂（工具换代），免重启
- [ ] 删除带确认步骤；确认后条目从文档消失、fiber dispose、工具注销
- [ ] 删除后同名条目可重新添加并成功挂载
- [ ] 外部热-edit settings 文档（手工改 YAML）同样驱动重挂/卸载（走文件 provider 的文档级变更事件）
- [ ] 主缝隙测试：编辑 command 指向第二个 fixture 服务器 → 工具集合换代；删除 → 全局净
