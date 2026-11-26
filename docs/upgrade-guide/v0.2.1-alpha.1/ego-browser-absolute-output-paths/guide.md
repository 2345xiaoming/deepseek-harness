---
kind: upgrade-guide
description: "ego-browser output paths must be absolute, and task.finish() returns a receipt."
---

# ego-browser output paths must be absolute

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ego-browser` re-ports the upstream ego-browser harness from v2.0.0-beta.4 to v2.1.0-beta.2. Two harness behaviors reachable through `browser_screenshot`, `browser_run`, and learned site skills changed.

`page.screenshot({ path })` and `page.fetch({ saveAs })` now reject a relative path before any page work, with `<label> must be an absolute file path`. The previous release wrote to whatever path it was given, resolving a relative one against the host process working directory, so a stored `browser_run` snippet or site skill that wrote `shots/home.png` now fails instead of writing there. The `browser_screenshot` `path` parameter documents the requirement.

`task.finish()` returns a receipt instead of `undefined`:

```js
{ spaceId, closedSpace, keptManagedLabels, closedManagedLabels, preservedUnmanagedCount }
```

Code that tested `finish()` against `undefined` no longer detects the outcome that way.

## Migration

1. Make every output path absolute in `browser_run` snippets, learned site skills, and `browser_screenshot` callers.

   ```js
   // before
   await page.screenshot({ path: 'shots/home.png' })
   // after
   await page.screenshot({ path: '/workspace/shots/home.png' })
   ```

   The same applies to `page.fetch({ saveAs: ... })`.

2. Replace `undefined` checks on `task.finish()` with the receipt fields.

   ```js
   // before
   if (await task.finish() === undefined) { /* ... */ }
   // after
   const receipt = await task.finish()
   receipt.closedManagedLabels // labels the finish released
   ```

3. Confirm: a `browser_run` call passing a relative `path` fails with `page.screenshot path must be an absolute file path`, and the same call with an absolute path writes the file.
