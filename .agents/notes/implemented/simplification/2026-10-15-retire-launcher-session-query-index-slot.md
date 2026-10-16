# Agent Note: Retire the launcher Session-query index slot

Status: implemented

English | [中文](2026-10-15-retire-launcher-session-query-index-slot.zh.md)

## Problem

The TUI fix `fix(tui): isolate each process query index` (2026-07-29) had a launcher install `ctx.launcherSessionQueryPath` so each TUI process pointed the derived SQLite query index at its own disposable path: `SESSION_QUERY_SQLITE_PATH_KEY` held the boot-context key, and a `declare module '@deepseek-ai/cordis'` merge declared the optional slot. The TUI removal `cleanup: remove TUI package and legacy dsh entrypoints` (2026-08-04) deleted the package and the entrypoints that set and read it.

Nothing provides or reads the slot now. Exact-name, call-site, and computed-key searches return only the declaration, the key constant, and the [catalog exemption](../../../../scripts/gen-cordis-catalog.ts) that named this package's README as its documentation owner — and that README never mentions the key. It documents the deployment route instead: `path` is a required Config field ("Dedicated derived-index SQLite path, or `:memory:`"), the plugin creates a missing directory owner-only, and the README states the common path explicitly as mounting the plugin with a dedicated database path. A deployment needing a dedicated location, including one path per process, configures `path` on its own plugin entry.

## Decision

Delete the `launcherSessionQueryPath` Context merge and `SESSION_QUERY_SQLITE_PATH_KEY`, and remove the `SERVICE_WALK_EXEMPTIONS` entry naming them. The generator rejects an exemption whose Context key no merge declares, so the two removals are one change rather than a cleanup that could be deferred. The derived-index location stays `path`, and no runtime behavior changes: no producer existed, so no consumer lost a value.

Capability given up: a launcher can no longer hand one process a query-index path through the Context. Each process gets its own path by mounting the plugin with its own `path`, which the README already presents as the explicit route.

Reintroduction conditions: a launcher must place the derived index outside the composition's static configuration, for example one `cordis.yml` shared by processes that cannot each declare a `path`, or boot code must name the index location before the plugin tree resolves.

## Alternatives considered

**Keep the slot and document the launcher contract in the package README.** The exemption already asserted that owner and the README does not carry it. Keeping the slot also means maintaining a second route to a value one required Config field already owns.

**Keep the declaration and the exemption undocumented.** That is the state being removed: an optional Context key no producer installs, invisible to the rendering projection, with an exemption claiming an owner that does not exist.

**Remove the declaration and keep the exemption.** Rejected by the generator: `SERVICE_WALK_EXEMPTIONS` may not name a key no Context merge declares.

## Verification

- The repository has no remaining reference to `launcherSessionQueryPath` or `SESSION_QUERY_SQLITE_PATH_KEY`, by exact name and by computed key.
- `gen-cordis-catalog --check` passes: no Context key stays invisible to the rendering projection, and no exemption outlives its declaration.
- The `session-query-sqlite` and `session-query` suites pass, and the package type-checks.

## Consequences

Bought: one fewer optional Context key on the host face, one fewer exemption asserting a documentation owner, and one documented route to the derived-index location. Paid: a launcher that installed the slot must configure `path` per plugin entry instead.
