# 07: Web e2e 金路径 + 演示录屏

**What to build:** 一条跑在真实 host 上的浏览器端到端测试钉住整条产品路径：打开设置页 → MCP section → 表单添加一个 stdio MCP 服务器 → 徽标转绿 → 关闭开关 → 会话工具集消失。同时按仓库惯例为这次 GUI 可见变更录制 GIF 演示。

**Blocked by:** 01（Tracer bullet）、02（开关）、06（状态徽标）

**Status:** ready-for-agent

- [ ] apps/web e2e 族新增一条走查：以 overlay 装配插件 → 设置模态框出现 MCP section → 添加 fixture 级 stdio 服务器至 🟢 → 断言会话工具集含其工具 → 关开关 → 断言工具消失
- [ ] e2e 免真实 API key（复用既有 keyless 装配模式），进 CI 可跑
- [ ] 从真实运行实例录制交互 GIF（添加、开关、状态翻转），存放到插件产物目录供 PR/演示引用
- [ ] 中英两种界面语言下各截图核对一遍文案无溢出、无缺键
