# 05: 密钥语义 + `${VAR}` 展开

**What to build:** 用户在 env（stdio）与 headers（http）里填的密钥值永不出现在任何网络响应中；编辑一个已有密钥的条目时密钥字段为空白占位、留空提交保留原值；用户可以在值里写 `${VAR}` 引用宿主环境变量，密钥本身不落盘。

**Blocked by:** 01（Tracer bullet）、04（streamable-http，headers 密钥依赖其落地）

**Status: implemented (verification pending review)

- [ ] `env` / `headers` 的每个值标 secret role：wire 读取逐键缺席 + `{path, set}` sidecar（表单据此渲染"已配置"占位）
- [ ] 编辑表单密钥字段空白提交 = 不写入该键（稀疏 patch 语义）；非空 = 写入新值；显式清除走删除键操作
- [ ] 状态与列表视图不含密钥值（错误摘要也须脱敏）
- [ ] manager 挂载前将 `${VAR}` 形态的值对宿主进程环境展开；引用不存在的变量时该行报错而非静默传空串
- [ ] 落盘文档中密钥明文（0600）为仓库既有安全模型，不引入加密
- [ ] 主缝隙测试：添加带 env 密钥的条目 → describe sidecar 报 `set: true` 且值缺席；编辑留空提交 → 已存值保持并能连上 fixture；`${VAR}` 引用生效；引用缺失变量 → 行级错误
