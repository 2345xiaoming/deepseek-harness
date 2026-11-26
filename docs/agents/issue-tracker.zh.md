# Issue tracker：本地 Markdown

[English](issue-tracker.md) | 中文

本仓库的 issue 与 spec 以 Markdown 文件形式存放在 `.scratch/` 下。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现类 issue 每个 ticket 一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，绝不写成单个合并的 tickets 文件
- 分诊状态记录为每个 issue 文件顶部附近的 `Status:` 行
- 评论与对话历史追加到文件底部 `## Comments` 标题之下

## 仓库说明

`.scratch-routing/` 是既有的插件产物目录，与本 issue 约定无关；issue 只存放在 `.scratch/` 下。

## 当 skill（技能）要求「发布到 issue tracker」时

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在时一并创建）。

## 当 skill 要求「获取相关 ticket」时

读取所引用路径处的文件。用户通常会直接给出路径或 issue 编号。

## 寻路操作

由 `/wayfinder` 使用。**map** 是一个文件，每个 ticket 对应一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文写问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：顶部附近的 `Blocked by: NN, NN` 行。当一个 ticket 列出的每个文件都是 `resolved` 时，它即解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/` 中处于 open、未阻塞且未认领状态的文件；编号最小者优先。
- **Claim**：动工之前先设置 `Status: claimed` 并保存。
- **Resolve**：在 `## Answer` 标题下追加答案，设置 `Status: resolved`，然后把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。
