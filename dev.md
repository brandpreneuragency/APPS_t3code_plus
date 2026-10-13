# Fork dev notes

Local changes on `my-mods` that upstream T3 Code does not have. Read this before
assuming the sidebar still matches upstream.

## Project rail

The default thread sidebar no longer uses a project-filter combobox. An open
project list sits on the left of that same sidebar. Choosing a project filters
threads; **All projects** clears the filter.

This is not a second sidebar primitive. `ui/sidebar.tsx` only supports one left
panel (`fixed left-0`, one `--sidebar-width`). The rail is a fixed column inside
the existing panel.

Filter state is unchanged: `projectScopeKey` in `Sidebar.tsx`, applied through
`scopedProjectKeys`. A missing project still clears the scope. Changing scope
still clears the thread selection.

### Where

- `apps/web/src/components/sidebar/ProjectScopeRail.tsx` — the list, search, settings gear, and add button
- `apps/web/src/components/Sidebar.tsx` — mounts the rail and no longer renders the combobox
- `apps/web/src/components/threadSidebarWidth.ts` — rail is 192px; sidebar min is 400px; default is 448px
- `apps/web/src/components/Sidebar.logic.ts` — `filterProjectScopeRailItems` replaced the combobox filter and menu reducer
- `docs/user/thread-sidebar.md` — user-facing note

A saved sidebar width below 400px is clamped up on the next launch. Wider saved
widths stay; the thread column loses 192px until the edge is dragged. Double-click
the resize edge to reset to 448px.

### Bottom new-thread button

The thread column (right of the rail) ends with a full-width **New thread**
button. It always creates directly in the rail's selected project, without the
project picker the top-right icon opens in multi-project setups. With **All
projects** selected it falls back to the current context (active thread's
project, then the top project), still without a picker.

- `apps/web/src/components/Sidebar.tsx` — `handleNewThreadInScopedProjectClick`
  and the footer below `SidebarContent`
- `docs/user/thread-sidebar.md` — user-facing note

### File-manager open/reveal strips `:line:col`

Chat and terminal links carry `path:line:col` targets for real editors.
`resolveEditorLaunch` in `apps/server/src/process/externalLauncher.ts` now
strips that suffix for `file-manager` launches (plain open and reveal, all
platforms). Before, `explorer "<path>:<line>"` named a nonexistent path, so
Open in editor fell back to Documents and reveal silently selected nothing.
Covered by two cases in `externalLauncher.test.ts`.

### Workspace root-relative file targets

Chat and terminal targets like `/tabs-icon.png` name nothing on Windows.
`resolvePathLinkTarget` and `isRelativePath` read a `/` root as absolute on
every platform, so the target reached `shell.openInEditor` unchanged and
Explorer opened its default folder again. Both now let the workspace root
decide: a `/` root is relative against a Windows root and absolute against a
POSIX one. `isWindowsPathStyle` is exported from `terminal-links.ts` for that
decision. `joinPath` also strips a leading separator in the Windows branch, so
a root-relative target does not build a doubled backslash.

- `apps/web/src/terminal-links.ts` — `isAbsolutePath`, `joinPath`
- `apps/web/src/markdown-links.ts` — `isRelativePath`
- `terminal-links.test.ts`, `markdown-links.test.ts` — three cases each

### The file manager is a fallback, not a preference

`file-manager` is available on every Windows workspace, so storing it in
`t3code:last-editor` pinned "Open in editor" to Explorer forever and a later
editor install never took effect. `resolveAndPersistPreferredEditor` and
`usePreferredEditor` now ignore a stored `file-manager` whenever a real editor
is available, and never write it back.

- `apps/web/src/editorPreferences.ts` — `pickPreferredEditor`
- `editorPreferences.test.ts` — five cases

### Not covered

- Custom workspaces still use `WorkspaceSidebar` and do not show this rail.
- The legacy sidebar is unchanged.
- The React Native app is unchanged. The web sidebar, including its mobile sheet, does show the rail.
- The installed T3 Code + app does not pick this up until a rebuild (`vp run dist:desktop:win:x64`) or a dev server from this source.

## Reading a thread by its id

Only for an explicit request authorizing the exact thread/dataset and read
action. A supplied ID does not grant blanket database or provider-transcript
access. Use synthetic fixtures for development; real-data inspection follows
the read-only snapshot and privacy rules in [AGENTS.md](AGENTS.md). Never copy
credentials or transcripts into logs, Git or general reports.

`Copy > Thread ID` copies the T3 thread id (`projection_threads.thread_id` in
`<home>/userdata/state.sqlite`). No agent surface resolves that id: the MCP
server exposes only `preview_*` tools, and a provider CLI session is keyed by
its own id, so an agent handed the raw UUID finds nothing. Bridge the two:

1. `SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id = '<THREAD_ID>';`
2. The `threadId` in that JSON is the provider-native id. A Codex transcript
   carries it in its name under `~/.codex/sessions/<year>/<month>/<day>/rollout-*<threadId>*.jsonl`.

Thread content lives in `projection_thread_messages`,
`projection_thread_activities`, and `projection_turns`. Do not read
`projection_thread_sessions.provider_thread_id`; it is null on every row.

## Historical verification note

The original note did not record its date/revision. It is retained as context,
not a current passed result or proof that today's runner is broken. Recheck
only the targeted checks needed by the active task.

Web typecheck passed (`vp run typecheck` in `apps/web`). The web unit runner
still fails on every test file with a Vitest `config` error, so it executed
none of these tests; the changed functions were bundled with esbuild and run
against 22 assertions instead, 22 of which passed. The runner failure
reproduces on an untouched file (`editorLabels.test.ts`), so it is
pre-existing. `vp lint` passed on the changed files.

