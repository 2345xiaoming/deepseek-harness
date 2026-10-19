# Office ground rules

These rules apply to every Office skill; the format-specific steps above take precedence where they are more specific.

## Use the bundled runtime

Use the bundled LibreOffice binaries unless the user explicitly asks not to use them. Without that explicit opt-out, never search for or invoke system LibreOffice, `soffice`, an application-installed binary, or a downloaded replacement. If the bundled CLI is unavailable or fails, report that failure instead of substituting another executable.

Use the `libreofficeKit.node` and `libreofficeKit.cli` absolute paths supplied in the loaded skill's **Installed LibreOffice Kit** section. Run Node with the CLI entry as its first argument, then `capabilities --json` once. For the bundled runtime, these paths work from the task directory; do not search PATH, guess a package directory, use `npx`, or install a renderer. Quote each path separately; PowerShell also requires the `&` invocation operator. The commands above use `<node>` and `<cli>` for those two returned paths.

## Structural check

Run the shared checker with the selected Python executable; `<skill-directory>` is this loaded skill's resource base:

```text
<python> <skill-directory>/../scripts/check_office.py <file> --out <checks.json>
```

The checker reports structure and content only; it never renders, calculates, or judges appearance.

## Visual inspection

Before generating images only for inspection, establish that the current model accepts images. If image input is unavailable, finish structural and content checks and state that visual layout was not inspected; do not generate unreadable previews, retry `read_image`, or choose a second model.

If this deployment explicitly disables the CLI but `render_document` is provided, call it without `pages` first and read the returned images only on a ready result; `status: "skipped"` ends visual checking. If neither renderer is available or rendering fails, preserve the usable source and report the inspection limit. Do not search for COM automation, install conversion packages, or build another rendering pipeline for routine QA.

## Workspace and delivery

Keep source scripts, intermediate files, and the final file in the task workspace; the runtime and the loaded skill directory are read-only resources.

Deliver the finished file with `present({"files":[{"path":"<final file>"}]})` using its actual final path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and omit intermediate scripts, previews, and QA reports unless the user requests them. If `present` is unavailable, use the session's supported file delivery method.
