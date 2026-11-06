# Scan 上限是安全不变量，不是 Config 字段

`assembleScanRun` 固定两条护栏：单次审计最多列出 200 个跟踪文件（超出即报错并指路"pass narrower paths"）、单文件超过 2MiB 即排除并记录原因。我们刻意**不**把它们做成 `maxScanFiles`/`maxScanBytes` 配置项：护栏的作用是防止无界读取（token 与内存），配置化会把"拆除护栏"变成一次常规编辑，而这正是它们要防的事故面。同性质的常量还有 `GIT_TIMEOUT_MS=15s`、bundle 每文件组 ≤10、目录簇 ≤6。

## Considered Options

- **升为 Config 字段 + 硬顶**：被拒。需要同时维护默认值、区间、硬顶三层，而当前没有任何消费者需要调它（"no hardcoded tunables"规则针对部署口味，不针对安全不变量）。
- **预览/评审同样加上限**：暂不——diff 模式的目标数由 git 变更天然约束；若未来出现巨型 diff 再议。

## Consequences

超限的巨型审计会失败并要求 `paths` 缩窄——显式、可解释，而不是静默截断丢文件。
