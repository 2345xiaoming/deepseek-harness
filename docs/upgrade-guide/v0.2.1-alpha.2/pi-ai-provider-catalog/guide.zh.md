---
kind: upgrade-guide
description: "内置 pi-ai 目录把 Azure Responses 的 provider id 改名为 `azure`，并调整了 OpenCode Go 的模型 id。"
---

# pi-ai provider 目录把 `azure-openai-responses` 改名为 `azure`

[English](guide.md) | 中文

## 变更

`@earendil-works/pi-ai` 由 1.0.2 升到 1.2.0，内置的 provider 与模型目录按上游 2026-10-12 的数据重建。设置中会用到的两处目录取值随之改变：

- Azure Responses 的 provider id 改为 `azure`；`azure-openai-responses` 仍是其模型携带的线协议名。以旧 id 写的设置路由或凭据不再能解析：该路由报 `resolves no models`，其凭据也找不到。
- OpenCode Go 新增 `claude-haiku-5-5` 与 `step-5-preview-free`，并把 `space-bunny-free` 改名为 `space-bunny`。已保存的 `space-bunny-free` 选择匹配不到任何目录模型。

受影响者：设置中以 `azure-openai-responses` 作为 provider id 的用户，或曾选择 `space-bunny-free` 的用户。

## 迁移

1. 在「设置 → 模型」中，或在 `llm-pi-ai` 的 `providers` 映射里，把 provider 键 `azure-openai-responses` 改名为 `azure`，其余字段保持不变。
2. 在新 id 下重新录入该路由的 API key：凭据按 `llm-pi-ai/<provider-id>` 存储。
3. 只有显式列出 `models` 的路由才能保留旧 id；否则该路由在激活时会直接报错。
4. 把已保存的 `space-bunny-free` 选择替换为 `space-bunny`，然后确认模型选择器能列出该 provider 与模型。
