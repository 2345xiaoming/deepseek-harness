---
kind: upgrade-guide
description: "The bundled pi-ai catalog renames the Azure Responses provider id to `azure` and changes OpenCode Go model ids."
---

# The pi-ai provider catalog renames `azure-openai-responses` to `azure`

English | [中文](guide.zh.md)

## Change

`@earendil-works/pi-ai` moves from 1.0.2 to 1.2.0, so the bundled provider and model catalog is rebuilt from the upstream 2026-10-12 data. Two catalog values used in settings change:

- The Azure Responses provider id is `azure`; `azure-openai-responses` remains the wire-protocol name its models carry. A settings route or stored credential keyed by the old id no longer resolves: the route reports `resolves no models`, and its credential is not found.
- OpenCode Go adds `claude-haiku-5-5` and `step-5-preview-free`, and renames `space-bunny-free` to `space-bunny`. A saved `space-bunny-free` selection matches no catalog model.

Who observes it: anyone whose settings name `azure-openai-responses` as a provider id, or who selected `space-bunny-free`.

## Migration

1. In Settings → Models, or in the `llm-pi-ai` `providers` map, rename the provider key `azure-openai-responses` to `azure` and keep its other fields.
2. Re-enter that route's API key under the new id: credentials are stored as `llm-pi-ai/<provider-id>`.
3. Keep the old id only on a route that lists its `models` explicitly; otherwise the route fails loudly when it activates.
4. Replace a saved `space-bunny-free` selection with `space-bunny`, then confirm the model selector lists the provider and the model.
