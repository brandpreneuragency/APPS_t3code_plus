# Sidebar workspaces

Sidebar workspaces organize physical project references in Electron and Alpha development web. They introduce
no server entities, orchestration events, database migrations, or provider-specific behavior.
`AppSidebarLayout` selects the custom sidebar outside Settings; its chat children remain outside
that selection. Default continues to honor the existing sidebar preference.

`sidebarWorkspaceStore.ts` owns versioned local preferences under
`t3code:sidebar-workspaces:v1`. UI, creation scope, and persistence use `sidebarWorkspacesEnabled`:
Electron or a development build with `VITE_ALPHA_WORKSPACES=1`. `dev:alpha:web` enables this flag
and serves the local frontend against the running Alpha backend. A local
`apps/web/.env.development.local` can enable it for an already-running Vite server. Production
web and native mobile do not enable this feature. The existing desktop origin,
`t3code://app`, is independent of the backend port, so changing that port does not change the
localStorage origin. Development uses the separate `t3code-dev://app` origin.
Alpha web keeps its own browser-origin preferences; connecting to the same backend shares
projects and chats, but does not import or sync the desktop workspace layout.

Membership uses `ScopedProjectRef` and `scopedProjectKey`, never path matching or logical
repository grouping. Hydration keeps the first custom owner in saved workspace order. Offline
and temporarily absent projects retain their references and cached presentation fields. Unknown
future versions and unreadable saved values must remain intact, with an actionable storage error
instead of silently replacing them.

One canonical chat order belongs to each physical project, outside workspace membership. Moving
a project preserves that order. Status changes partition the canonical order; dragging within a
status group replaces only its occupied slots. Reconciliation adds unseen keys without sorting
known keys on later activity. Search and pagination do not mutate canonical order. Expansion is
workspace-local; transient search, scroll, and pagination state are kept in memory.

Creation scope is separate from chat-tool scope. Workspace new-chat entry points resolve only
eligible attached projects, while explicit thread actions and the open chat's file, terminal,
and Git tools retain their original targets. Project-picking intents capture their initiating
workspace through asynchronous completion. Attachment changes membership only after project
creation succeeds, and does not navigate away from the current chat. The captured target is
revalidated when a native folder picker, repository clone, or project creation completes; if the
workspace was deleted or the project is no longer eligible, the project remains in Default and no
stale membership or navigation is applied.

Custom workspace sidebar and palette search match scoped titles. They do not issue broad
full-content searches and filter the capped results: that approach could miss valid scoped
matches. Default retains its existing search behavior. The feature uses thread shells and shared
settlement and action-capability helpers, leaving provider adapters and wire contracts unchanged.
Disconnected project references keep their membership and cached header metadata, but server
dependent actions are gated by the current environment connection.
