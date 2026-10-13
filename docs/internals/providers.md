# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with eight entries:

| Driver kind   | Driver source                                  |
| ------------- | ---------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]              |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]            |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]            |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]                |
| `hermes`      | [`Drivers/HermesDriver.ts`][hermes]            |
| `commandCode` | [`Drivers/CommandCodeDriver.ts`][command-code] |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]        |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity]  |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and
text-generation helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent
borrowers share startup. The server closes 30 seconds after the last borrower releases it, or
when the provider instance closes. A failed or exited process can be started again on the next
use. An externally configured OpenCode server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password,
the client uses the password from the environment that the process inherits. External servers use
only their explicit provider password and never inherit the host's local password.

Every server connection must pass the authenticated `/global/health` check before inventory or
session operations start. The response must contain a valid version at or above 1.14.19. Local
owners cache this result for the lifetime of the spawned process. External actions check once when
they create their server connection, not for each model or SDK request.

Chat adapters keep their own server per thread. They register a thread-specific `t3-code` MCP
connection, while OpenCode stores MCP connections by directory. Sharing these chat servers
without changing MCP routing would let two threads in one directory replace each other's
connection.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

T3 Code does not own an external OpenCode process. Native configuration changes there can require
an external reload or restart before T3 Code's next refresh sees them.

### OpenCode V1, V2, and account switching

The OpenCode runtime resolves the server capability and version once for a connection, then routes
through a dedicated V1 or V2 adapter. It does not treat an arbitrary V2 request failure as a reason
to fall back to V1. V1 keeps its existing SDK path. V2 uses the version-matched `@opencode/client`
API. Account switching is a V2 capability; V1 list requests report it as unsupported while V1 chat
and inventory remain available.

Each adapter writes a versioned resume cursor containing its OpenCode session ID. The V1 and V2
adapters reject the other protocol's cursor with an explicit validation error. V2 also verifies the
saved session's working directory before resuming. A failed lookup or a directory mismatch leaves
the saved T3 thread intact; the adapter does not silently start an empty V2 session.

The account capability belongs to an OpenCode `ProviderInstance` and is resolved by instance ID at
the server RPC boundary. Its client uses that instance's selected environment, URL, password, and
environment overrides. Remote requests therefore reach the selected remote OpenCode server, not the
web or desktop host. The service reads `integration.get(openai)`, exposes only `credential`
connections, and derives the active ID from the first credential connection in OpenCode's resolved
connection order. `env` connections are never selectable. Credential records and OpenCode's native
credential store remain owned by OpenCode; T3 sends only the credential ID, a sanitized label, and
the method to the client.

Account activation requires `AuthAccessWriteScope`; standard pairing scopes do not include it.
The server serializes activation with OpenCode work admission using one guard shared by all
OpenCode instances in the T3 environment. The guard covers turn submission and runtime turns,
pending permissions and forms, and text-generation helpers. Before mutation, the service also checks
V2 `session.active`, permission requests, and forms so visible work from another OpenCode process
blocks the change. The activation endpoint is called once and read back from OpenCode before the
result is returned. If that readback cannot determine the active ID, the state is explicitly
unknown; the service never retries or rolls back an ambiguous mutation. Provider refresh runs while
the guard is held, then the registry publishes the refreshed provider snapshot to connected clients.

The guard only coordinates T3 work in one server environment. Separate processes that talk to the
same external OpenCode server do not share that mutex; the V2 activity check reduces this race but
does not provide a cross-process lock. Clients refresh account state when the Settings section
opens and on manual refresh. External account changes do not currently have a dedicated account
event.

The shared server's idle shutdown does not clear the catalog. Failed discovery keeps the last
known models, slash commands, and skills through the registry's existing merge rules. A successful
empty inventory is authoritative. Existing threads keep their explicit model identifier and
options when catalog metadata is missing; the catalog is not permission to choose a different
model for a thread.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Attachment access

The server stores uploaded attachments in its attachment directory, outside the project workspace.
`ProviderService` adds the absolute path of each attachment to the turn text, then passes every
attachment to the provider adapter. Each adapter decides what its provider ingests natively:

- Codex, Claude, Cursor, and Grok send images as native image inputs and skip generic files. For
  these providers, generic files reach the agent only as file paths in the turn text.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.

Claude receives the attachment directory as an allowed additional directory. Codex keeps its
configured sandbox policy, so access depends on that policy and the selected runtime mode. OpenCode
allows all paths in full-access mode and requests approval for directories outside the workspace in
restricted modes. Cursor and Grok use their own provider permission rules.

The server does not copy attachments into a project or bypass provider approval rules. If an agent
cannot read an attachment, the user must approve the access or select a runtime mode that permits it.

Antigravity receives no native attachment content in version 1. It receives paths in the turn text
and the deduplicated parent directories as `--add-dir` arguments. The adapter must not pass drive
roots, profile roots, globs, or unresolved directories.

Updated attachment schemas tolerate unknown attachment members, but old image-only clients still
cannot decode messages that contain file attachments. Client file-picking rollouts must account for
this limit.

Do not run an old image-only server against state that contains file attachments. Replay decodes
each persisted event before projection. A file-bearing event can make `ProjectionPipeline` bootstrap
and `OrchestrationEngine` startup fail for the entire environment, not only the affected thread.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts

## Hermes reasoning

Hermes ACP model discovery supplies reasoning option descriptors to the shared
model capability contract. The web composer, desktop, mobile, and Settings use
these descriptors through their existing generic option pickers.

Standard Hermes Python entry points run a process-local bridge from
`apps/server/src/provider/acp/HermesAcpBridge.ts`. It advertises
`t3:reasoning-effort` and applies it to the session agent's `reasoning_config`,
including after a model rebuild. The bridge reads Hermes's own supported levels
and default resolver; it does not modify the Hermes installation, global config,
or another session. Custom shell launchers retain their native behavior and do
not advertise this capability.

To exercise the bridge against an installed Hermes ACP package, set
`T3CODE_HERMES_PYTHON` to that environment's Python executable and run the focused
`HermesAcpBridge.test.ts` test. It uses a temporary Hermes home and disposable
session agents without credentials or model requests.

[hermes]: ../../apps/server/src/provider/Drivers/HermesDriver.ts
[command-code]: ../../apps/server/src/provider/Drivers/CommandCodeDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
