# Review Worker 的安全限制永不降级

subagent adapter 启动评审子 agent 时携带只读工具面与深度上限 `maxDepth = 父深度 + 1`（评审 worker 自身禁止再委派）；工具面在 rc.2 之前来自启动请求的 `toolFilter`（read/read_image/grep/glob），rc.2 起改由 **Agent Preset**（`agentPreset`）承载，因此适配器要求配置 `subagentPreset`。provider 声明不支持这些启动能力、或未配置只读 preset 时**启动直接失败**，不回退为无限制子 agent。评审者不改仓库、不产生无界孙代是这个插件的安全底线，"降级运行"会让底线静默消失。

## Considered Options

- **能力不匹配时回退为无限制请求（此前的实现）**：被拒——安全限制静默丢失，且用字符串嗅探错误码触发，属于静默行为。
- **回退但把降级写进结果元数据**：被拒——限制是否生效不该由调用方自觉阅读元数据来发现。
- **配置开关 `allowDegradedWorkers`**：被拒，为不存在的需求加配置面。

## Consequences

不支持这些能力的 provider（如部分外部 ACP 后端）上 subagent 通道从"降级运行"变为"显式失败"；操作者显式切 `worker: llm`（打包上下文直调，同样无写权限）。

## Update: rc.2 起工具面改由 Agent Preset 承载

rc.2 从 `SubagentStartRequest` 移除了 `toolFilter`（工具配置统一进 preset 的插件列表，见 upstream `tool-subagent` 的迁移报错）。适配器相应改为传 `agentPreset: <subagentPreset>`；未配置时 `createWorker` 直接抛错，`worker: auto` 自动改用 llm 通道。**限制不降级的结论不变**，只是机制随宿主 API 迁移；`maxDepth` 语义不变。
