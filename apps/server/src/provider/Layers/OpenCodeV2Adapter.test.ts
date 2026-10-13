import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { AgentInfo, OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
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
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { makeOpenCodeV2Adapter } from "./OpenCodeV2Adapter.ts";

class OpenCodeV2Adapter extends Context.Service<OpenCodeV2Adapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeV2Adapter.test/OpenCodeV2Adapter",
) {}

type PermissionRule = { action: string; resource: string; effect: string };
type PermissionUpdate = { sessionID: string; permissions: ReadonlyArray<PermissionRule> };
type WaitRelease = () => void;
type MessageListInput = {
  sessionID: string;
  limit?: number;
  order?: "asc" | "desc";
  cursor?: string;
  type?: "assistant" | "user";
};
type MessagePage = {
  data: Array<SessionMessageInfo>;
  cursor: { next?: string | null; previous?: string | null };
};

const configuredAgents = [
  { id: "workspace-default", name: "Workspace Default", mode: "primary", hidden: false },
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "review", name: "Review", mode: "primary", hidden: false },
] as unknown as Array<AgentInfo>;

const state = {
  directory: process.cwd(),
  sessionID: "session-v2-k2",
  createdSessions: 0,
  createInputs: [] as Array<{ location?: { directory?: string }; permissions?: unknown }>,
  sessionUpdates: [] as Array<PermissionUpdate>,
  nativePermissions: new Map<string, ReadonlyArray<PermissionRule>>(),
  permissionHistory: [] as Array<ReadonlyArray<PermissionRule>>,
  failNextPermissionUpdate: false,
  agentListCalls: [] as Array<{ location?: { directory?: string } }>,
  agentSwitches: [] as Array<{ sessionID: string; agent: string }>,
  failAgentList: false,
  failAgentSwitch: false,
  promptInputs: [] as Array<{ sessionID: string; text: string }>,
  waitObservers: [] as Array<(release: WaitRelease) => void>,
  activeSessions: new Set<string>(),
  pendingRequests: [] as Array<{
    id: string;
    sessionID: string;
    action: string;
    resources: Array<string>;
    message?: string;
  }>,
  pendingForms: [] as Array<{ id: string; detail: unknown }>,
  nativeEvents: [] as Array<OpenCodeEvent>,
  eventWaiters: [] as Array<{
    readonly resolve: (result: IteratorResult<OpenCodeEvent>) => void;
    readonly reject: (cause: unknown) => void;
  }>,
  eventFailures: [] as Array<unknown>,
  endEventStreams: 0,
  eventSubscriptions: 0,
  subscriptionWaiters: [] as Array<() => void>,
  messageListCalls: [] as Array<MessageListInput>,
  messageListResponses: [] as Array<MessagePage>,
  formReplies: [] as Array<{ sessionID: string; formID: string; answer: unknown }>,
  revertStages: [] as Array<{ sessionID: string; messageID: string }>,
  revertCommits: 0,
  reset() {
    this.directory = process.cwd();
    this.sessionID = "session-v2-k2";
    this.createdSessions = 0;
    this.createInputs.length = 0;
    this.sessionUpdates.length = 0;
    this.nativePermissions.clear();
    this.permissionHistory.length = 0;
    this.failNextPermissionUpdate = false;
    this.agentListCalls.length = 0;
    this.agentSwitches.length = 0;
    this.failAgentList = false;
    this.failAgentSwitch = false;
    this.promptInputs.length = 0;
    this.waitObservers.length = 0;
    this.activeSessions.clear();
    this.pendingRequests.length = 0;
    this.pendingForms.length = 0;
    this.nativeEvents.length = 0;
    this.eventWaiters.length = 0;
    this.eventFailures.length = 0;
    this.endEventStreams = 0;
    this.eventSubscriptions = 0;
    this.subscriptionWaiters.length = 0;
    this.messageListCalls.length = 0;
    this.messageListResponses.length = 0;
    this.formReplies.length = 0;
    this.revertStages.length = 0;
    this.revertCommits = 0;
  },
  publishEvent(event: OpenCodeEvent) {
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.nativeEvents.push(event);
    const data = event.data as { sessionID?: string; id?: string; requestID?: string };
    if (
      [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.idle",
      ].includes(event.type)
    ) {
      if (data.sessionID) this.activeSessions.delete(data.sessionID);
    }
    if (event.type === "permission.asked") {
      if (data.sessionID) this.activeSessions.add(data.sessionID);
      const request = event.data as {
        id: string;
        sessionID: string;
        action: string;
        resources: Array<string>;
        message?: string;
      };
      if (!this.pendingRequests.some((current) => current.id === request.id)) {
        this.pendingRequests.push(request);
      }
    }
    if (event.type === "permission.replied" && data.requestID) {
      this.pendingRequests = this.pendingRequests.filter((request) => request.id !== data.requestID);
    }
    if (event.type === "form.created") {
      const form = (event.data as { form?: { id?: string; [key: string]: unknown } }).form;
      if (form?.id && !this.pendingForms.some((pending) => pending.id === form.id)) {
        this.pendingForms.push({ id: form.id, detail: { ...form, state: { status: "pending" } } });
      }
    }
    if ((event.type === "form.replied" || event.type === "form.cancelled") && data.id) {
      this.pendingForms = this.pendingForms.filter((form) => form.id !== data.id);
    }
  },
  failEventStream(cause: unknown) {
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter.reject(cause);
    else this.eventFailures.push(cause);
  },
  endEventStream() {
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter.resolve({ done: true, value: undefined });
    else this.endEventStreams += 1;
  },
  nextSessionWait(): Promise<WaitRelease> {
    return new Promise((resolve) => this.waitObservers.push(resolve));
  },
  nextEventSubscription(): Promise<void> {
    return new Promise((resolve) => this.subscriptionWaiters.push(resolve));
  },
};

function sessionEventStream(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
  return {
    [Symbol.asyncIterator]() {
      state.eventSubscriptions += 1;
      state.subscriptionWaiters.shift()?.();
      let closed = false;
      let currentWaiter:
        | {
            readonly resolve: (result: IteratorResult<OpenCodeEvent>) => void;
            readonly reject: (cause: unknown) => void;
          }
        | undefined;
      const finish = () => {
        closed = true;
        if (currentWaiter) {
          const index = state.eventWaiters.indexOf(currentWaiter);
          if (index >= 0) state.eventWaiters.splice(index, 1);
          currentWaiter.resolve({ done: true, value: undefined });
          currentWaiter = undefined;
        }
      };
      signal.addEventListener("abort", finish, { once: true });
      return {
        next() {
          if (closed) return Promise.resolve({ done: true, value: undefined });
          const event = state.nativeEvents.shift();
          if (event) return Promise.resolve({ done: false, value: event });
          const failure = state.eventFailures.shift();
          if (failure !== undefined) return Promise.reject(failure);
          if (state.endEventStreams > 0) {
            state.endEventStreams -= 1;
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<OpenCodeEvent>>((resolve, reject) => {
            currentWaiter = { resolve, reject };
            state.eventWaiters.push(currentWaiter);
          });
        },
        return() {
          finish();
          signal.removeEventListener("abort", finish);
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

const runtime: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () => Effect.die(new Error("not used")),
  connectToOpenCodeServer: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4318",
      version: "2.0.18",
      protocol: "v2",
      exitCode: null,
      external: true,
    }),
  runOpenCodeCommand: () => Effect.die(new Error("not used")),
  createOpenCodeSdkClient: () => {
    throw new Error("the V1 client must not be selected");
  },
  createOpenCodeV2Client: () => {
    const client = {
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => sessionEventStream(signal),
      },
      agent: {
        list: async (input?: { location?: { directory?: string } }) => {
          state.agentListCalls.push(input ?? {});
          if (state.failAgentList) throw new Error("agent list rejected");
          return { data: configuredAgents };
        },
      },
      session: {
        create: async (input: { location?: { directory?: string }; permissions?: unknown }) => {
          state.createdSessions += 1;
          state.createInputs.push(input);
          state.directory = input.location?.directory ?? process.cwd();
          const permissions = input.permissions as ReadonlyArray<PermissionRule>;
          state.nativePermissions.set(state.sessionID, permissions);
          state.permissionHistory.push(permissions);
          return { id: state.sessionID, location: { directory: state.directory } };
        },
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          location: { directory: state.directory },
        }),
        update: async (input: PermissionUpdate) => {
          state.sessionUpdates.push(input);
          if (state.failNextPermissionUpdate) {
            state.failNextPermissionUpdate = false;
            throw new Error("permission update rejected");
          }
          state.nativePermissions.set(input.sessionID, input.permissions);
          state.permissionHistory.push(input.permissions);
        },
        switchModel: async () => undefined,
        switchAgent: async (input: { sessionID: string; agent: string }) => {
          if (state.failAgentSwitch) throw new Error("agent switch rejected");
          state.agentSwitches.push(input);
        },
        prompt: async (input: { sessionID: string; text: string }) => {
          state.promptInputs.push(input);
          state.activeSessions.add(input.sessionID);
        },
        wait: async () => {
          await new Promise<void>((resolve) => {
            const release = () => resolve();
            state.waitObservers.shift()?.(release);
          });
          state.activeSessions.delete(state.sessionID);
        },
        interrupt: async () => {
          state.activeSessions.delete(state.sessionID);
          return { interrupted: true };
        },
        active: async () =>
          Object.fromEntries([...state.activeSessions].map((sessionID) => [sessionID, { type: "running" }])),
        form: {
          list: async () => state.pendingForms.map(({ id }) => ({ id })),
          get: async ({ formID }: { formID: string }) =>
            state.pendingForms.find((form) => form.id === formID)?.detail,
          reply: async (input: { sessionID: string; formID: string; answer: unknown }) => {
            state.formReplies.push(input);
            state.pendingForms = state.pendingForms.filter((form) => form.id !== input.formID);
          },
        },
        revert: {
          stage: async (input: { sessionID: string; messageID: string }) => {
            state.revertStages.push(input);
          },
          commit: async () => {
            state.revertCommits += 1;
          },
        },
      },
      permission: {
        request: { list: async () => ({ data: state.pendingRequests }) },
        reply: async (input: { readonly requestID: string }) => {
          state.pendingRequests = state.pendingRequests.filter(
            (request) => request.id !== input.requestID,
          );
        },
      },
      message: {
        list: async (input: MessageListInput) => {
          state.messageListCalls.push(input);
          return state.messageListResponses.shift() ?? { data: [], cursor: {} };
        },
      },
    };
    return client as never;
  },
  loadOpenCodeV2Inventory: () => Effect.die(new Error("not used")),
  loadOpenCodeInventory: () => Effect.die(new Error("not used")),
  loadInventoryFromCli: () => Effect.die(new Error("not used")),
};

const settings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "",
});

const OpenCodeV2AdapterTestLayer = Layer.effect(
  OpenCodeV2Adapter,
  makeOpenCodeV2Adapter(settings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, runtime)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const startInput = (threadId: ThreadId, runtimeMode: "full-access" | "approval-required") => ({
  provider: ProviderDriverKind.make("opencode"),
  threadId,
  cwd: process.cwd(),
  runtimeMode,
});

const sendInput = (threadId: ThreadId, interactionMode?: "default" | "plan", agent?: string) => ({
  threadId,
  input: "Continue the same native session",
  interactionMode,
  modelSelection: {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "openai/gpt-5",
    ...(agent ? { options: [{ id: "agent", value: agent }] } : {}),
  },
});

function observeEvents(adapter: OpenCodeAdapterShape, threadId: ThreadId) {
  return Effect.gen(function* () {
    const observed = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.threadId === threadId ? Queue.offer(observed, event) : Effect.void,
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

beforeEach(() => state.reset());

function assistantMessage(
  id: string,
  text: string,
  error?: { readonly type: string; readonly message: string },
): Extract<SessionMessageInfo, { readonly type: "assistant" }> {
  return {
    id,
    type: "assistant",
    time: { created: 1 },
    agent: "build",
    model: { id: "gpt-5", providerID: "openai" },
    content: [{ type: "text", text }],
    ...(error ? { error } : {}),
  };
}

function messagePage(
  data: ReadonlyArray<SessionMessageInfo>,
  next?: string | null,
): MessagePage {
  return { data: [...data], cursor: next !== undefined ? { next } : {} };
}

it.layer(OpenCodeV2AdapterTestLayer)("OpenCodeV2Adapter session updates", (it) => {
  it.effect("applies full-access → approval-required → full-access and reads back native permissions", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-k2-permissions");

      const first = yield* adapter.startSession(startInput(threadId, "full-access"));
      const approval = yield* adapter.startSession(startInput(threadId, "approval-required"));
      const full = yield* adapter.startSession(startInput(threadId, "full-access"));
      const [current] = yield* adapter.listSessions();

      NodeAssert.equal(state.createdSessions, 1);
      NodeAssert.deepEqual(approval.resumeCursor, first.resumeCursor);
      NodeAssert.deepEqual(full.resumeCursor, first.resumeCursor);
      NodeAssert.equal(approval.runtimeMode, "approval-required");
      NodeAssert.equal(full.runtimeMode, "full-access");
      NodeAssert.deepEqual(current, full);
      NodeAssert.equal(state.sessionUpdates.length, 2);
      NodeAssert.deepEqual(
        state.nativePermissions.get(state.sessionID),
        state.sessionUpdates[1]?.permissions,
      );
      NodeAssert.deepEqual(
        state.permissionHistory.map(
          (permissions) =>
            permissions.find((permission) => permission.action === "*")?.effect,
        ),
        ["allow", "ask", "allow"],
      );
    }),
  );

  it.effect("keeps the prior runtime mode and session identity when native permission update fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-k2-permission-failure");
      const original = yield* adapter.startSession(startInput(threadId, "full-access"));
      state.failNextPermissionUpdate = true;

      const update = yield* Effect.exit(
        adapter.startSession(startInput(threadId, "approval-required")),
      );
      const [current] = yield* adapter.listSessions();

      NodeAssert.equal(Exit.isFailure(update), true);
      if (Exit.isFailure(update)) {
        NodeAssert.equal(
          String(Cause.squash(update.cause)).includes("permission update rejected"),
          true,
        );
      }
      NodeAssert.equal(current?.runtimeMode, "full-access");
      NodeAssert.deepEqual(current?.resumeCursor, original.resumeCursor);
      NodeAssert.deepEqual(state.nativePermissions.get(state.sessionID), state.permissionHistory[0]);
      NodeAssert.equal(state.createdSessions, 1);
    }),
  );

  it.effect("invalidates a failed or ended event stream and resumes the saved session with pending forms", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-event-recovery");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const firstSubscription = state.nextEventSubscription();
      const original = yield* adapter.startSession(startInput(threadId, "full-access"));
      yield* Effect.promise(() => firstSubscription);

      state.pendingForms.push({
        id: "form-recovery",
        detail: {
          id: "form-recovery",
          title: "Choose a mode",
          fields: [
            {
              key: "mode",
              title: "Mode",
              type: "string",
              options: [{ label: "Quick", value: "fast" }],
            },
          ],
          state: { status: "pending" },
        },
      });
      state.failEventStream(new Error("event transport disconnected"));
      const failure = yield* nextEvent((event) => event.type === "runtime.error");
      NodeAssert.equal(failure.type, "runtime.error");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);

      const resumedSubscription = state.nextEventSubscription();
      const resumed = yield* adapter.startSession({
        ...startInput(threadId, "approval-required"),
        resumeCursor: original.resumeCursor,
      });
      yield* Effect.promise(() => resumedSubscription);
      const request = yield* nextEvent((event) => event.type === "user-input.requested");
      NodeAssert.equal(request.type, "user-input.requested");
      NodeAssert.deepEqual(resumed.resumeCursor, original.resumeCursor);
      NodeAssert.equal(resumed.runtimeMode, "approval-required");
      NodeAssert.equal(state.createdSessions, 1);
      NodeAssert.equal(state.sessionUpdates.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("form-recovery"), {
        "question-0-mode": "Quick",
      });
      NodeAssert.deepEqual(state.formReplies, [
        { sessionID: state.sessionID, formID: "form-recovery", answer: { mode: "fast" } },
      ]);

      const eofSubscription = state.eventSubscriptions;
      state.endEventStream();
      const eof = yield* nextEvent((event) => event.type === "runtime.error");
      NodeAssert.equal(eof.type, "runtime.error");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);

      const finalSubscription = state.nextEventSubscription();
      const finalSession = yield* adapter.startSession({
        ...startInput(threadId, "approval-required"),
        resumeCursor: original.resumeCursor,
      });
      yield* Effect.promise(() => finalSubscription);
      NodeAssert.deepEqual(finalSession.resumeCursor, original.resumeCursor);
      NodeAssert.equal(state.createdSessions, 1);
      NodeAssert.equal(state.eventSubscriptions, eofSubscription + 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);
    }),
  );

  it.effect("reports the latest native assistant error after idle recovery", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-recovery-latest-error");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const firstSubscription = state.nextEventSubscription();
      const original = yield* adapter.startSession(startInput(threadId, "full-access"));
      yield* Effect.promise(() => firstSubscription);

      const waitStarted = state.nextSessionWait();
      yield* adapter.sendTurn(sendInput(threadId));
      yield* Effect.promise(() => waitStarted);
      state.messageListResponses.push(
        messagePage(
          [assistantMessage("assistant-latest-error", "", { type: "api_error", message: "native turn failed" })],
          null,
        ),
      );
      state.activeSessions.clear();
      state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);

      const resumedSubscription = state.nextEventSubscription();
      yield* adapter.startSession({
        ...startInput(threadId, "full-access"),
        resumeCursor: original.resumeCursor,
      });
      yield* Effect.promise(() => resumedSubscription);
      const recovered = yield* nextEvent((event) => event.type === "turn.completed");
      NodeAssert.equal(recovered.type, "turn.completed");
      if (recovered.type === "turn.completed") {
        NodeAssert.deepEqual(recovered.payload, {
          state: "failed",
          errorMessage: "native turn failed",
        });
      }
      NodeAssert.deepEqual(state.messageListCalls, [
        { sessionID: state.sessionID, order: "desc", limit: 1, type: "assistant" },
      ]);
      NodeAssert.equal(state.createdSessions, 1);
    }),
  );

  it.effect("recovers only the unstreamed suffix of a final assistant message", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-recovery-text-suffix");
      const nextEvent = yield* observeEvents(adapter, threadId);
      const firstSubscription = state.nextEventSubscription();
      const original = yield* adapter.startSession(startInput(threadId, "full-access"));
      yield* Effect.promise(() => firstSubscription);
      const waitStarted = state.nextSessionWait();
      yield* adapter.sendTurn(sendInput(threadId));
      yield* Effect.promise(() => waitStarted);

      state.publishEvent({
        id: "event-text-partial",
        type: "session.text.delta",
        data: {
          sessionID: state.sessionID,
          assistantMessageID: "assistant-recovered",
          delta: "Partial answer",
          ordinal: 0,
        },
      } as OpenCodeEvent);
      yield* nextEvent((event) => event.type === "content.delta");
      state.messageListResponses.push(
        messagePage([assistantMessage("assistant-recovered", "Partial answer plus ending")], null),
      );
      state.activeSessions.clear();
      state.failEventStream(new Error("event transport disconnected"));
      yield* nextEvent((event) => event.type === "runtime.error");

      const resumedSubscription = state.nextEventSubscription();
      yield* adapter.startSession({
        ...startInput(threadId, "full-access"),
        resumeCursor: original.resumeCursor,
      });
      yield* Effect.promise(() => resumedSubscription);
      const suffix = yield* nextEvent((event) => event.type === "content.delta");
      NodeAssert.equal(suffix.type, "content.delta");
      if (suffix.type === "content.delta") {
        NodeAssert.equal(suffix.payload.delta, " plus ending");
      }
      yield* nextEvent((event) => event.type === "turn.completed");
    }),
  );

  it.effect("rejects live and resumed directory relocation without creating a replacement session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-k2-directory");
      const original = yield* adapter.startSession(startInput(threadId, "full-access"));
      const path = yield* Path.Path;
      const otherDirectory = path.resolve(process.cwd(), "..");

      const liveMove = yield* Effect.exit(
        adapter.startSession({
          ...startInput(threadId, "approval-required"),
          cwd: otherDirectory,
        }),
      );
      NodeAssert.equal(Exit.isFailure(liveMove), true);
      if (Exit.isFailure(liveMove)) {
        NodeAssert.match(String(Cause.squash(liveMove.cause)), /different working directory/);
      }
      const [stillLive] = yield* adapter.listSessions();
      NodeAssert.deepEqual(stillLive?.resumeCursor, original.resumeCursor);
      NodeAssert.equal(stillLive?.runtimeMode, "full-access");
      NodeAssert.equal(state.createdSessions, 1);

      yield* adapter.stopSession(threadId);
      const resumeMove = yield* Effect.exit(
        adapter.startSession({
          ...startInput(threadId, "approval-required"),
          cwd: otherDirectory,
          resumeCursor: original.resumeCursor,
        }),
      );
      NodeAssert.equal(Exit.isFailure(resumeMove), true);
      if (Exit.isFailure(resumeMove)) {
        NodeAssert.match(String(Cause.squash(resumeMove.cause)), /working directory changes/);
      }
      NodeAssert.equal(state.createdSessions, 1);
      NodeAssert.equal(state.sessionUpdates.length, 0);
      NodeAssert.deepEqual(yield* adapter.listSessions(), []);

      const resumed = yield* adapter.startSession({
        ...startInput(threadId, "approval-required"),
        cwd: path.join(process.cwd(), "."),
        resumeCursor: original.resumeCursor,
      });
      NodeAssert.deepEqual(resumed.resumeCursor, original.resumeCursor);
      NodeAssert.equal(resumed.runtimeMode, "approval-required");
      NodeAssert.equal(state.createdSessions, 1);
      NodeAssert.equal(state.sessionUpdates.length, 1);
      NodeAssert.equal(state.sessionUpdates[0]?.sessionID, state.sessionID);
    }),
  );

  it.effect("uses Plan and explicit agents, then restores the configured native default", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-k2-agent-reset");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const nextEvent = yield* observeEvents(adapter, threadId);

      for (const [interactionMode, explicitAgent] of [
        ["plan", undefined],
        ["plan", "review"],
        ["default", undefined],
        ["default", "review"],
        ["default", undefined],
      ] as const) {
        const waitStarted = state.nextSessionWait();
        yield* adapter.sendTurn(sendInput(threadId, interactionMode, explicitAgent));
        const release = yield* Effect.promise(() => waitStarted);
        release();
        yield* nextEvent((event) => event.type === "turn.completed");
      }

      NodeAssert.deepEqual(
        state.agentSwitches.map((selection) => selection.agent),
        ["plan", "review", "workspace-default", "review", "workspace-default"],
      );
      NodeAssert.deepEqual(state.agentListCalls, [
        { location: { directory: process.cwd() } },
        { location: { directory: process.cwd() } },
      ]);
      NodeAssert.equal(state.promptInputs.length, 5);
      NodeAssert.equal(state.promptInputs.every((prompt) => prompt.sessionID === state.sessionID), true);
    }),
  );

  it.effect("propagates agent API failures before publishing or prompting a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)),
      );
      const threadId = ThreadId.make("thread-opencode-v2-k2-agent-failure");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      state.failAgentList = true;

      const listFailure = yield* Effect.exit(adapter.sendTurn(sendInput(threadId)));
      NodeAssert.equal(Exit.isFailure(listFailure), true);
      if (Exit.isFailure(listFailure)) {
        const error = Cause.squash(listFailure.cause);
        NodeAssert.match(String(error), /agent.list/);
      }
      NodeAssert.equal(state.promptInputs.length, 0);
      NodeAssert.equal(state.agentSwitches.length, 0);
      const [sessionBeforeSwitchFailure] = yield* adapter.listSessions();
      NodeAssert.equal(sessionBeforeSwitchFailure?.status, "ready");

      state.failAgentList = false;
      state.failAgentSwitch = true;
      const switchFailure = yield* Effect.exit(
        adapter.sendTurn(sendInput(threadId, "default", "review")),
      );
      NodeAssert.equal(Exit.isFailure(switchFailure), true);
      if (Exit.isFailure(switchFailure)) {
        const error = Cause.squash(switchFailure.cause);
        NodeAssert.match(String(error), /session.switchAgent/);
      }
      NodeAssert.equal(state.promptInputs.length, 0);
      const [sessionAfterSwitchFailure] = yield* adapter.listSessions();
      NodeAssert.equal(sessionAfterSwitchFailure?.status, "ready");
    }),
  );

  it.effect("streams reasoning with its native identity and keeps completion text fallback separate", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-reasoning");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const nextEvent = yield* observeEvents(adapter, threadId);
      const waitStarted = state.nextSessionWait();
      const turn = yield* adapter.sendTurn(sendInput(threadId));
      const release = yield* Effect.promise(() => waitStarted);

      state.messageListResponses.push(messagePage([assistantMessage("assistant-current", "Final text")], null));
      state.publishEvent({
        id: "reasoning-delta",
        created: 1,
        type: "session.reasoning.delta",
        data: {
          sessionID: state.sessionID,
          assistantMessageID: "assistant-current",
          ordinal: 4,
          delta: "Reasoning text",
        },
      });
      release();

      const reasoning = yield* nextEvent(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      const fallback = yield* nextEvent(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      yield* nextEvent((event) => event.type === "turn.completed");

      NodeAssert.equal(reasoning.type, "content.delta");
      if (reasoning.type === "content.delta") {
        NodeAssert.equal(reasoning.itemId, "assistant-current");
        NodeAssert.deepEqual(reasoning.payload, {
          streamKind: "reasoning_text",
          delta: "Reasoning text",
          contentIndex: 4,
        });
      }
      NodeAssert.equal(fallback.type, "content.delta");
      if (fallback.type === "content.delta") {
        NodeAssert.equal(fallback.itemId, "assistant-current");
        NodeAssert.equal(fallback.payload.delta, "Final text");
      }
      NodeAssert.deepEqual(state.messageListCalls, [
        { sessionID: state.sessionID, order: "desc", limit: 1, type: "assistant" },
      ]);
      NodeAssert.equal(turn.turnId.length > 0, true);
    }),
  );

  it.effect("fails from the latest assistant response without scanning message history", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-latest-error");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const nextEvent = yield* observeEvents(adapter, threadId);
      state.messageListResponses.push(
        messagePage(
          [assistantMessage("assistant-latest", "", { type: "api_error", message: "latest failed" })],
          "unused-next-page",
        ),
      );
      const waitStarted = state.nextSessionWait();
      yield* adapter.sendTurn(sendInput(threadId));
      const release = yield* Effect.promise(() => waitStarted);
      release();

      const completion = yield* nextEvent((event) => event.type === "turn.completed");
      NodeAssert.equal(completion.type, "turn.completed");
      if (completion.type === "turn.completed") {
        NodeAssert.deepEqual(completion.payload, { state: "failed", errorMessage: "latest failed" });
      }
      NodeAssert.deepEqual(state.messageListCalls, [
        { sessionID: state.sessionID, order: "desc", limit: 1, type: "assistant" },
      ]);
    }),
  );

  it.effect("loads thread history through cursor pages and stops after the empty page", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-history-pages");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const messages = Array.from({ length: 65 }, (_, index) =>
        assistantMessage(`assistant-${index}`, `Message ${index}`),
      );
      state.messageListResponses.push(
        messagePage(messages.slice(0, 50), "cursor-page-2"),
        messagePage(messages.slice(50), "cursor-empty"),
        messagePage([], null),
      );

      const history = yield* adapter.readThread(threadId);

      NodeAssert.equal(history.turns.length, 65);
      NodeAssert.deepEqual(state.messageListCalls, [
        { sessionID: state.sessionID, limit: 50, order: "asc" },
        { sessionID: state.sessionID, limit: 50, cursor: "cursor-page-2" },
        { sessionID: state.sessionID, limit: 50, cursor: "cursor-empty" },
      ]);
    }),
  );

  it.effect("rejects a repeated message cursor instead of looping", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-repeated-cursor");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const page = messagePage([assistantMessage("assistant-page", "Page")], "repeat-cursor");
      state.messageListResponses.push(page, page);

      const result = yield* Effect.exit(adapter.readThread(threadId));

      NodeAssert.equal(Exit.isFailure(result), true);
      if (Exit.isFailure(result)) {
        NodeAssert.match(String(Cause.squash(result.cause)), /repeated message cursor/);
      }
      NodeAssert.equal(state.messageListCalls.length, 2);
    }),
  );

  it.effect("paginates rollback history and selects the requested older assistant boundary", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-rollback-pages");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const messages = Array.from({ length: 60 }, (_, index) =>
        assistantMessage(`assistant-${index}`, `Message ${index}`),
      );
      const historyPages = [
        messagePage(messages.slice(0, 50), "rollback-page-2"),
        messagePage(messages.slice(50), "rollback-empty"),
        messagePage([], null),
      ];
      state.messageListResponses.push(...historyPages, ...historyPages);

      const history = yield* adapter.rollbackThread(threadId, 1);

      NodeAssert.equal(history.turns.length, 60);
      NodeAssert.deepEqual(state.revertStages, [
        { sessionID: state.sessionID, messageID: "assistant-58" },
      ]);
      NodeAssert.equal(state.revertCommits, 1);
      NodeAssert.deepEqual(state.messageListCalls.slice(0, 6).map((call) => call.cursor), [
        undefined,
        "rollback-page-2",
        "rollback-empty",
        undefined,
        "rollback-page-2",
        "rollback-empty",
      ]);
    }),
  );

  it.effect("labels first-assistant rollback as an adapter boundary, not a native API limit", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-first-rollback");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      state.messageListResponses.push(messagePage([assistantMessage("assistant-0", "Only turn")], null));

      const result = yield* Effect.exit(adapter.rollbackThread(threadId, 1));

      NodeAssert.equal(Exit.isFailure(result), true);
      if (Exit.isFailure(result)) {
        NodeAssert.match(String(Cause.squash(result.cause)), /T3's OpenCode V2 adapter cannot roll back/);
      }
      NodeAssert.equal(state.revertStages.length, 0);
    }),
  );

  it.effect("maps selected form labels and preserves custom text with the same label", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeV2Adapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.catchCause(() => Effect.void)));
      const threadId = ThreadId.make("thread-opencode-v2-k3-form-values");
      yield* adapter.startSession(startInput(threadId, "full-access"));
      const nextEvent = yield* observeEvents(adapter, threadId);

      state.publishEvent({
        id: "form-created",
        created: 1,
        type: "form.created",
        data: {
          form: {
            id: "form-values",
            sessionID: state.sessionID,
            title: "Choose deployment settings",
            fields: [
              {
                key: "selected",
                title: "Selected option",
                type: "string",
                options: [{ label: "Production", value: "prod" }],
                custom: true,
              },
              {
                key: "custom",
                title: "Custom answer",
                type: "string",
                options: [{ label: "Production", value: "prod" }],
                custom: true,
              },
              {
                key: "regions",
                title: "Regions",
                type: "multiselect",
                options: [
                  { label: "North America", value: "na" },
                  { label: "Europe", value: "eu" },
                ],
                custom: true,
              },
              { key: "count", title: "Count", type: "integer" },
              { key: "enabled", title: "Enabled", type: "boolean" },
            ],
          },
        },
      });
      const request = yield* nextEvent((event) => event.type === "user-input.requested");

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("form-values"), {
        "question-0-selected": "Production",
        "question-1-custom": { _tag: "custom", value: "Production" },
        "question-2-regions": ["North America", "Europe"],
        "question-3-count": "3",
        "question-4-enabled": "true",
      });

      NodeAssert.equal(request.type, "user-input.requested");
      if (request.type === "user-input.requested") {
        NodeAssert.equal(request.payload.questions[0]?.customAnswerOrigin, "tagged");
        NodeAssert.equal(request.payload.questions[1]?.customAnswerOrigin, "tagged");
        NodeAssert.equal(request.payload.questions[2]?.multiSelect, true);
        NodeAssert.equal(request.payload.questions[3]?.customAnswerOrigin, undefined);
      }
      NodeAssert.deepEqual(state.formReplies, [
        {
          sessionID: state.sessionID,
          formID: "form-values",
          answer: {
            selected: "prod",
            custom: "Production",
            regions: ["na", "eu"],
            count: 3,
            enabled: true,
          },
        },
      ]);
    }),
  );
});
