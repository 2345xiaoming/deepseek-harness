# 04: streamable-http transport

**What to build:** 用户在添加表单上切换 transport 类型选 streamable-http，填 url（与可选 headers）即可添加一个 HTTP 型 MCP 服务器，同样免重启即时挂载、工具进全局层。

**Blocked by:** 01（Tracer bullet）

**Status: implemented (verification pending review)

- [ ] 表单 transport 判别切换字段集：stdio 显示 command/args/env/cwd，streamable-http 显示 url/headers；互斥字段不残留提交
- [ ] schema 判别联合校验：transport 与字段集一致性在保存前拒绝（错配给出行内提示）
- [ ] Host manager 对 http 条目用 streamable-http transport 配置挂载，语义与 stdio 一致（换代/卸载复用 02/03 的通路）
- [ ] 主缝隙测试：http MCP fixture 服务器添加 → 工具出现；改 url 指向另一 fixture → 换代；URL 非法 → 保存前拒绝
- [ ] 已发布条目不被 transport 变更静默破坏（transport 在编辑中可改，改动即换代）
