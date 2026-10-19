# Agent Note: 撤销启动器注入的 Session 查询索引槽

Status: implemented

[English](2026-10-15-retire-launcher-session-query-index-slot.md) | 中文

## Problem

TUI 时期的修复 `fix(tui): isolate each process query index`（2026-07-29）让启动器安装 `ctx.launcherSessionQueryPath`，以便每个 TUI 进程把派生 SQLite 查询索引指向自己的一次性路径：`SESSION_QUERY_SQLITE_PATH_KEY` 持有该 boot-context 键，`declare module '@deepseek-ai/cordis'` 合并块声明了这个可选槽。删除 TUI 的 `cleanup: remove TUI package and legacy dsh entrypoints`（2026-08-04）删掉了那个包，以及设置和读取它的入口。

现在没有任何代码提供或读取这个槽。按精确名、调用点与计算键检索，只剩声明本身、键常量和[目录生成器的豁免项](../../../../scripts/gen-cordis-catalog.ts)——而那条豁免声称本包 README 拥有该契约，README 却从未提到这个键。README 记录的是部署路径：`path` 是必填 Config 字段（"Dedicated derived-index SQLite path, or `:memory:`"），缺失目录由插件以 owner-only 创建，并且 README 明确把常用路径写成"挂载插件并给它一个专用数据库路径"。需要专用位置（包括每个进程一条路径）的部署，在它自己的插件条目上配置 `path`。

## Decision

删除 `launcherSessionQueryPath` 的 Context 合并块与 `SESSION_QUERY_SQLITE_PATH_KEY`，并移除命名它们的 `SERVICE_WALK_EXEMPTIONS` 条目。生成器会拒绝 Context 键没有被任何合并块声明的豁免项，因此这两处删除必须是同一个改动，而不能留作后续清理。派生索引位置仍由 `path` 决定，运行时行为不变：既然没有生产者，也就没有消费者失去取值。

让出的能力：启动器不能再通过 Context 把查询索引路径交给某一个进程。每个进程改为用自己的 `path` 挂载该插件——README 本来就把这条写成显式路径。

重新引入的条件：启动器必须把派生索引放到组合的静态配置之外，例如多个进程无法各自声明 `path` 却共用一个 `cordis.yml`；或者 boot 代码必须在插件树解析之前就确定索引位置。

## Alternatives considered

**保留该槽，并在包 README 里补上启动器契约。** 豁免项本来就声称 README 拥有该契约，而 README 并没有承载它。保留它还意味着为一个已由必填 Config 字段拥有的取值维护第二条路径。

**保留声明与豁免，但不写文档。** 这正是被移除的状态：一个没有任何生产者安装的可选 Context 键，对渲染投影不可见，其豁免却声称了一个并不存在的拥有者。

**只删声明，保留豁免。** 生成器会拒绝：`SERVICE_WALK_EXEMPTIONS` 不得命名没有任何 Context 合并块声明的键。

## Verification

- 仓库中不再有对 `launcherSessionQueryPath` 或 `SESSION_QUERY_SQLITE_PATH_KEY` 的任何引用，按精确名与计算键检索皆为空。
- `gen-cordis-catalog --check` 通过：没有 Context 键对渲染投影不可见，也没有豁免项活得比它的声明久。
- `session-query-sqlite` 与 `session-query` 套件通过，包通过类型检查。

## Consequences

得到：宿主面少一个可选 Context 键、少一条声称文档拥有者的豁免项，派生索引位置只剩一条被记录的路径。付出：曾安装该槽的启动器改为按插件条目配置 `path`。
