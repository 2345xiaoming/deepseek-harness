---
kind: upgrade-guide
description: "ego-browser 的输出路径必须为绝对路径，task.finish() 改为返回回执。"
---

# ego-browser 输出路径必须为绝对路径

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ego-browser` 把上游 ego-browser harness 从 v2.0.0-beta.4 重移植到 v2.1.0-beta.2。有两处 harness 行为会经 `browser_screenshot`、`browser_run` 与站点技能被观察到。

`page.screenshot({ path })` 与 `page.fetch({ saveAs })` 现在在做任何页面操作之前就拒绝相对路径，报 `<label> must be an absolute file path`。上一版本会写入传给它的任意路径，相对路径按宿主进程的工作目录解析；因此既有的 `browser_run` 片段或站点技能若写 `shots/home.png`，现在会失败而不再写入该处。`browser_screenshot` 的 `path` 参数已说明该要求。

`task.finish()` 不再返回 `undefined`，改为返回回执：

```js
{ spaceId, closedSpace, keptManagedLabels, closedManagedLabels, preservedUnmanagedCount }
```

以 `undefined` 判断 `finish()` 结果的代码不再能这样判断。

## 迁移

1. 把 `browser_run` 片段、站点技能与 `browser_screenshot` 调用中的输出路径全部改为绝对路径。

   ```js
   // before
   await page.screenshot({ path: 'shots/home.png' })
   // after
   await page.screenshot({ path: '/workspace/shots/home.png' })
   ```

   `page.fetch({ saveAs: ... })` 同理。

2. 把对 `task.finish()` 的 `undefined` 判断改为读取回执字段。

   ```js
   // before
   if (await task.finish() === undefined) { /* ... */ }
   // after
   const receipt = await task.finish()
   receipt.closedManagedLabels // labels the finish released
   ```

3. 确认：传相对 `path` 的 `browser_run` 调用报 `page.screenshot path must be an absolute file path`；改传绝对路径后文件写入成功。
