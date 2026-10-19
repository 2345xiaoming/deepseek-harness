# Review Worker 的安全限制永不降级

subagent adapter 启动评审子 agent 时固定携带只读 `toolFilter`（read/read_image/grep/glob）与深度上限 `maxDepth = 父深度 + 1`（评审 worker 自身禁止再委派）；provider 声明不支持这些启动能力时**启动直接失败**，不回退为无限制子 agent。评审者不改仓库、不产生无界孙代是这个插件的安全底线，"降级运行"会让底线静默消失。

## Considered Options

- **能力不匹配时回退为无限制请求（此前的实现）**：被拒——安全限制静默丢失，且用字符串嗅探错误码触发，属于静默行为。
- **回退但把降级写进结果元数据**：被拒——限制是否生效不该由调用方自觉阅读元数据来发现。
- **配置开关 `allowDegradedWorkers`**：被拒，为不存在的需求加配置面。

## Consequences

不支持这些能力的 provider（如部分外部 ACP 后端）上 subagent 通道从"降级运行"变为"显式失败"；操作者显式切 `worker: llm`（打包上下文直调，同样无写权限）。
