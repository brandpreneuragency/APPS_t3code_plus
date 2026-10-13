import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { beforeEach } from "vite-plus/test";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import * as OpenCodeWorkGuardModule from "../OpenCodeWorkGuard.ts";
import { OpenCodeWorkGuard } from "../OpenCodeWorkGuard.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { makeOpenCodeAccountManagement } from "../OpenCodeAccountManagement.ts";
import * as OpenCodeServerOwnerModule from "../OpenCodeServerOwner.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapterDispatcher.ts";
import { makeOpenCodeV2Adapter } from "./OpenCodeV2Adapter.ts";

class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapterDispatcher.test/OpenCodeAdapter",
) {}

interface ActiveSessionReadBarrier {
  readonly entered: Promise<void>;
  readonly released: Promise<void>;
  readonly markEntered: () => void;
  readonly release: () => void;
}

interface ScheduledReadBarrier {
  remainingReads: number;
  readonly barrier: ActiveSessionReadBarrier;
}

const makeActiveSessionReadBarrier = (): ActiveSessionReadBarrier => {
  let markEntered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => (markEntered = resolve)),
    released: new Promise<void>((resolve) => (release = resolve)),
    markEntered: () => markEntered(),
    release: () => release(),
  };
};

const waitForScheduledReadBarrier = async (barriers: Array<ScheduledReadBarrier>) => {
  const scheduled = barriers[0];
  if (!scheduled) return;
  if (scheduled.remainingReads > 0) {
    scheduled.remainingReads -= 1;
    return;
  }
  barriers.shift();
  scheduled.barrier.markEntered();
  await scheduled.barrier.released;
};

function observeEvents(
  adapter: OpenCodeAdapterShape,
  threadId: ThreadId,
  recordedEvents: Array<ProviderRuntimeEvent> = [],
) {
  return Effect.gen(function* () {
    const observed = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.threadId !== threadId) return;
          recordedEvents.push(event);
          yield* Queue.offer(observed, event);
        }),
      ),
      Effect.forkScoped,
    );
    return (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(observed);
          if (predicate(event)) return event;
        }
      });
  });
}

const makeV1EventStream = (signal?: AbortSignal): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]() {
    let first = true;
    let closed = false;
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
    const finish = () => {
      closed = true;
      resolveNext?.({ done: true, value: undefined });
    };
    signal?.addEventListener("abort", finish, { once: true });

    return {
      next() {
        if (first) {
          first = false;
          return Promise.resolve({
            done: false,
            value: { id: "event-server-connected-v1", type: "server.connected", properties: {} },
          });
        }
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return() {
        finish();
        signal?.removeEventListener("abort", finish);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});

const runtimeMock = {
  state: {
    connectCalls: [] as Array<{ url: string | null | undefined; directory: string }>,
    serverProtocol: "v2" as "v1" | "v2",
    serverVersion: "2.0.18",
    v2ClientInputs: [] as Array<{ baseUrl: string; serverPassword?: string }>,
    v1ClientInputs: [] as Array<{ baseUrl: string; serverPassword?: string }>,
    v1SessionCreateUrls: [] as string[],
    v1PromptInputs: [] as Array<Record<string, unknown>>,
    promptInputs: [] as Array<Record<string, unknown>>,
    switchedModels: [] as Array<Record<string, unknown>>,
    createdSessions: 0,
    scenario: "success" as
      | "success"
      | "permission"
      | "form"
      | "interrupt"
      | "recovery"
      | "externalPending",
    failNativeStop: false,
    idleInterruptReturnsFalse: false,
    failActiveSessionRead: false,
    localExitCount: 0,
    permissionReplies: [] as Array<Record<string, unknown>>,
    formReplies: [] as Array<Record<string, unknown>>,
    interruptCalls: [] as Array<Record<string, unknown>>,
    activeSessions: new Set<string>(),
    pendingPermissions: [] as Array<{
      id: string;
      sessionID: string;
      action: string;
      resources: string[];
      message: string;
    }>,
    pendingForms: [] as Array<{ id: string; detail: Record<string, unknown> }>,
    permissionListBarriers: [] as Array<ScheduledReadBarrier>,
    formListBarriers: [] as Array<ScheduledReadBarrier>,
    formGetBarriers: [] as Array<ScheduledReadBarrier>,
    activeSessionReadCount: 0,
    activeSessionReadBarriers: [] as ActiveSessionReadBarrier[],
    nativeWorkRevalidators: [] as Array<{ ownerId: string; revalidate: Effect.Effect<void> }>,
    eventSubscriptions: 0,
    subscriptionWaiters: [] as Array<() => void>,
    failNextPrompt: false,
    failEventStream: (_cause: unknown) => {},
    sendNativeEvent: (_event: unknown) => {},
    settleTurn: () => {},
    nextEventSubscription() {
      return new Promise<void>((resolve) => this.subscriptionWaiters.push(resolve));
    },
  },
  reset() {
    this.state.connectCalls.length = 0;
    this.state.serverProtocol = "v2";
    this.state.serverVersion = "2.0.18";
    this.state.v2ClientInputs.length = 0;
    this.state.v1ClientInputs.length = 0;
    this.state.v1SessionCreateUrls.length = 0;
    this.state.v1PromptInputs.length = 0;
    this.state.promptInputs.length = 0;
    this.state.switchedModels.length = 0;
    this.state.createdSessions = 0;
    this.state.scenario = "success";
    this.state.failNativeStop = false;
    this.state.idleInterruptReturnsFalse = false;
    this.state.failActiveSessionRead = false;
    this.state.localExitCount = 0;
    this.state.permissionReplies.length = 0;
    this.state.formReplies.length = 0;
    this.state.interruptCalls.length = 0;
    this.state.activeSessions.clear();
    this.state.pendingPermissions.length = 0;
    this.state.pendingForms.length = 0;
    this.state.permissionListBarriers.length = 0;
    this.state.formListBarriers.length = 0;
    this.state.formGetBarriers.length = 0;
    this.state.activeSessionReadCount = 0;
    this.state.activeSessionReadBarriers.length = 0;
    this.state.nativeWorkRevalidators.length = 0;
    this.state.eventSubscriptions = 0;
    this.state.subscriptionWaiters.length = 0;
    this.state.failNextPrompt = false;
    this.state.failEventStream = () => {};
    this.state.sendNativeEvent = () => {};
    this.state.settleTurn = () => {};
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die(new Error("not used")),
  connectToOpenCodeServer: (input) =>
    Effect.gen(function* () {
      runtimeMock.state.connectCalls.push({ url: input.serverUrl, directory: input.directory });
      const external = Boolean(input.serverUrl);
      if (external) {
        return {
          url: input.serverUrl || "http://127.0.0.1:4301",
          ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
          version: runtimeMock.state.serverVersion,
          protocol: runtimeMock.state.serverProtocol,
          exitCode: null,
          external,
        };
      }
      const exited = yield* Deferred.make<number>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => (runtimeMock.state.localExitCount += 1)).pipe(
          Effect.andThen(Deferred.succeed(exited, 137)),
        ),
      );
      return {
        url: input.serverUrl || "http://127.0.0.1:4301",
        ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
        version: runtimeMock.state.serverVersion,
        protocol: runtimeMock.state.serverProtocol,
        exitCode: Deferred.await(exited),
        external,
      };
    }),
  runOpenCodeCommand: () => Effect.die(new Error("not used")),
  createOpenCodeSdkClient: (input) => {
    if (runtimeMock.state.serverProtocol !== "v1") {
      throw new Error("V1 client must not be selected for a V2 server");
    }
    runtimeMock.state.v1ClientInputs.push({
      baseUrl: input.baseUrl,
      ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
    });
    const client = {
      event: {
        subscribe: async (_input: unknown, options?: { signal?: AbortSignal }) => ({
          stream: makeV1EventStream(options?.signal),
        }),
      },
      session: {
        create: async () => {
          runtimeMock.state.v1SessionCreateUrls.push(input.baseUrl);
          runtimeMock.state.createdSessions += 1;
          return { data: { id: "session-v1", directory: process.cwd() } };
        },
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        message: async ({ messageID }: { sessionID: string; messageID: string }) => ({
          data: { info: { id: messageID, role: "user" }, parts: [] },
        }),
        promptAsync: async (value: Record<string, unknown>) => {
          runtimeMock.state.v1PromptInputs.push(value);
        },
        abort: async () => ({}),
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    };
    return client as never;
  },
  createOpenCodeV2Client: (input) => {
    if (runtimeMock.state.serverProtocol !== "v2") {
      throw new Error("V2 client must not be selected for a V1 server");
    }
    runtimeMock.state.v2ClientInputs.push({
      baseUrl: input.baseUrl,
      ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
    });
    let releasePrompt!: () => void;
    let releaseTurnSettled!: () => void;
    let releaseFormReply!: () => void;
    let releaseInterrupt!: () => void;
    const permissionReplyReleases: Array<() => void> = [];
    const promptStarted = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const turnSettled = new Promise<void>((resolve) => {
      releaseTurnSettled = resolve;
    });
    const formReplyReceived = new Promise<void>((resolve) => {
      releaseFormReply = resolve;
    });
    const interruptReceived = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    runtimeMock.state.settleTurn = releaseTurnSettled;
    const client = {
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => {
          let failTransport!: (cause: unknown) => void;
          const transportFailure = new Promise<never>((_, reject) => {
            failTransport = reject;
          });
          runtimeMock.state.failEventStream = (cause) => failTransport(cause);
          let releaseAbort!: () => void;
          const aborted = new Promise<void>((resolve) => {
            releaseAbort = resolve;
          });
          if (signal.aborted) releaseAbort();
          else signal.addEventListener("abort", releaseAbort, { once: true });
          const injectedEvents: unknown[] = [];
          let releaseInjectedEvent: ((event: unknown | undefined) => void) | undefined;
          const nextInjectedEvent = () => {
            const event = injectedEvents.shift();
            if (event !== undefined) return Promise.resolve(event);
            return new Promise<unknown | undefined>((resolve) => {
              releaseInjectedEvent = resolve;
            });
          };
          runtimeMock.state.sendNativeEvent = (event) => {
            const release = releaseInjectedEvent;
            if (release) {
              releaseInjectedEvent = undefined;
              release(event);
            } else {
              injectedEvents.push(event);
            }
          };
          const stream = (async function* () {
            if (runtimeMock.state.scenario === "recovery") {
              await Promise.race([aborted, transportFailure]);
              return;
            }
            if (runtimeMock.state.scenario === "externalPending") {
              while (true) {
                const event = await Promise.race([nextInjectedEvent(), aborted, transportFailure]);
                if (event === undefined) return;
                yield event;
              }
            }
            await promptStarted;
            if (runtimeMock.state.scenario === "permission") {
              for (const [index, id] of ["permission-v2-allow", "permission-v2-deny"].entries()) {
                const replyReceived = new Promise<void>((resolve) => {
                  permissionReplyReleases.push(resolve);
                });
                yield {
                  id: `event-permission-asked-${index}`,
                  created: index + 1,
                  type: "permission.asked",
                  data: {
                    id,
                    sessionID: "session-v2",
                    action: "bash",
                    resources: ["echo test"],
                    message: "Allow this command?",
                  },
                };
                await replyReceived;
                yield {
                  id: `event-permission-replied-${index}`,
                  created: index + 3,
                  type: "permission.replied",
                  data: {
                    sessionID: "session-v2",
                    requestID: id,
                    reply: index === 0 ? "always" : "reject",
                  },
                };
              }
            } else if (runtimeMock.state.scenario === "form") {
              yield {
                id: "event-form-created",
                created: 1,
                type: "form.created",
                data: {
                  form: {
                    id: "form-v2",
                    sessionID: "session-v2",
                    title: "Choose settings",
                    fields: [
                      {
                        key: "mode",
                        title: "Mode",
                        type: "string",
                        options: [{ label: "Quick", value: "fast" }],
                        custom: true,
                      },
                      { key: "count", title: "Count", type: "integer" },
                    ],
                  },
                },
              };
              await formReplyReceived;
              const reply = runtimeMock.state.formReplies[0];
              yield {
                id: "event-form-replied",
                created: 2,
                type: "form.replied",
                data: {
                  id: "form-v2",
                  sessionID: "session-v2",
                  answer: reply?.answer,
                },
              };
            } else if (runtimeMock.state.scenario === "interrupt") {
              await interruptReceived;
              yield {
                id: "event-execution-interrupted",
                created: 1,
                type: "session.execution.interrupted",
                durable: { aggregateID: "session-v2", seq: 1, version: 1 },
                data: { sessionID: "session-v2", reason: "user" },
              };
              releaseTurnSettled();
              runtimeMock.state.activeSessions.delete("session-v2");
              await aborted;
              return;
            } else {
              yield {
                id: "event-text-delta",
                created: 1,
                type: "session.text.delta",
                durable: { aggregateID: "session-v2", seq: 1, version: 2 },
                data: {
                  sessionID: "session-v2",
                  assistantMessageID: "assistant-v2",
                  delta: "V2 streamed answer",
                  ordinal: 0,
                },
              };
            }
            yield {
              id: "event-execution-succeeded",
              created: 10,
              type: "session.execution.succeeded",
              durable: { aggregateID: "session-v2", seq: 2, version: 1 },
              data: { sessionID: "session-v2" },
            };
            releaseTurnSettled();
            await aborted;
          })();
          return {
            [Symbol.asyncIterator]() {
              runtimeMock.state.eventSubscriptions += 1;
              runtimeMock.state.subscriptionWaiters.shift()?.();
              const iterator = stream[Symbol.asyncIterator]();
              let returned = false;
              return {
                next: () => iterator.next(),
                return: () => {
                  if (!returned) {
                    returned = true;
                    releaseAbort();
                    releaseInjectedEvent?.(undefined);
                    releaseInjectedEvent = undefined;
                    signal.removeEventListener("abort", releaseAbort);
                  }
                  return iterator.return
                    ? iterator.return()
                    : Promise.resolve({ done: true, value: undefined });
                },
              };
            },
          };
        },
      },
      agent: {
        list: async () => ({
          data: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
        }),
      },
      session: {
        create: async () => {
          runtimeMock.state.createdSessions += 1;
          return { id: "session-v2", location: { directory: process.cwd() } };
        },
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          location: { directory: process.cwd() },
        }),
        update: async () => ({}),
        switchModel: async (value: Record<string, unknown>) => {
          runtimeMock.state.switchedModels.push(value);
          return {};
        },
        switchAgent: async () => ({}),
        prompt: async (value: Record<string, unknown>) => {
          runtimeMock.state.promptInputs.push(value);
          if (runtimeMock.state.failNextPrompt) {
            runtimeMock.state.failNextPrompt = false;
            throw new Error("steering submission rejected");
          }
          runtimeMock.state.activeSessions.add("session-v2");
          releasePrompt();
          return {};
        },
        wait: async () => {
          await turnSettled;
          runtimeMock.state.activeSessions.delete("session-v2");
          return {};
        },
        interrupt: async (value: Record<string, unknown>) => {
          if (runtimeMock.state.failNativeStop) {
            throw new Error("native stop did not confirm termination");
          }
          if (
            runtimeMock.state.idleInterruptReturnsFalse &&
            !runtimeMock.state.activeSessions.has("session-v2")
          ) {
            return { interrupted: false };
          }
          runtimeMock.state.interruptCalls.push(value);
          releaseInterrupt();
          runtimeMock.state.activeSessions.delete("session-v2");
          runtimeMock.state.settleTurn();
          return { interrupted: true };
        },
        active: async () => {
          if (runtimeMock.state.failActiveSessionRead) {
            throw new Error("native active read unavailable");
          }
          runtimeMock.state.activeSessionReadCount += 1;
          const activeSessions = Object.fromEntries(
            [...runtimeMock.state.activeSessions].map((sessionID) => [
              sessionID,
              { type: "running" },
            ]),
          );
          const barrier = runtimeMock.state.activeSessionReadBarriers.shift();
          if (barrier) {
            barrier.markEntered();
            await barrier.released;
          }
          return activeSessions;
        },
        form: {
          list: async () => {
            const forms = runtimeMock.state.pendingForms.map(({ id }) => ({ id }));
            await waitForScheduledReadBarrier(runtimeMock.state.formListBarriers);
            return forms;
          },
          get: async ({ formID }: { sessionID: string; formID: string }) => {
            const detail =
              runtimeMock.state.pendingForms.find((form) => form.id === formID)?.detail ?? {};
            await waitForScheduledReadBarrier(runtimeMock.state.formGetBarriers);
            return detail;
          },
          reply: async (value: Record<string, unknown>) => {
            runtimeMock.state.formReplies.push(value);
            runtimeMock.state.pendingForms = runtimeMock.state.pendingForms.filter(
              (form) => form.id !== value.formID,
            );
            releaseFormReply();
            return {};
          },
        },
      },
      permission: {
        request: {
          list: async () => {
            const data = [...runtimeMock.state.pendingPermissions];
            await waitForScheduledReadBarrier(runtimeMock.state.permissionListBarriers);
            return { data };
          },
        },
        reply: async (value: Record<string, unknown>) => {
          runtimeMock.state.permissionReplies.push(value);
          runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions.filter(
            (request) => request.id !== value.requestID,
          );
          permissionReplyReleases.shift()?.();
          return {};
        },
      },
      message: {
        list: async () => ({
          data: [
            {
              id: "assistant-v2",
              type: "assistant",
              content: [{ type: "text", text: "V2 final answer" }],
            },
          ],
        }),
      },
    };
    return client as never;
  },
  loadOpenCodeInventory: () => Effect.die(new Error("not used")),
  loadOpenCodeV2Inventory: () => Effect.die(new Error("not used")),
  loadInventoryFromCli: () => Effect.die(new Error("not used")),
};

const makeOpenCodeAdapterTestLayer = (settings: OpenCodeSettings) =>
  Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const workGuard = yield* OpenCodeWorkGuard;
      const adapterWorkGuard: OpenCodeWorkGuardModule.OpenCodeWorkGuardShape = {
        ...workGuard,
        registerNativeWorkRevalidator: (threadId, ownerId, revalidate) => {
          runtimeMock.state.nativeWorkRevalidators.push({ ownerId, revalidate });
          return workGuard.registerNativeWorkRevalidator(threadId, ownerId, revalidate);
        },
      };
      return yield* makeOpenCodeAdapter(settings, { workGuard: adapterWorkGuard });
    }),
  ).pipe(
    Layer.provideMerge(OpenCodeWorkGuardModule.layer),
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );

const OpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer(
  Schema.decodeSync(OpenCodeSettings)({
    binaryPath: "fake-opencode",
    serverUrl: "http://127.0.0.1:9999",
    serverPassword: "server-secret",
  }),
);
const LocalOpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer(
  Schema.decodeSync(OpenCodeSettings)({
    binaryPath: "fake-opencode",
    serverUrl: "",
    serverPassword: "server-secret",
  }),
);
const V1ExternalOpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer(
  Schema.decodeSync(OpenCodeSettings)({
    binaryPath: "fake-opencode",
    serverUrl: "http://127.0.0.1:9999",
    serverPassword: "server-secret",
  }),
);
const V1LocalOpenCodeAdapterTestLayer = makeOpenCodeAdapterTestLayer(
  Schema.decodeSync(OpenCodeSettings)({
    binaryPath: "fake-opencode",
    serverUrl: "",
    serverPassword: "server-secret",
  }),
);
const OpenCodeAccountRaceSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "server-secret",
});

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterDispatcher", (it) => {
  it.effect("dispatches a V2 session and turn through the V2 client API", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-v2-dispatch");
      const instanceId = ProviderInstanceId.make("opencode");
      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Say hello",
        modelSelection: { instanceId, model: "openai/gpt-5" },
      });
      const contentEvent = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta"),
        Stream.runHead,
      );

      NodeAssert.equal(
        session.resumeCursor && (session.resumeCursor as { schemaVersion: number }).schemaVersion,
        2,
      );
      NodeAssert.equal(runtimeMock.state.connectCalls.length, 1);
      NodeAssert.deepEqual(runtimeMock.state.v1ClientInputs, []);
      NodeAssert.deepEqual(runtimeMock.state.v2ClientInputs, [
        { baseUrl: "http://127.0.0.1:9999", serverPassword: "server-secret" },
      ]);
      NodeAssert.equal(runtimeMock.state.createdSessions, 1);
      NodeAssert.equal(runtimeMock.state.promptInputs[0]?.text, "Say hello");
      NodeAssert.deepEqual(runtimeMock.state.switchedModels[0]?.model, {
        id: "gpt-5",
        providerID: "openai",
      });
      NodeAssert.equal(Option.isSome(contentEvent), true);
      if (Option.isSome(contentEvent)) {
        NodeAssert.deepEqual(contentEvent.value.payload, {
          streamKind: "assistant_text",
          delta: "V2 streamed answer",
          contentIndex: 0,
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "keeps the route lease through failed steering and recovers before admitting the next turn",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "recovery";
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-route-recovery");
        const instanceId = ProviderInstanceId.make("opencode");
        const nextEvent = yield* observeEvents(adapter, threadId);
        const firstSubscription = runtimeMock.state.nextEventSubscription();
        const original = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* Effect.promise(() => firstSubscription);

        const turnInput = {
          threadId,
          input: "Start a turn",
          modelSelection: { instanceId, model: "openai/gpt-5" },
        };
        yield* adapter.sendTurn(turnInput);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.failNextPrompt = true;
        const steering = yield* Effect.result(
          adapter.sendTurn({ ...turnInput, input: "Steer the active turn" }),
        );
        NodeAssert.equal(steering._tag, "Failure");
        const steeringError = yield* nextEvent((event) => event.type === "runtime.error");
        NodeAssert.equal(steeringError.type, "runtime.error");
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.activeSessions.delete("session-v2");
        runtimeMock.state.failEventStream(new Error("event transport disconnected"));
        const streamError = yield* nextEvent((event) => event.type === "runtime.error");
        NodeAssert.equal(streamError.type, "runtime.error");
        NodeAssert.equal(yield* workGuard.isBusy, true);

        const resumedSubscription = runtimeMock.state.nextEventSubscription();
        const resumed = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: original.resumeCursor,
        });
        yield* Effect.promise(() => resumedSubscription);
        NodeAssert.deepEqual(resumed.resumeCursor, original.resumeCursor);
        NodeAssert.equal(resumed.runtimeMode, "approval-required");
        NodeAssert.equal(runtimeMock.state.createdSessions, 1);
        const recoveredCompletion = yield* nextEvent((event) => event.type === "turn.completed");
        NodeAssert.equal(recoveredCompletion.type, "turn.completed");
        if (recoveredCompletion.type === "turn.completed") {
          NodeAssert.deepEqual(recoveredCompletion.payload, { state: "completed" });
        }
        NodeAssert.equal(yield* workGuard.isBusy, false);

        yield* adapter.sendTurn({ ...turnInput, input: "Continue after recovery" });
        NodeAssert.equal(runtimeMock.state.promptInputs.length, 3);
        NodeAssert.equal(yield* workGuard.isBusy, true);
        yield* adapter.stopSession(threadId);
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );

  it.effect("keeps live permission and form requests through stale recovery snapshots", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "externalPending";
      const adapter = yield* OpenCodeAdapter;
      const workGuard = yield* OpenCodeWorkGuard;
      const threadId = ThreadId.make("thread-opencode-v2-stale-empty-recovery");
      const recordedEvents: Array<ProviderRuntimeEvent> = [];
      const nextEvent = yield* observeEvents(adapter, threadId, recordedEvents);
      const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
      const firstSubscription = runtimeMock.state.nextEventSubscription();
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: savedCursor,
      });
      yield* Effect.promise(() => firstSubscription);

      runtimeMock.state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");

      const permissionSnapshot = makeActiveSessionReadBarrier();
      const formSnapshot = makeActiveSessionReadBarrier();
      runtimeMock.state.permissionListBarriers.push({
        remainingReads: 1,
        barrier: permissionSnapshot,
      });
      runtimeMock.state.formListBarriers.push({ remainingReads: 1, barrier: formSnapshot });
      const resumedSubscription = runtimeMock.state.nextEventSubscription();
      const recovery = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => resumedSubscription);
      yield* Effect.promise(() => permissionSnapshot.entered);

      const permissionRequest = {
        id: "permission-live-during-recovery",
        sessionID: "session-v2",
        action: "bash",
        resources: ["echo recovered"],
        message: "Allow the recovered command?",
      };
      runtimeMock.state.pendingPermissions = [permissionRequest];
      runtimeMock.state.sendNativeEvent({
        id: "event-live-permission-during-recovery",
        created: 60,
        type: "permission.asked",
        data: permissionRequest,
      });
      yield* nextEvent(
        (event) => event.type === "request.opened" && event.requestId === permissionRequest.id,
      );
      permissionSnapshot.release();

      yield* Effect.promise(() => formSnapshot.entered);
      const form = {
        id: "form-live-during-recovery",
        sessionID: "session-v2",
        title: "Recovered answer",
        fields: [{ key: "answer", title: "Answer", type: "string" }],
      };
      runtimeMock.state.pendingForms = [
        { id: form.id, detail: { ...form, state: { status: "pending" } } },
      ];
      runtimeMock.state.sendNativeEvent({
        id: "event-live-form-during-recovery",
        created: 61,
        type: "form.created",
        data: { form },
      });
      yield* nextEvent(
        (event) => event.type === "user-input.requested" && event.requestId === form.id,
      );
      NodeAssert.equal(yield* workGuard.isBusy, true);
      formSnapshot.release();
      const recovered = yield* Fiber.join(recovery);
      NodeAssert.equal(recovered.status, "running");

      const recoveryBarrier = "stale empty recovery snapshot finished";
      runtimeMock.state.sendNativeEvent({
        id: "event-stale-empty-recovery-barrier",
        created: 62,
        type: "session.retry.scheduled",
        data: { sessionID: "session-v2", error: { message: recoveryBarrier } },
      });
      yield* nextEvent(
        (event) => event.type === "runtime.warning" && event.payload.detail === recoveryBarrier,
      );
      NodeAssert.equal(
        recordedEvents.some(
          (event) =>
            (event.type === "request.resolved" && event.requestId === permissionRequest.id) ||
            (event.type === "user-input.resolved" && event.requestId === form.id),
        ),
        false,
      );
      NodeAssert.equal(yield* workGuard.isBusy, true);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(permissionRequest.id),
        "acceptForSession",
      );
      yield* nextEvent(
        (event) => event.type === "request.resolved" && event.requestId === permissionRequest.id,
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplies, [
        {
          sessionID: "session-v2",
          requestID: permissionRequest.id,
          decision: "always",
        },
      ]);
      NodeAssert.equal(yield* workGuard.isBusy, true);

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(form.id), {
        "question-0-answer": "accepted",
      });
      yield* nextEvent(
        (event) => event.type === "user-input.resolved" && event.requestId === form.id,
      );
      NodeAssert.deepEqual(runtimeMock.state.formReplies, [
        {
          sessionID: "session-v2",
          formID: form.id,
          answer: { answer: "accepted" },
        },
      ]);
      NodeAssert.equal(yield* workGuard.isBusy, false);
    }),
  );

  it.effect(
    "does not resurrect terminal permission or form requests from stale positive snapshots",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "externalPending";
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-stale-positive-recovery");
        const recordedEvents: Array<ProviderRuntimeEvent> = [];
        const nextEvent = yield* observeEvents(adapter, threadId, recordedEvents);
        const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
        const permissionRequest = {
          id: "permission-terminal-during-recovery",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo terminal"],
          message: "Allow this command?",
        };
        const form = {
          id: "form-terminal-during-recovery",
          sessionID: "session-v2",
          title: "Cancel during recovery",
          fields: [{ key: "answer", title: "Answer", type: "string" }],
        };
        runtimeMock.state.pendingPermissions = [permissionRequest];
        runtimeMock.state.pendingForms = [
          { id: form.id, detail: { ...form, state: { status: "pending" } } },
        ];
        const firstSubscription = runtimeMock.state.nextEventSubscription();
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        });
        yield* Effect.promise(() => firstSubscription);
        yield* nextEvent(
          (event) => event.type === "request.opened" && event.requestId === permissionRequest.id,
        );
        yield* nextEvent(
          (event) => event.type === "user-input.requested" && event.requestId === form.id,
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.failEventStream(new Error("event transport disconnected"));
        yield* nextEvent((event) => event.type === "runtime.error");

        const permissionSnapshot = makeActiveSessionReadBarrier();
        const formDetailSnapshot = makeActiveSessionReadBarrier();
        runtimeMock.state.permissionListBarriers.push({
          remainingReads: 1,
          barrier: permissionSnapshot,
        });
        runtimeMock.state.formGetBarriers.push({ remainingReads: 0, barrier: formDetailSnapshot });
        const resumedSubscription = runtimeMock.state.nextEventSubscription();
        const recovery = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("opencode"),
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: savedCursor,
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => resumedSubscription);
        yield* Effect.promise(() => permissionSnapshot.entered);

        runtimeMock.state.pendingPermissions = [];
        runtimeMock.state.sendNativeEvent({
          id: "event-permission-replied-during-recovery",
          created: 70,
          type: "permission.replied",
          data: {
            sessionID: "session-v2",
            requestID: permissionRequest.id,
            reply: "always",
          },
        });
        yield* nextEvent(
          (event) => event.type === "request.resolved" && event.requestId === permissionRequest.id,
        );
        const permissionBarrier = "permission terminal idle proof finished";
        runtimeMock.state.sendNativeEvent({
          id: "event-permission-idle-proof-barrier",
          created: 71,
          type: "session.retry.scheduled",
          data: { sessionID: "session-v2", error: { message: permissionBarrier } },
        });
        yield* nextEvent(
          (event) => event.type === "runtime.warning" && event.payload.detail === permissionBarrier,
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);
        permissionSnapshot.release();

        yield* Effect.promise(() => formDetailSnapshot.entered);
        runtimeMock.state.pendingForms = [];
        runtimeMock.state.sendNativeEvent({
          id: "event-form-cancelled-during-recovery",
          created: 72,
          type: "form.cancelled",
          data: { id: form.id, sessionID: "session-v2" },
        });
        yield* nextEvent(
          (event) => event.type === "user-input.resolved" && event.requestId === form.id,
        );
        const cancellationBarrier = "form cancellation idle proof finished";
        runtimeMock.state.sendNativeEvent({
          id: "event-form-cancel-idle-proof-barrier",
          created: 73,
          type: "session.retry.scheduled",
          data: { sessionID: "session-v2", error: { message: cancellationBarrier } },
        });
        yield* nextEvent(
          (event) =>
            event.type === "runtime.warning" && event.payload.detail === cancellationBarrier,
        );
        NodeAssert.equal(yield* workGuard.isBusy, false);

        formDetailSnapshot.release();
        const recovered = yield* Fiber.join(recovery);
        const recoveryBarrier = "stale positive recovery snapshot finished";
        runtimeMock.state.sendNativeEvent({
          id: "event-stale-positive-recovery-barrier",
          created: 74,
          type: "session.retry.scheduled",
          data: { sessionID: "session-v2", error: { message: recoveryBarrier } },
        });
        yield* nextEvent(
          (event) => event.type === "runtime.warning" && event.payload.detail === recoveryBarrier,
        );
        NodeAssert.equal(
          recordedEvents.filter(
            (event) => event.type === "request.opened" && event.requestId === permissionRequest.id,
          ).length,
          1,
        );
        NodeAssert.equal(
          recordedEvents.filter(
            (event) => event.type === "user-input.requested" && event.requestId === form.id,
          ).length,
          1,
        );
        NodeAssert.equal(recovered.status, "ready");
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );

  it.effect(
    "does not reopen terminal requests from the first saved-session resume snapshots",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "externalPending";
        const workGuard = yield* OpenCodeWorkGuard;
        const adapter = yield* makeOpenCodeV2Adapter(
          Schema.decodeSync(OpenCodeSettings)({
            binaryPath: "fake-opencode",
            serverUrl: "http://127.0.0.1:9999",
            serverPassword: "server-secret",
          }),
          { workGuard },
        );
        yield* Effect.addFinalizer(() =>
          adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
        );
        const threadId = ThreadId.make("thread-opencode-v2-cold-resume-terminal-snapshots");
        const recordedEvents: Array<ProviderRuntimeEvent> = [];
        const nextEvent = yield* observeEvents(adapter, threadId, recordedEvents);
        const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
        const permissionRequest = {
          id: "permission-terminal-on-first-resume",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo first resume"],
          message: "Allow this command?",
        };
        const form = {
          id: "form-terminal-on-first-resume",
          sessionID: "session-v2",
          title: "Cancel on first resume",
          fields: [{ key: "answer", title: "Answer", type: "string" }],
        };
        runtimeMock.state.pendingPermissions = [permissionRequest];
        runtimeMock.state.pendingForms = [
          { id: form.id, detail: { ...form, state: { status: "pending" } } },
        ];
        const permissionSnapshot = makeActiveSessionReadBarrier();
        const formDetailSnapshot = makeActiveSessionReadBarrier();
        runtimeMock.state.permissionListBarriers.push({
          remainingReads: 0,
          barrier: permissionSnapshot,
        });
        runtimeMock.state.formGetBarriers.push({ remainingReads: 0, barrier: formDetailSnapshot });

        const subscription = runtimeMock.state.nextEventSubscription();
        const resume = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("opencode"),
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: savedCursor,
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => subscription);
        yield* Effect.promise(() => permissionSnapshot.entered);

        runtimeMock.state.sendNativeEvent({
          id: "event-first-resume-permission-asked",
          created: 80,
          type: "permission.asked",
          data: permissionRequest,
        });
        yield* nextEvent(
          (event) => event.type === "request.opened" && event.requestId === permissionRequest.id,
        );
        runtimeMock.state.pendingPermissions = [];
        runtimeMock.state.sendNativeEvent({
          id: "event-first-resume-permission-replied",
          created: 81,
          type: "permission.replied",
          data: {
            sessionID: "session-v2",
            requestID: permissionRequest.id,
            reply: "always",
          },
        });
        yield* nextEvent(
          (event) => event.type === "request.resolved" && event.requestId === permissionRequest.id,
        );
        permissionSnapshot.release();

        yield* Effect.promise(() => formDetailSnapshot.entered);
        runtimeMock.state.sendNativeEvent({
          id: "event-first-resume-form-created",
          created: 82,
          type: "form.created",
          data: { form },
        });
        yield* nextEvent(
          (event) => event.type === "user-input.requested" && event.requestId === form.id,
        );
        runtimeMock.state.pendingForms = [];
        runtimeMock.state.sendNativeEvent({
          id: "event-first-resume-form-cancelled",
          created: 83,
          type: "form.cancelled",
          data: { id: form.id, sessionID: "session-v2" },
        });
        yield* nextEvent(
          (event) => event.type === "user-input.resolved" && event.requestId === form.id,
        );
        formDetailSnapshot.release();
        const resumed = yield* Fiber.join(resume);

        const recoveryBarrier = "first-resume snapshots finished";
        runtimeMock.state.sendNativeEvent({
          id: "event-first-resume-snapshot-barrier",
          created: 84,
          type: "session.retry.scheduled",
          data: { sessionID: "session-v2", error: { message: recoveryBarrier } },
        });
        yield* nextEvent(
          (event) => event.type === "runtime.warning" && event.payload.detail === recoveryBarrier,
        );
        NodeAssert.equal(
          recordedEvents.filter(
            (event) =>
              event.type === "request.opened" && event.requestId === permissionRequest.id,
          ).length,
          1,
        );
        NodeAssert.equal(
          recordedEvents.filter(
            (event) => event.type === "user-input.requested" && event.requestId === form.id,
          ).length,
          1,
        );
        const permissionResolution = recordedEvents.find(
          (event) => event.type === "request.resolved" && event.requestId === permissionRequest.id,
        );
        NodeAssert.equal(permissionResolution?.type, "request.resolved");
        if (permissionResolution?.type === "request.resolved") {
          NodeAssert.equal(permissionResolution.payload.decision, "always");
        }
        NodeAssert.equal(
          recordedEvents.filter(
            (event) => event.type === "user-input.resolved" && event.requestId === form.id,
          ).length,
          1,
        );
        NodeAssert.equal(resumed.status, "ready");
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );

  it.effect("releases disconnected stale pending work without requiring stopSession", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "externalPending";
      runtimeMock.state.pendingPermissions = [
        {
          id: "permission-stale-without-stop",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo stale"],
          message: "Allow this command?",
        },
      ];
      const workGuard = yield* OpenCodeWorkGuard;
      const adapter = yield* makeOpenCodeV2Adapter(
        Schema.decodeSync(OpenCodeSettings)({
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "server-secret",
        }),
        { workGuard },
      );
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-stale-without-stop");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const subscription = runtimeMock.state.nextEventSubscription();
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 2, sessionId: "session-v2" },
      });
      yield* Effect.promise(() => subscription);
      yield* nextEvent(
        (event) => event.type === "request.opened" && event.requestId === "permission-stale-without-stop",
      );
      NodeAssert.equal(yield* workGuard.isBusy, true);

      runtimeMock.state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");
      runtimeMock.state.pendingPermissions = [];
      yield* workGuard.revalidateNativeContexts;
      NodeAssert.equal(yield* workGuard.isBusy, false);
    }),
  );

  it.effect(
    "stops an external session after reconciliation clears stale requests without releasing a sibling owner",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "externalPending";
        runtimeMock.state.idleInterruptReturnsFalse = true;
        runtimeMock.state.pendingPermissions = [
          {
            id: "permission-stale-before-external-stop",
            sessionID: "session-v2",
            action: "bash",
            resources: ["echo stale"],
            message: "Allow this command?",
          },
        ];
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-external-stop-stale-request");
        const nextEvent = yield* observeEvents(adapter, threadId);
        const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
        const subscription = runtimeMock.state.nextEventSubscription();
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        });
        yield* Effect.promise(() => subscription);
        yield* nextEvent(
          (event) =>
            event.type === "request.opened" &&
            event.requestId === "permission-stale-before-external-stop",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.failEventStream(new Error("event transport disconnected"));
        yield* nextEvent((event) => event.type === "runtime.error");
        runtimeMock.state.pendingPermissions = [];
        const siblingThreadId = ThreadId.make("thread-opencode-v2-external-stop-sibling");
        const siblingOwnerId = "sibling-owner";
        yield* workGuard.beginTurn(siblingThreadId, siblingOwnerId);

        const stopResult = yield* Effect.result(adapter.stopSession(threadId));
        NodeAssert.equal(stopResult._tag, "Success");
        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
        NodeAssert.equal(yield* workGuard.isBusy, true);
        yield* workGuard.endThread(siblingThreadId, siblingOwnerId);
        NodeAssert.equal(yield* workGuard.isBusy, false);
        NodeAssert.deepEqual(runtimeMock.state.interruptCalls, []);
      }),
  );

  it.effect("keeps a new native request busy when it arrives during external-stop reconciliation", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "externalPending";
      runtimeMock.state.idleInterruptReturnsFalse = true;
      runtimeMock.state.pendingPermissions = [
        {
          id: "permission-stale-during-stop-reconciliation",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo stale"],
          message: "Allow this command?",
        },
      ];
      const adapter = yield* OpenCodeAdapter;
      const workGuard = yield* OpenCodeWorkGuard;
      const threadId = ThreadId.make("thread-opencode-v2-stop-new-native-request");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const subscription = runtimeMock.state.nextEventSubscription();
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 2, sessionId: "session-v2" },
      });
      yield* Effect.promise(() => subscription);
      yield* nextEvent(
        (event) =>
          event.type === "request.opened" &&
          event.requestId === "permission-stale-during-stop-reconciliation",
      );
      runtimeMock.state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");
      runtimeMock.state.pendingPermissions = [];

      const permissionSnapshot = makeActiveSessionReadBarrier();
      runtimeMock.state.permissionListBarriers.push({ remainingReads: 0, barrier: permissionSnapshot });
      const stopping = yield* Effect.result(adapter.stopSession(threadId)).pipe(Effect.forkChild);
      yield* Effect.promise(() => permissionSnapshot.entered);
      runtimeMock.state.pendingPermissions = [
        {
          id: "permission-new-during-stop-reconciliation",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo new"],
          message: "Allow the new command?",
        },
      ];
      permissionSnapshot.release();

      const stopResult = yield* Fiber.join(stopping);
      NodeAssert.equal(stopResult._tag, "Failure");
      NodeAssert.equal(yield* workGuard.isBusy, true);
      NodeAssert.deepEqual(runtimeMock.state.interruptCalls, []);
    }),
  );

  it.effect("rejects external stop when native work reads fail after pending reconciliation", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "externalPending";
      runtimeMock.state.pendingPermissions = [
        {
          id: "permission-native-read-error",
          sessionID: "session-v2",
          action: "bash",
          resources: ["echo uncertain"],
          message: "Allow this command?",
        },
      ];
      const adapter = yield* OpenCodeAdapter;
      const workGuard = yield* OpenCodeWorkGuard;
      const threadId = ThreadId.make("thread-opencode-v2-stop-native-read-error");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const subscription = runtimeMock.state.nextEventSubscription();
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 2, sessionId: "session-v2" },
      });
      yield* Effect.promise(() => subscription);
      yield* nextEvent(
        (event) => event.type === "request.opened" && event.requestId === "permission-native-read-error",
      );
      runtimeMock.state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");
      runtimeMock.state.pendingPermissions = [];
      runtimeMock.state.failActiveSessionRead = true;

      const stopResult = yield* Effect.result(adapter.stopSession(threadId));
      NodeAssert.equal(stopResult._tag, "Failure");
      NodeAssert.equal(yield* workGuard.isBusy, true);
      NodeAssert.deepEqual(runtimeMock.state.interruptCalls, []);
    }),
  );

  it.effect(
    "adopts externally active resumed work into the shared guard until idle is confirmed",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "recovery";
        runtimeMock.state.activeSessions.add("session-v2");
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-adopted-active");
        const nextEvent = yield* observeEvents(adapter, threadId);
        const firstSubscription = runtimeMock.state.nextEventSubscription();
        const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
        const adopted = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        });
        yield* Effect.promise(() => firstSubscription);
        NodeAssert.deepEqual(adopted.resumeCursor, savedCursor);
        NodeAssert.equal(yield* workGuard.isBusy, true);
        const adoptedWarning = yield* nextEvent((event) => event.type === "runtime.warning");
        NodeAssert.equal(adoptedWarning.type, "runtime.warning");

        runtimeMock.state.activeSessions.clear();
        runtimeMock.state.failEventStream(new Error("event transport disconnected"));
        const streamError = yield* nextEvent((event) => event.type === "runtime.error");
        NodeAssert.equal(streamError.type, "runtime.error");
        const resumedSubscription = runtimeMock.state.nextEventSubscription();
        const resumed = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        });
        yield* Effect.promise(() => resumedSubscription);
        NodeAssert.deepEqual(resumed.resumeCursor, savedCursor);
        NodeAssert.equal(runtimeMock.state.createdSessions, 0);
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );

  it.effect(
    "revalidates external request settlement without inventing a turn or clearing active work",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "externalPending";
        runtimeMock.state.pendingPermissions = [
          {
            id: "permission-external",
            sessionID: "session-v2",
            action: "bash",
            resources: ["echo external"],
            message: "Allow this command?",
          },
        ];
        runtimeMock.state.pendingForms = [
          {
            id: "form-external-replied",
            detail: {
              id: "form-external-replied",
              title: "External reply",
              fields: [{ key: "answer", title: "Answer", type: "string" }],
              state: { status: "pending" },
            },
          },
          {
            id: "form-external-cancelled",
            detail: {
              id: "form-external-cancelled",
              title: "External cancellation",
              fields: [{ key: "answer", title: "Answer", type: "string" }],
              state: { status: "pending" },
            },
          },
        ];

        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-external-requests");
        const nextEvent = yield* observeEvents(adapter, threadId);
        const subscription = runtimeMock.state.nextEventSubscription();
        const savedCursor = { schemaVersion: 2, sessionId: "session-v2" };
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: savedCursor,
        });
        yield* Effect.promise(() => subscription);

        yield* nextEvent(
          (event) => event.type === "request.opened" && event.requestId === "permission-external",
        );
        yield* nextEvent(
          (event) =>
            event.type === "user-input.requested" && event.requestId === "form-external-replied",
        );
        yield* nextEvent(
          (event) =>
            event.type === "user-input.requested" && event.requestId === "form-external-cancelled",
        );
        yield* nextEvent(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message ===
              "This OpenCode session is already active outside the current T3 turn.",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        const sendAndWaitForReceipt = (
          nativeEvent: unknown,
          outputMatches: (event: ProviderRuntimeEvent) => boolean,
          barrierId: string,
        ) =>
          Effect.gen(function* () {
            runtimeMock.state.sendNativeEvent(nativeEvent);
            yield* nextEvent(outputMatches);
            runtimeMock.state.sendNativeEvent({
              id: `event-barrier-${barrierId}`,
              created: 50,
              type: "session.retry.scheduled",
              data: { sessionID: "session-v2", error: { message: barrierId } },
            });
            yield* nextEvent(
              (event) => event.type === "runtime.warning" && event.payload.detail === barrierId,
            );
          });

        yield* sendAndWaitForReceipt(
          {
            id: "event-permission-replied-external",
            created: 20,
            type: "permission.replied",
            data: {
              sessionID: "session-v2",
              requestID: "permission-external",
              reply: "reject",
            },
          },
          (event) => event.type === "request.resolved" && event.requestId === "permission-external",
          "permission receipt",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        yield* sendAndWaitForReceipt(
          {
            id: "event-form-replied-external",
            created: 21,
            type: "form.replied",
            data: {
              id: "form-external-replied",
              sessionID: "session-v2",
              answer: { answer: "accepted" },
            },
          },
          (event) =>
            event.type === "user-input.resolved" && event.requestId === "form-external-replied",
          "form reply receipt",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        yield* sendAndWaitForReceipt(
          {
            id: "event-form-cancelled-external",
            created: 22,
            type: "form.cancelled",
            data: { id: "form-external-cancelled", sessionID: "session-v2" },
          },
          (event) =>
            event.type === "user-input.resolved" && event.requestId === "form-external-cancelled",
          "form cancel receipt",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.pendingPermissions = [];
        runtimeMock.state.pendingForms = [];
        runtimeMock.state.activeSessions.add("session-v2");
        runtimeMock.state.sendNativeEvent({
          id: "event-idle-with-active-native-work",
          created: 23,
          type: "session.idle",
          data: { sessionID: "session-v2" },
        });
        runtimeMock.state.sendNativeEvent({
          id: "event-barrier-idle-receipt",
          created: 24,
          type: "session.retry.scheduled",
          data: { sessionID: "session-v2", error: { message: "idle receipt" } },
        });
        yield* nextEvent(
          (event) => event.type === "runtime.warning" && event.payload.detail === "idle receipt",
        );
        NodeAssert.equal(yield* workGuard.isBusy, true);

        runtimeMock.state.activeSessions.clear();
        yield* workGuard.revalidateNativeContexts;
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );

  it.effect(
    "keeps replacement native leases through stale idle proofs and delayed revalidators",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "externalPending";
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-native-proof-race");
        const nextEvent = yield* observeEvents(adapter, threadId);
        const subscription = runtimeMock.state.nextEventSubscription();
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 2, sessionId: "session-v2" },
        });
        yield* Effect.promise(() => subscription);

        const sendNativeActivity = (id: string, delta: string) =>
          Effect.gen(function* () {
            runtimeMock.state.sendNativeEvent({
              id,
              created: 1,
              type: "session.text.delta",
              data: {
                sessionID: "session-v2",
                assistantMessageID: "assistant-external",
                delta,
                ordinal: 0,
              },
            });
            yield* nextEvent(
              (event) => event.type === "content.delta" && event.payload.delta === delta,
            );
          });

        yield* sendNativeActivity("event-native-activity-l1", "L1 activity");
        NodeAssert.equal(yield* workGuard.isBusy, true);
        const l1Revalidator = runtimeMock.state.nativeWorkRevalidators.at(0);
        NodeAssert.ok(l1Revalidator);

        const l1IdleRead = makeActiveSessionReadBarrier();
        runtimeMock.state.activeSessionReadBarriers.push(l1IdleRead);
        const staleL1Proof = yield* workGuard.revalidateNativeContexts.pipe(Effect.forkChild);
        yield* Effect.promise(() => l1IdleRead.entered);

        yield* workGuard.revalidateNativeContexts;
        NodeAssert.equal(yield* workGuard.isBusy, false);

        runtimeMock.state.activeSessions.add("session-v2");
        yield* sendNativeActivity("event-native-activity-l2", "L2 activity");
        NodeAssert.equal(yield* workGuard.isBusy, true);
        const l2Revalidator = runtimeMock.state.nativeWorkRevalidators.at(-1);
        NodeAssert.ok(l2Revalidator);
        NodeAssert.notEqual(l2Revalidator.ownerId, l1Revalidator.ownerId);

        l1IdleRead.release();
        yield* Fiber.join(staleL1Proof);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        const readsBeforeDelayedL1 = runtimeMock.state.activeSessionReadCount;
        yield* l1Revalidator.revalidate;
        NodeAssert.equal(runtimeMock.state.activeSessionReadCount, readsBeforeDelayedL1);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        const activationCalls: string[] = [];
        let accountServerConnections = 0;
        let accountIntegrationReads = 0;
        let activeCredentialId = "credential-a";
        const credentials = [
          {
            type: "credential" as const,
            id: "credential-a",
            label: "Account A",
            method: "oauth" as const,
          },
          {
            type: "credential" as const,
            id: "credential-b",
            label: "Account B",
            method: "oauth" as const,
          },
        ];
        const accountClient = {
          integration: {
            get: async () => {
              accountIntegrationReads += 1;
              return {
                data: {
                  id: "openai",
                  name: "OpenAI",
                  methods: [],
                  connections: [
                    ...credentials.filter((credential) => credential.id === activeCredentialId),
                    ...credentials.filter((credential) => credential.id !== activeCredentialId),
                  ],
                },
              };
            },
          },
          credential: {
            activate: async ({ credentialID }: { readonly credentialID: string }) => {
              activationCalls.push(credentialID);
              activeCredentialId = credentialID;
            },
          },
          session: { active: async () => ({}) },
          permission: { request: { list: async () => ({ data: [] }) } },
          form: { list: async () => ({ data: [] }) },
        };
        const accountRuntime: OpenCodeRuntimeShape = {
          ...OpenCodeRuntimeTestDouble,
          connectToOpenCodeServer: (input) =>
            Effect.sync(() => {
              accountServerConnections += 1;
              return {
                url: input.serverUrl || "http://127.0.0.1:9999",
                ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
                version: "2.0.18",
                protocol: "v2" as const,
                exitCode: null,
                external: true,
              };
            }),
          createOpenCodeV2Client: () => accountClient as never,
        };
        const serverOwner = {
          withServer: () => Effect.die("local server is not used by this regression"),
        } as unknown as OpenCodeServerOwnerModule.OpenCodeServerOwner["Service"];
        const accountManagement = yield* makeOpenCodeAccountManagement({
          instanceId: ProviderInstanceId.make("opencode"),
          settings: OpenCodeAccountRaceSettings,
          environment: {},
          workGuard,
        }).pipe(
          Effect.provideService(OpenCodeRuntime, accountRuntime),
          Effect.provideService(ServerConfig, { cwd: process.cwd() } as ServerConfig["Service"]),
          Effect.provideService(OpenCodeServerOwnerModule.OpenCodeServerOwner, serverOwner),
        );

        const replacementActivationError = yield* accountManagement
          .activate(
            { credentialId: "credential-b", expectedActiveCredentialId: "credential-a" },
            () => Effect.succeed("refreshed"),
          )
          .pipe(Effect.flip);
        NodeAssert.equal(replacementActivationError.reason, "busy");
        NodeAssert.equal(accountServerConnections, 0);
        NodeAssert.equal(accountIntegrationReads, 0);
        NodeAssert.deepEqual(activationCalls, []);

        runtimeMock.state.activeSessions.clear();
        const sameOwnerIdleRead = makeActiveSessionReadBarrier();
        runtimeMock.state.activeSessionReadBarriers.push(sameOwnerIdleRead);
        const staleSameOwnerProof = yield* workGuard.revalidateNativeContexts.pipe(
          Effect.forkChild,
        );
        yield* Effect.promise(() => sameOwnerIdleRead.entered);

        runtimeMock.state.activeSessions.add("session-v2");
        const registrationCount = runtimeMock.state.nativeWorkRevalidators.length;
        yield* sendNativeActivity("event-native-activity-same-owner", "same owner activity");
        NodeAssert.equal(runtimeMock.state.nativeWorkRevalidators.length, registrationCount);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        sameOwnerIdleRead.release();
        yield* Fiber.join(staleSameOwnerProof);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        const sameOwnerActivationError = yield* accountManagement
          .activate(
            { credentialId: "credential-b", expectedActiveCredentialId: "credential-a" },
            () => Effect.succeed("refreshed"),
          )
          .pipe(Effect.flip);
        NodeAssert.equal(sameOwnerActivationError.reason, "busy");
        NodeAssert.equal(accountServerConnections, 0);
        NodeAssert.equal(accountIntegrationReads, 0);
        NodeAssert.deepEqual(activationCalls, []);
      }),
  );

  it.effect("round-trips V2 permission requests and maps allow and deny decisions", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "permission";
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-v2-permissions");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const nextEvent = yield* observeEvents(adapter, threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "Run a command after approval",
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
      });

      yield* nextEvent((event) => event.type === "request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-v2-allow"),
        "acceptForSession",
      );
      yield* nextEvent(
        (event) => event.type === "request.resolved" && event.requestId === "permission-v2-allow",
      );

      yield* nextEvent((event) => event.type === "request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-v2-deny"),
        "decline",
      );
      yield* nextEvent(
        (event) => event.type === "request.resolved" && event.requestId === "permission-v2-deny",
      );
      yield* nextEvent((event) => event.type === "turn.completed");

      NodeAssert.deepEqual(runtimeMock.state.permissionReplies, [
        { sessionID: "session-v2", requestID: "permission-v2-allow", decision: "always" },
        { sessionID: "session-v2", requestID: "permission-v2-deny", decision: "reject" },
      ]);
    }),
  );

  it.effect("round-trips a V2 form and converts typed answers for the V2 API", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "form";
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-v2-form");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const nextEvent = yield* observeEvents(adapter, threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "Ask me for options",
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
      });

      const requested = yield* nextEvent((event) => event.type === "user-input.requested");
      NodeAssert.equal(requested.type, "user-input.requested");
      if (requested.type === "user-input.requested") {
        NodeAssert.deepEqual(requested.payload.questions[0], {
          id: "question-0-mode",
          header: "Mode",
          question: "Mode",
          options: [{ label: "Quick", description: "Quick" }],
          customAnswerOrigin: "tagged",
        });
      }
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("form-v2"), {
        "question-0-mode": "Quick",
        "question-1-count": "3",
      });
      yield* nextEvent(
        (event) => event.type === "user-input.resolved" && event.requestId === "form-v2",
      );
      yield* nextEvent((event) => event.type === "turn.completed");

      NodeAssert.deepEqual(runtimeMock.state.formReplies, [
        {
          sessionID: "session-v2",
          formID: "form-v2",
          answer: { mode: "fast", count: 3 },
        },
      ]);
    }),
  );

  it.effect("forwards V2 interruption and waits for the interrupted execution event", () =>
    Effect.gen(function* () {
      runtimeMock.state.scenario = "interrupt";
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-v2-interrupt");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const nextEvent = yield* observeEvents(adapter, threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "Keep working until interrupted",
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "openai/gpt-5" },
      });
      yield* adapter.interruptTurn(threadId);
      const completed = yield* nextEvent((event) => event.type === "turn.completed");
      if (completed.type === "turn.completed") {
        NodeAssert.deepEqual(completed.payload, { state: "interrupted" });
      }
      NodeAssert.deepEqual(runtimeMock.state.interruptCalls, [{ sessionID: "session-v2" }]);
    }),
  );
});

it.layer(LocalOpenCodeAdapterTestLayer)("OpenCodeAdapterDispatcher local server", (it) => {
  it.effect("routes a locally started V2 server through the V2 adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = ThreadId.make("thread-opencode-v2-local-dispatch");
      const instanceId = ProviderInstanceId.make("opencode");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Use the local V2 server",
        modelSelection: { instanceId, model: "openai/gpt-5" },
      });

      NodeAssert.deepEqual(runtimeMock.state.connectCalls, [{ url: "", directory: process.cwd() }]);
      NodeAssert.deepEqual(runtimeMock.state.v2ClientInputs, [
        { baseUrl: "http://127.0.0.1:4301", serverPassword: "server-secret" },
      ]);
      NodeAssert.equal(runtimeMock.state.createdSessions, 1);
      NodeAssert.equal(runtimeMock.state.promptInputs[0]?.text, "Use the local V2 server");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "clears adopted context work only after an ambiguous stop reaches local process exit",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.scenario = "recovery";
        runtimeMock.state.activeSessions.add("session-v2");
        const adapter = yield* OpenCodeAdapter;
        const workGuard = yield* OpenCodeWorkGuard;
        const threadId = ThreadId.make("thread-opencode-v2-local-ambiguous-stop");
        const firstSubscription = runtimeMock.state.nextEventSubscription();
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 2, sessionId: "session-v2" },
        });
        yield* Effect.promise(() => firstSubscription);
        NodeAssert.equal(yield* workGuard.isBusy, true);

        yield* workGuard.beginTurn("thread-other-instance", "other-instance:route");
        runtimeMock.state.failNativeStop = true;
        yield* adapter.stopSession(threadId);

        NodeAssert.equal(runtimeMock.state.localExitCount, 1);
        NodeAssert.equal(yield* workGuard.isBusy, true);
        yield* workGuard.endThread("thread-other-instance", "other-instance:route");
        NodeAssert.equal(yield* workGuard.isBusy, false);
      }),
  );
});

const assertV1DispatcherRoute = (expectedUrl: string, expectedConnectUrl: string) =>
  Effect.gen(function* () {
    runtimeMock.state.serverProtocol = "v1";
    runtimeMock.state.serverVersion = "1.18.33";
    const adapter = yield* OpenCodeAdapter;
    const threadId = ThreadId.make(
      expectedConnectUrl ? "thread-opencode-v1-external" : "thread-opencode-v1-local",
    );
    const instanceId = ProviderInstanceId.make("opencode");

    const session = yield* adapter.startSession({
      provider: ProviderDriverKind.make("opencode"),
      threadId,
      runtimeMode: "full-access",
    });
    const turn = yield* adapter.sendTurn({
      threadId,
      input: "Use the V1 server",
      modelSelection: { instanceId, model: "openai/gpt-4o" },
    });

    NodeAssert.equal(session.provider, "opencode");
    NodeAssert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "session-v1" });
    NodeAssert.equal(turn.threadId, threadId);
    NodeAssert.deepEqual(runtimeMock.state.connectCalls, [
      { url: expectedConnectUrl, directory: process.cwd() },
    ]);
    NodeAssert.deepEqual(runtimeMock.state.v1ClientInputs, [
      { baseUrl: expectedUrl, serverPassword: "server-secret" },
    ]);
    NodeAssert.deepEqual(runtimeMock.state.v2ClientInputs, []);
    NodeAssert.deepEqual(runtimeMock.state.v1SessionCreateUrls, [expectedUrl]);
    NodeAssert.equal(runtimeMock.state.createdSessions, 1);
    NodeAssert.equal(runtimeMock.state.v1PromptInputs[0]?.sessionID, "session-v1");
    NodeAssert.deepEqual(runtimeMock.state.v1PromptInputs[0]?.parts, [
      { type: "text", text: "Use the V1 server" },
    ]);

    yield* adapter.stopSession(threadId);
  });

it.layer(V1LocalOpenCodeAdapterTestLayer)("OpenCodeAdapterDispatcher local V1 server", (it) => {
  it.effect("routes a local V1 session and turn through the V1 SDK", () =>
    assertV1DispatcherRoute("http://127.0.0.1:4301", ""),
  );
});

it.layer(V1ExternalOpenCodeAdapterTestLayer)(
  "OpenCodeAdapterDispatcher external V1 server",
  (it) => {
    it.effect("routes an external V1 session and turn through the V1 SDK", () =>
      assertV1DispatcherRoute("http://127.0.0.1:9999", "http://127.0.0.1:9999"),
    );
  },
);
