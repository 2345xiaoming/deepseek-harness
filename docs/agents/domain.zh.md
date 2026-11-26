# 领域文档

[English](domain.md) | 中文

工程 skill（技能）在探索代码库时，应如何消费本仓库的领域文档。

## 探索前先读这些

- 仓库根目录的 **`CONTEXT.md`**。
- **`docs/adr/`**：阅读涉及你即将改动的领域的 ADR。

如果这些文件都不存在，**静默继续**。不要指出它们缺失，也不要预先建议创建它们。名为 `/domain-modeling` 的 skill 会在术语或决策真正定案时按需创建它们（经由 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）。

## 文件结构

单上下文仓库：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-<decision>.md
│   └── 0002-<decision>.md
└── packages/
```

## 与仓库共存

本仓库既定的决策记录是 `.agents/notes/` 下的 Agent Note（依据根 `AGENTS.md`）。`docs/adr/` 只存放本 skill 流程产出的 ADR；两者共存，它们之间的冲突会被显式暴露。

## 使用术语表的词汇

当你的产出命名某个领域概念时（在 issue 标题、重构提案、假设或测试名称中），使用 `CONTEXT.md` 中定义的术语。不要漂移到术语表明确避免的同义词。

如果你需要的概念还不在术语表中，这是一个信号：要么你在发明项目不使用的说法（重新考虑），要么存在真实的空白（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的产出与既有 ADR 矛盾，请显式暴露它，而不是悄悄覆盖：

> _与 ADR-0007（事件溯源订单）矛盾，但值得重新讨论，因为……_
