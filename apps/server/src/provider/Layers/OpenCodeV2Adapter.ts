import * as NodeCrypto from "node:crypto";
import {
  EventId,
  type ItemLifecyclePayload,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import type {
  AgentInfo,
  FormField,
  FormField1,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionRequest,
  SessionMessageInfo,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
} from "../opencodeRuntime.ts";
import { buildOpenCodePermissionRules, toOpenCodePermissionReply } from "../opencodeRuntime.ts";
import { isSameOpenCodeDirectory, type OpenCodeAdapterLiveOptions } from "./OpenCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const V2_RESUME_VERSION = 2 as const;
const MESSAGE_PAGE_SIZE = 50;
type OpenCodeV2AdapterOptions = OpenCodeAdapterLiveOptions & {
  readonly workGuardOwnerId?: string;
};

type OpenCodeV2EmitInput = {
  readonly type: ProviderRuntimeEvent["type"];
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly payload: ProviderRuntimeEvent["payload"];
  readonly context?: OpenCodeV2SessionContext;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly raw?: unknown;
};

interface OpenCodeV2FormContext {
  readonly formId: string;
  readonly fields: ReadonlyArray<FormField | FormField1>;
  readonly questionIds: ReadonlyMap<string, string>;
}

interface OpenCodeV2SessionContext {
  session: ProviderSession;
  readonly client: OpenCodeClient;
  readonly serverExitCode: Effect.Effect<number, never> | null;
  readonly sessionId: string;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingForms: Map<string, OpenCodeV2FormContext>;
  readonly pendingRequestChanges: Map<string, number>;
  pendingRequestRevision: number;
  pendingRequestReconciliations: number;
  readonly toolNames: Map<string, string>;
  nativeWorkOwnerId: string | undefined;
  nativeWorkActivityRevision: number;
  readonly stopped: Ref.Ref<boolean>;
  readonly usable: Ref.Ref<boolean>;
  activeTurnId: TurnId | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  activeAssistantText: string;
}

type PendingRequestKind = "permission" | "form";

function notePendingRequestChange(
  context: OpenCodeV2SessionContext,
  kind: PendingRequestKind,
  requestId: string,
): void {
  const revision = ++context.pendingRequestRevision;
  if (context.pendingRequestReconciliations > 0) {
    context.pendingRequestChanges.set(`${kind}:${requestId}`, revision);
  }
}

function pendingRequestChangedSince(
  context: OpenCodeV2SessionContext,
  kind: PendingRequestKind,
  requestId: string,
  revision: number,
): boolean {
  return (context.pendingRequestChanges.get(`${kind}:${requestId}`) ?? 0) > revision;
}

function beginPendingRequestReconciliation(context: OpenCodeV2SessionContext): number {
  context.pendingRequestReconciliations += 1;
  return context.pendingRequestRevision;
}

function endPendingRequestReconciliation(context: OpenCodeV2SessionContext): void {
  context.pendingRequestReconciliations -= 1;
  if (context.pendingRequestReconciliations === 0) context.pendingRequestChanges.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseV2ResumeCursor(raw: unknown): {
  readonly sessionId?: string;
  readonly issue?: string;
} {
  if (!isRecord(raw)) return {};
  if (raw.schemaVersion === 1) {
    return { issue: "This thread has an OpenCode V1 session cursor. Reopen it with a V1 server." };
  }
  if (raw.schemaVersion !== V2_RESUME_VERSION) {
    if (raw.schemaVersion !== undefined) {
      return { issue: "This thread has an unsupported OpenCode session cursor." };
    }
    return {};
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
    return { issue: "The saved OpenCode V2 session cursor is missing its session ID." };
  }
  return { sessionId: raw.sessionId.trim() };
}

function permissionRules(runtimeMode: RuntimeMode) {
  return buildOpenCodePermissionRules(runtimeMode).map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
}

function nativeDefaultAgent(agents: ReadonlyArray<AgentInfo>): string | undefined {
  // OpenCode 2.0.18 returns its configured selectable default first. That
  // ordering also accounts for native fallback selection when no configured
  // default is valid, so do not substitute the adapter's own "build" guess.
  return agents.find((agent) => agent.mode !== "subagent" && !agent.hidden)?.id;
}

function toolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (["edit", "write", "patch"].some((part) => normalized.includes(part))) return "file_change";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("image")) return "image_view";
  if (["task", "agent", "subtask"].some((part) => normalized.includes(part))) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function requestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (action) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  const data: unknown = event.data;
  if (!isRecord(data)) return undefined;
  if (typeof data.sessionID === "string") return data.sessionID;
  if (
    event.type === "form.created" &&
    isRecord(data.form) &&
    typeof data.form.sessionID === "string"
  ) {
    return data.form.sessionID;
  }
  return undefined;
}

function parseSessionMessageText(value: unknown): string {
  if (!isRecord(value) || value.type !== "assistant" || !Array.isArray(value.content)) return "";
  return value.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

export function makeOpenCodeV2Adapter(
  settings: OpenCodeSettings,
  options?: OpenCodeV2AdapterOptions,
) {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const runtime = yield* OpenCodeRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeV2SessionContext>();
    const workGuard = options?.workGuard;

    const releaseNativeWork = Effect.fn("OpenCodeV2Adapter.releaseNativeWork")(function* (
      context: OpenCodeV2SessionContext,
      expectedOwnerId = context.nativeWorkOwnerId,
      expectedActivityRevision = context.nativeWorkActivityRevision,
      expectedPendingRequestRevision = context.pendingRequestRevision,
    ) {
      if (
        !workGuard ||
        !expectedOwnerId ||
        context.nativeWorkOwnerId !== expectedOwnerId ||
        context.nativeWorkActivityRevision !== expectedActivityRevision ||
        context.pendingRequestRevision !== expectedPendingRequestRevision
      ) {
        return false;
      }
      context.nativeWorkOwnerId = undefined;
      yield* workGuard.endThread(context.session.threadId, expectedOwnerId);
      return true;
    });

    const releaseNativeWorkIfIdle = Effect.fn("OpenCodeV2Adapter.releaseNativeWorkIfIdle")(
      function* (context: OpenCodeV2SessionContext, expectedOwnerId = context.nativeWorkOwnerId) {
        const expectedActivityRevision = context.nativeWorkActivityRevision;
        if (!expectedOwnerId || context.nativeWorkOwnerId !== expectedOwnerId) return;
        if (!(yield* Ref.get(context.usable))) {
          const reconciliation = yield* Effect.result(
            reconcileDisconnectedPendingRequests(context),
          );
          if (reconciliation._tag === "Failure") return;
        }
        if (
          context.nativeWorkOwnerId !== expectedOwnerId ||
          context.nativeWorkActivityRevision !== expectedActivityRevision
        ) {
          return;
        }
        const expectedPendingRequestRevision = context.pendingRequestRevision;
        const nativeWork = yield* Effect.result(readNativeWork(context));
        if (nativeWork._tag === "Success" && !nativeWork.success) {
          yield* releaseNativeWork(
            context,
            expectedOwnerId,
            expectedActivityRevision,
            expectedPendingRequestRevision,
          );
        }
      },
    );

    const emit = Effect.fn("OpenCodeV2Adapter.emit")(function* (input: OpenCodeV2EmitInput) {
      const { context: _context, itemId, requestId, raw, ...eventInput } = input;
      void _context;
      const event: ProviderRuntimeEvent = {
        eventId: EventId.make(NodeCrypto.randomUUID()),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        ...eventInput,
        ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
        ...(requestId ? { requestId: RuntimeRequestId.make(requestId) } : {}),
        ...(raw !== undefined
          ? { raw: { source: "opencode.sdk.event" as const, payload: raw } }
          : {}),
      } as ProviderRuntimeEvent;
      return yield* Queue.offer(events, event);
    });

    const listAllMessages = Effect.fn("OpenCodeV2Adapter.listAllMessages")(function* (
      context: OpenCodeV2SessionContext,
      order: "asc" | "desc",
    ) {
      const messages: Array<SessionMessageInfo> = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      while (true) {
        const response = yield* runOpenCodeSdk("message.list", () =>
          context.client.message.list({
            sessionID: context.sessionId,
            limit: MESSAGE_PAGE_SIZE,
            ...(cursor ? { cursor } : { order }),
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "message.list",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
        messages.push(...response.data);

        if (response.data.length === 0 || !response.cursor.next) return messages;
        if (seenCursors.has(response.cursor.next)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "message.list",
            detail: "OpenCode V2 returned a repeated message cursor.",
          });
        }
        seenCursors.add(response.cursor.next);
        cursor = response.cursor.next;
      }
    });

    const clearContext = (context: OpenCodeV2SessionContext) => {
      if (sessions.get(context.session.threadId) === context)
        sessions.delete(context.session.threadId);
    };

    const finishTurn = (
      context: OpenCodeV2SessionContext,
      state: "completed" | "failed" | "interrupted",
      errorMessage?: string,
      raw?: unknown,
    ) =>
      Effect.gen(function* () {
        const turnId = context.activeTurnId;
        if (!turnId) {
          yield* releaseNativeWorkIfIdle(context);
          return;
        }
        if (context.interruptRequestedTurnId === turnId) {
          context.interruptRequestedTurnId = undefined;
        }
        context.activeTurnId = undefined;
        const settledSession = { ...context.session };
        delete settledSession.activeTurnId;
        context.session = {
          ...settledSession,
          status: state === "failed" ? "error" : "ready",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          ...(state === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* emit({
          context,
          threadId: context.session.threadId,
          turnId,
          raw,
          type: "turn.completed",
          payload: { state, ...(errorMessage ? { errorMessage } : {}) },
        });
        context.activeAssistantText = "";
        yield* releaseNativeWorkIfIdle(context);
      });

    const publishForm = Effect.fn("OpenCodeV2Adapter.publishForm")(function* (
      context: OpenCodeV2SessionContext,
      form: {
        readonly id: string;
        readonly title: string;
        readonly fields: ReadonlyArray<FormField | FormField1>;
      },
      raw?: unknown,
    ) {
      const visibleFields = form.fields.filter((field) => !("hidden" in field && field.hidden));
      const questionIds = new Map<string, string>();
      const questions = visibleFields.map((field, index) => {
        const choices = "options" in field ? field.options : undefined;
        const id = `question-${index}-${field.key}`;
        questionIds.set(id, field.key);
        return {
          id,
          header: field.title?.trim() || field.key,
          question: field.description?.trim() || field.title?.trim() || form.title,
          options: (
            choices ??
            (field.type === "boolean"
              ? [
                  { label: "true", description: "Yes" },
                  { label: "false", description: "No" },
                ]
              : [])
          ).map((option) => ({
            label: option.label,
            description: option.description?.trim() || option.label,
          })),
          ...("custom" in field && field.custom ? { customAnswerOrigin: "tagged" as const } : {}),
          ...(field.type === "multiselect" ? { multiSelect: true } : {}),
        };
      });
      context.pendingForms.set(form.id, {
        formId: form.id,
        fields: visibleFields,
        questionIds,
      });
      if (questions.length === 0) {
        yield* emit({
          context,
          threadId: context.session.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          raw,
          type: "runtime.warning",
          payload: {
            message: "OpenCode requested a form with no visible fields.",
            detail: "T3 could not find any visible fields in this OpenCode form.",
          },
        });
        return;
      }
      yield* emit({
        context,
        threadId: context.session.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: form.id,
        raw,
        type: "user-input.requested",
        payload: { questions },
      });
    });

    const readNativeWork = Effect.fn("OpenCodeV2Adapter.readNativeWork")(function* (
      context: OpenCodeV2SessionContext,
    ) {
      const expectedOwnerId = context.nativeWorkOwnerId;
      const expectedActivityRevision = context.nativeWorkActivityRevision;
      const expectedPendingRequestRevision = context.pendingRequestRevision;
      const [activeSessions, permissions, forms] = yield* Effect.all(
        [
          runOpenCodeSdk("session.active", () => context.client.session.active()),
          runOpenCodeSdk("permission.request.list", () =>
            context.client.permission.request.list({ location: { directory: context.directory } }),
          ),
          runOpenCodeSdk("session.form.list", () =>
            context.client.session.form.list({ sessionID: context.sessionId }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return (
        context.nativeWorkOwnerId !== expectedOwnerId ||
        context.nativeWorkActivityRevision !== expectedActivityRevision ||
        context.pendingRequestRevision !== expectedPendingRequestRevision ||
        activeSessions[context.sessionId] !== undefined ||
        permissions.data.some((request) => request.sessionID === context.sessionId) ||
        forms.length > 0 ||
        context.pendingPermissions.size > 0 ||
        context.pendingForms.size > 0
      );
    });

    const holdNativeWork = Effect.fn("OpenCodeV2Adapter.holdNativeWork")(function* (
      context: OpenCodeV2SessionContext,
    ) {
      if (!workGuard) return;
      context.nativeWorkActivityRevision += 1;
      if (context.nativeWorkOwnerId) return;
      const ownerRoot =
        options?.workGuardOwnerId ?? `${instanceId}:native:${context.session.threadId}`;
      const ownerId = `${ownerRoot}:native:${context.sessionId}:${NodeCrypto.randomUUID()}`;
      context.nativeWorkOwnerId = ownerId;
      yield* workGuard.beginTurn(context.session.threadId, ownerId);
      yield* workGuard.registerNativeWorkRevalidator(
        context.session.threadId,
        ownerId,
        releaseNativeWorkIfIdle(context, ownerId),
      );
    });

    const restorePendingRequests = Effect.fn("OpenCodeV2Adapter.restorePendingRequests")(function* (
      context: OpenCodeV2SessionContext,
      snapshotRevision: number,
    ) {
      const permissions = yield* runOpenCodeSdk("permission.request.list", () =>
        context.client.permission.request.list({ location: { directory: context.directory } }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.request.list",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      const nativeForms = yield* runOpenCodeSdk("session.form.list", () =>
        context.client.session.form.list({ sessionID: context.sessionId }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.form.list",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      const forms: Array<{
        readonly id: string;
        readonly title: string;
        readonly fields: ReadonlyArray<FormField | FormField1>;
        readonly state: { readonly status: string };
      }> = [];
      for (const form of nativeForms) {
        const detail = yield* runOpenCodeSdk("session.form.get", () =>
          context.client.session.form.get({ sessionID: context.sessionId, formID: form.id }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.form.get",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
        if (detail.state.status === "pending") forms.push(detail);
      }

      const currentPermissions = permissions.data.filter(
        (request) => request.sessionID === context.sessionId,
      );
      const currentPermissionIds = new Set(currentPermissions.map((request) => request.id));
      // Snapshot before yielding so live Map mutations are not folded into this reconciliation.
      const pendingPermissionSnapshot = Array.from(context.pendingPermissions.values());
      for (const request of pendingPermissionSnapshot) {
        if (
          !currentPermissionIds.has(request.id) &&
          !pendingRequestChangedSince(context, "permission", request.id, snapshotRevision)
        ) {
          context.pendingPermissions.delete(request.id);
          notePendingRequestChange(context, "permission", request.id);
          yield* emit({
            context,
            threadId: context.session.threadId,
            requestId: request.id,
            type: "request.resolved",
            payload: {
              requestType: requestType(request.action),
              decision: "resolved",
              resolution: {},
            },
          });
        }
      }
      const currentFormIds = new Set(forms.map((form) => form.id));
      const pendingFormSnapshot = Array.from(context.pendingForms.values());
      for (const form of pendingFormSnapshot) {
        if (
          !currentFormIds.has(form.formId) &&
          !pendingRequestChangedSince(context, "form", form.formId, snapshotRevision)
        ) {
          context.pendingForms.delete(form.formId);
          notePendingRequestChange(context, "form", form.formId);
          yield* emit({
            context,
            threadId: context.session.threadId,
            requestId: form.formId,
            type: "user-input.resolved",
            payload: { answers: {} },
          });
        }
      }

      for (const request of currentPermissions) {
        if (pendingRequestChangedSince(context, "permission", request.id, snapshotRevision)) {
          continue;
        }
        context.pendingPermissions.set(request.id, request);
        notePendingRequestChange(context, "permission", request.id);
        yield* emit({
          context,
          threadId: context.session.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          requestId: request.id,
          type: "request.opened",
          payload: {
            requestType: requestType(request.action),
            ...(request.message ? { detail: request.message } : {}),
            args: { action: request.action, resources: request.resources },
          },
        });
      }
      for (const form of forms) {
        if (pendingRequestChangedSince(context, "form", form.id, snapshotRevision)) continue;
        notePendingRequestChange(context, "form", form.id);
        yield* publishForm(context, form);
      }
    });

    const reconcileDisconnectedPendingRequests = Effect.fn(
      "OpenCodeV2Adapter.reconcileDisconnectedPendingRequests",
    )(function* (context: OpenCodeV2SessionContext) {
      if (yield* Ref.get(context.usable)) return;
      const snapshotRevision = beginPendingRequestReconciliation(context);
      try {
        yield* restorePendingRequests(context, snapshotRevision);
      } finally {
        endPendingRequestReconciliation(context);
      }
    });

    const completeRecoveredTurn = Effect.fn("OpenCodeV2Adapter.completeRecoveredTurn")(function* (
      context: OpenCodeV2SessionContext,
      expectedActivityRevision?: number,
      expectedPendingRequestRevision?: number,
    ) {
      if (!context.activeTurnId) return;
      const messages = yield* Effect.result(
        runOpenCodeSdk("message.list", () =>
          context.client.message.list({
            sessionID: context.sessionId,
            order: "desc",
            limit: 1,
            type: "assistant",
          }),
        ),
      );
      if (
        expectedActivityRevision !== undefined &&
        (context.nativeWorkActivityRevision !== expectedActivityRevision ||
          context.nativeWorkOwnerId !== undefined ||
          (expectedPendingRequestRevision !== undefined &&
            context.pendingRequestRevision !== expectedPendingRequestRevision))
      ) {
        yield* holdNativeWork(context);
        context.session = {
          ...context.session,
          status: "running",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* emit({
          context,
          threadId: context.session.threadId,
          type: "runtime.warning",
          payload: {
            message: "OpenCode activity changed while T3 was restoring this session.",
            detail:
              "T3 kept the recovered turn active because the idle check became stale. Wait for OpenCode to confirm it is idle before trying again.",
          },
        });
        return;
      }
      if (messages._tag === "Failure") {
        const detail = openCodeRuntimeErrorDetail(messages.failure);
        yield* finishTurn(
          context,
          "failed",
          `OpenCode is idle, but its final assistant result could not be read: ${detail}`,
          messages.failure,
        );
        return;
      }
      const assistant = messages.success.data.find((message) => message.type === "assistant");
      if (assistant?.type !== "assistant") {
        yield* finishTurn(
          context,
          "failed",
          "OpenCode is idle, but no final assistant message was available after reconnecting.",
        );
        return;
      }
      if (assistant.error) {
        yield* finishTurn(context, "failed", assistant.error.message, assistant);
        return;
      }
      const finalText = parseSessionMessageText(assistant);
      const streamedText = context.activeAssistantText;
      const missingText =
        streamedText.length === 0
          ? finalText
          : finalText.startsWith(streamedText)
            ? finalText.slice(streamedText.length)
            : "";
      if (missingText) {
        yield* emit({
          context,
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId: assistant.id,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: missingText },
        });
      } else if (streamedText && !finalText.startsWith(streamedText)) {
        yield* emit({
          context,
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          type: "runtime.warning",
          payload: {
            message: "OpenCode's final text did not match the text already streamed.",
            detail: "T3 kept the streamed text without replaying a duplicate final answer.",
          },
        });
      }
      yield* finishTurn(context, "completed", undefined, assistant);
    });

    const handleEvent = Effect.fn("OpenCodeV2Adapter.handleEvent")(function* (
      context: OpenCodeV2SessionContext,
      event: OpenCodeEvent,
    ) {
      if (eventSessionId(event) !== context.sessionId) return;
      const isNativeActivityEvent =
        event.type === "session.text.delta" ||
        event.type === "session.reasoning.delta" ||
        event.type === "session.tool.input.started" ||
        event.type === "permission.asked" ||
        event.type === "form.created";
      if (isNativeActivityEvent) {
        if (context.activeTurnId) context.nativeWorkActivityRevision += 1;
        else yield* holdNativeWork(context);
      }
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "session.text.delta":
          context.activeAssistantText += event.data.delta;
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            itemId: event.data.assistantMessageID,
            raw: event,
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.data.delta,
              contentIndex: event.data.ordinal,
            },
          });
          break;
        case "session.reasoning.delta":
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            itemId: event.data.assistantMessageID,
            raw: event,
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.delta,
              contentIndex: event.data.ordinal,
            },
          });
          break;
        case "session.tool.input.started": {
          context.toolNames.set(event.data.id, event.data.name);
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            itemId: event.data.id,
            raw: event,
            type: "item.started",
            payload: {
              itemType: toolItemType(event.data.name),
              status: "inProgress",
              title: event.data.name,
            } as ItemLifecyclePayload,
          });
          break;
        }
        case "session.tool.called": {
          const name = context.toolNames.get(event.data.id) ?? "OpenCode tool";
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            itemId: event.data.id,
            raw: event,
            type: "item.updated",
            payload: {
              itemType: toolItemType(name),
              status: "inProgress",
              title: name,
              data: event.data.input,
            } as ItemLifecyclePayload,
          });
          break;
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const name = context.toolNames.get(event.data.id) ?? "OpenCode tool";
          const failed = event.type === "session.tool.failed";
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            itemId: event.data.id,
            raw: event,
            type: "item.completed",
            payload: {
              itemType: toolItemType(name),
              status: failed ? "failed" : "completed",
              title: name,
              data: event.data,
            },
          });
          context.toolNames.delete(event.data.id);
          break;
        }
        case "permission.asked": {
          const request = event.data;
          notePendingRequestChange(context, "permission", request.id);
          context.pendingPermissions.set(request.id, request);
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            requestId: request.id,
            raw: event,
            type: "request.opened",
            payload: {
              requestType: requestType(request.action),
              ...(request.message ? { detail: request.message } : {}),
              args: { action: request.action, resources: request.resources },
            },
          });
          break;
        }
        case "permission.replied": {
          notePendingRequestChange(context, "permission", event.data.requestID);
          const request = context.pendingPermissions.get(event.data.requestID);
          context.pendingPermissions.delete(event.data.requestID);
          if (request) {
            yield* emit({
              context,
              threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.data.requestID,
              raw: event,
              type: "request.resolved",
              payload: {
                requestType: requestType(request.action),
                decision: event.data.reply,
                resolution: event.data,
              },
            });
          }
          yield* releaseNativeWorkIfIdle(context);
          break;
        }
        case "form.created": {
          notePendingRequestChange(context, "form", event.data.form.id);
          yield* publishForm(context, event.data.form, event);
          break;
        }
        case "form.replied": {
          notePendingRequestChange(context, "form", event.data.id);
          const form = context.pendingForms.get(event.data.id);
          context.pendingForms.delete(event.data.id);
          if (form) {
            yield* emit({
              context,
              threadId,
              ...(turnId ? { turnId } : {}),
              requestId: form.formId,
              raw: event,
              type: "user-input.resolved",
              payload: { answers: event.data.answer },
            });
          }
          yield* releaseNativeWorkIfIdle(context);
          break;
        }
        case "form.cancelled": {
          notePendingRequestChange(context, "form", event.data.id);
          const form = context.pendingForms.get(event.data.id);
          context.pendingForms.delete(event.data.id);
          if (form) {
            yield* emit({
              context,
              threadId,
              ...(turnId ? { turnId } : {}),
              requestId: form.formId,
              raw: event,
              type: "user-input.resolved",
              payload: { answers: {} },
            });
          }
          yield* releaseNativeWorkIfIdle(context);
          break;
        }
        case "session.execution.succeeded":
          yield* finishTurn(context, "completed", undefined, event);
          break;
        case "session.execution.failed":
          yield* finishTurn(context, "failed", event.data.error.message, event);
          break;
        case "session.execution.interrupted":
          yield* finishTurn(context, "interrupted", undefined, event);
          break;
        case "session.idle":
          if (context.activeTurnId && context.interruptRequestedTurnId !== context.activeTurnId) {
            yield* finishTurn(context, "completed", undefined, event);
          } else {
            yield* releaseNativeWorkIfIdle(context);
          }
          break;
        case "session.retry.scheduled":
          yield* emit({
            context,
            threadId,
            ...(turnId ? { turnId } : {}),
            raw: event,
            type: "runtime.warning",
            payload: {
              message: "OpenCode is retrying the current request.",
              detail: event.data.error.message,
            },
          });
          break;
        default:
          break;
      }
    });

    const invalidateEventStream = Effect.fn("OpenCodeV2Adapter.invalidateEventStream")(function* (
      context: OpenCodeV2SessionContext,
      detail: string,
    ) {
      if ((yield* Ref.get(context.stopped)) || !(yield* Ref.getAndSet(context.usable, false))) {
        return;
      }
      context.session = {
        ...context.session,
        status: "error",
        lastError: detail,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* emit({
        context,
        threadId: context.session.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        type: "runtime.error",
        payload: {
          message:
            "OpenCode V2 event stream is unavailable. Resume the saved session to reconnect.",
          class: "transport_error",
          detail,
        },
      }).pipe(Effect.ignore);
    });

    const startEventPump = (context: OpenCodeV2SessionContext) => {
      const controller = new AbortController();
      return Scope.addFinalizer(
        context.scope,
        Effect.sync(() => controller.abort()),
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const stream = Stream.fromAsyncIterable(
              context.client.event.subscribe({ signal: controller.signal }),
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "event.subscribe",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            );
            const result = yield* Effect.exit(
              stream.pipe(Stream.runForEach((event) => handleEvent(context, event))),
            );
            if (controller.signal.aborted || (yield* Ref.get(context.stopped))) return;
            const detail =
              result._tag === "Failure"
                ? openCodeRuntimeErrorDetail(Cause.squash(result.cause))
                : "OpenCode V2 event stream ended unexpectedly.";
            yield* invalidateEventStream(context, detail);
          }).pipe(Effect.forkIn(context.scope)),
        ),
      );
    };

    const closeContext = (context: OpenCodeV2SessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) return;
        yield* Ref.set(context.usable, false);
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      });

    const emitUnexpectedExit = Effect.fn("OpenCodeV2Adapter.emitUnexpectedExit")(function* (
      context: OpenCodeV2SessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) return;
      yield* Ref.set(context.usable, false);
      const turnId = context.activeTurnId;
      if (turnId) yield* finishTurn(context, "failed", message);
      yield* releaseNativeWork(context);
      context.session = {
        ...context.session,
        status: "error",
        lastError: message,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      clearContext(context);
      yield* emit({
        context,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        type: "runtime.error",
        payload: { message, class: "transport_error" },
      }).pipe(Effect.ignore);
      yield* emit({
        context,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        type: "session.exited",
        payload: { reason: message, recoverable: false, exitKind: "error" },
      }).pipe(Effect.ignore);
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn(
      "OpenCodeV2Adapter.startSession",
    )(function* (input) {
      const resume = parseV2ResumeCursor(input.resumeCursor);
      if (resume.issue) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: resume.issue,
        });
      }
      const resumeSessionId = resume.sessionId;
      const directory = input.cwd ?? serverConfig.cwd;
      const existing = sessions.get(input.threadId);
      if (existing && !(yield* Ref.get(existing.stopped))) {
        const sameDirectory = yield* isSameOpenCodeDirectory(
          fileSystem,
          path,
          existing.directory,
          directory,
        );
        if (!sameDirectory) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "This OpenCode V2 session cannot move to a different working directory. Its saved session and history remain intact.",
          });
        }
        if (
          (resumeSessionId && resumeSessionId !== existing.sessionId) ||
          (!(yield* Ref.get(existing.usable)) && resumeSessionId !== existing.sessionId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "The saved OpenCode V2 session ID does not match the live session. Its existing session and history remain intact.",
          });
        }
        yield* runOpenCodeSdk("session.update", () =>
          existing.client.session.update({
            sessionID: existing.sessionId,
            permissions: permissionRules(input.runtimeMode),
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.update",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
        existing.session = {
          ...existing.session,
          runtimeMode: input.runtimeMode,
          cwd: directory,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!(yield* Ref.get(existing.usable))) {
          const snapshotRevision = beginPendingRequestReconciliation(existing);
          try {
            yield* startEventPump(existing);
            let expectedOwnerId = existing.nativeWorkOwnerId;
            let expectedActivityRevision = existing.nativeWorkActivityRevision;
            let expectedPendingRequestRevision = snapshotRevision;
            const nativeWork = yield* Effect.result(readNativeWork(existing));
            if (nativeWork._tag === "Failure") {
              yield* holdNativeWork(existing);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.active",
                detail: nativeWork.failure.detail,
                cause: nativeWork.failure.cause,
              });
            }
            let nativeBusy = nativeWork.success;
            let nativeStateUnconfirmed = false;
            if (nativeBusy) {
              yield* holdNativeWork(existing);
            } else {
              const releaseConfirmed = expectedOwnerId
                ? yield* releaseNativeWork(
                    existing,
                    expectedOwnerId,
                    expectedActivityRevision,
                    expectedPendingRequestRevision,
                  )
                : true;
              nativeBusy =
                !releaseConfirmed ||
                existing.nativeWorkActivityRevision !== expectedActivityRevision ||
                existing.pendingRequestRevision !== expectedPendingRequestRevision ||
                existing.nativeWorkOwnerId !== undefined;
              if (nativeBusy) {
                nativeStateUnconfirmed = true;
                yield* holdNativeWork(existing);
              }
            }
            yield* restorePendingRequests(existing, snapshotRevision);
            if (existing.pendingRequestRevision !== expectedPendingRequestRevision) {
              expectedOwnerId = existing.nativeWorkOwnerId;
              expectedActivityRevision = existing.nativeWorkActivityRevision;
              expectedPendingRequestRevision = existing.pendingRequestRevision;
              const refreshedNativeWork = yield* Effect.result(readNativeWork(existing));
              const proofStillCurrent =
                existing.nativeWorkActivityRevision === expectedActivityRevision &&
                existing.pendingRequestRevision === expectedPendingRequestRevision &&
                existing.nativeWorkOwnerId === expectedOwnerId;
              if (refreshedNativeWork._tag === "Failure") {
                nativeBusy = true;
                nativeStateUnconfirmed = true;
                yield* holdNativeWork(existing);
              } else if (refreshedNativeWork.success) {
                nativeBusy = true;
                nativeStateUnconfirmed = !proofStillCurrent;
                yield* holdNativeWork(existing);
              } else {
                const releaseConfirmed = expectedOwnerId
                  ? yield* releaseNativeWork(
                      existing,
                      expectedOwnerId,
                      expectedActivityRevision,
                      expectedPendingRequestRevision,
                    )
                  : true;
                nativeBusy =
                  !proofStillCurrent ||
                  !releaseConfirmed ||
                  existing.nativeWorkActivityRevision !== expectedActivityRevision ||
                  existing.pendingRequestRevision !== expectedPendingRequestRevision ||
                  existing.nativeWorkOwnerId !== undefined;
                if (nativeBusy) {
                  nativeStateUnconfirmed = true;
                  yield* holdNativeWork(existing);
                }
              }
            }
            if (
              !nativeBusy &&
              (existing.nativeWorkActivityRevision !== expectedActivityRevision ||
                existing.pendingRequestRevision !== expectedPendingRequestRevision ||
                existing.nativeWorkOwnerId !== undefined)
            ) {
              nativeBusy = true;
              nativeStateUnconfirmed = true;
              yield* holdNativeWork(existing);
            }
            existing.session = {
              ...existing.session,
              status: nativeBusy ? "running" : "ready",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* Ref.set(existing.usable, true);
            if (!nativeBusy && existing.activeTurnId) {
              yield* completeRecoveredTurn(
                existing,
                expectedActivityRevision,
                expectedPendingRequestRevision,
              );
            } else if (nativeBusy && !existing.activeTurnId) {
              yield* emit({
                context: existing,
                threadId: input.threadId,
                type: "runtime.warning",
                payload: {
                  message: nativeStateUnconfirmed
                    ? "OpenCode activity changed while T3 was confirming whether this session is idle."
                    : "This OpenCode session is active outside the current T3 turn.",
                  detail: nativeStateUnconfirmed
                    ? "T3 kept the session running because the idle check became stale. Wait for OpenCode to confirm that it is idle before sending another turn."
                    : "Wait for the OpenCode session to become idle before sending another turn.",
                },
              });
            }
          } finally {
            endPendingRequestReconciliation(existing);
          }
        }
        return existing.session;
      }
      if (existing) {
        yield* closeContext(existing);
        clearContext(existing);
      }

      const scope = yield* Scope.make();
      const startExit = yield* Effect.exit(
        Effect.gen(function* () {
          const server =
            options?.serverConnection ??
            (yield* runtime.connectToOpenCodeServer({
              binaryPath: settings.binaryPath,
              directory,
              serverUrl: settings.serverUrl,
              ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
              ...(options?.environment ? { environment: options.environment } : {}),
            }));
          if (!server.protocol || server.protocol !== "v2") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "OpenCode V2 adapter received a server that did not pass the V2 capability check.",
            });
          }
          const client = runtime.createOpenCodeV2Client({
            baseUrl: server.url,
            directory,
            ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
          });
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          if (mcpSession && !server.external) {
            yield* runOpenCodeSdk("mcp.add", () =>
              client.mcp.add({
                server: "t3-code",
                location: { directory },
                config: {
                  type: "remote",
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                  oauth: false,
                },
              }),
            );
          }

          const sessionInfo = resumeSessionId
            ? yield* runOpenCodeSdk("session.get", () =>
                client.session.get({ sessionID: resumeSessionId! }),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session.get",
                      detail: `Unable to resume OpenCode V2 session ${resumeSessionId}: ${openCodeRuntimeErrorDetail(cause)}`,
                      cause: cause.cause,
                    }),
                ),
              )
            : yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  ...(input.title ? { title: input.title } : {}),
                  location: { directory },
                  permissions: permissionRules(input.runtimeMode),
                }),
              );

          if (resumeSessionId) {
            const sameDirectory = yield* isSameOpenCodeDirectory(
              fileSystem,
              path,
              sessionInfo.location.directory,
              directory,
            );
            if (!sameDirectory) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue:
                  "This OpenCode V2 build cannot resume a thread after its working directory changes. The saved session remains intact.",
              });
            }
          }
          if (resumeSessionId) {
            yield* runOpenCodeSdk("session.update", () =>
              client.session.update({
                sessionID: sessionInfo.id,
                permissions: permissionRules(input.runtimeMode),
              }),
            );
          }
          return { server, client, sessionInfo };
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      if (Exit.isFailure(startExit)) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        const cause = Cause.squash(startExit.cause);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: openCodeRuntimeErrorDetail(cause),
          cause,
        });
      }

      const { server, client, sessionInfo } = startExit.value;
      const now = DateTime.formatIso(yield* DateTime.now);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: directory,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        resumeCursor: { schemaVersion: V2_RESUME_VERSION, sessionId: sessionInfo.id },
        createdAt: now,
        updatedAt: now,
      };
      const context: OpenCodeV2SessionContext = {
        session,
        client,
        serverExitCode: server.external ? null : server.exitCode,
        sessionId: sessionInfo.id,
        directory,
        scope,
        pendingPermissions: new Map(),
        pendingForms: new Map(),
        pendingRequestChanges: new Map(),
        pendingRequestRevision: 0,
        pendingRequestReconciliations: 0,
        toolNames: new Map(),
        nativeWorkOwnerId: undefined,
        nativeWorkActivityRevision: 0,
        stopped: yield* Ref.make(false),
        usable: yield* Ref.make(true),
        activeTurnId: undefined,
        interruptRequestedTurnId: undefined,
        activeAssistantText: "",
      };
      sessions.set(input.threadId, context);
      const resumeSnapshotRevision = resumeSessionId
        ? beginPendingRequestReconciliation(context)
        : undefined;
      try {
        yield* startEventPump(context);
        yield* emit({
          threadId: input.threadId,
          context,
          type: "session.started",
          payload: { message: "OpenCode V2 session started" },
        });
        yield* emit({
          threadId: input.threadId,
          context,
          type: "thread.started",
          payload: { providerThreadId: sessionInfo.id },
        });

        if (context.serverExitCode !== null) {
          yield* context.serverExitCode.pipe(
            Effect.flatMap((code) =>
              emitUnexpectedExit(context, `OpenCode V2 server exited unexpectedly (${code}).`),
            ),
            Effect.forkIn(context.scope),
          );
        }

        if (resumeSnapshotRevision !== undefined) {
          const restored = yield* Effect.result(
            restorePendingRequests(context, resumeSnapshotRevision),
          );
          if (restored._tag === "Failure") {
            yield* holdNativeWork(context);
            yield* emit({
              context,
              threadId: input.threadId,
              type: "runtime.warning",
              payload: {
                message: "OpenCode could not confirm whether the resumed session is idle.",
                detail: openCodeRuntimeErrorDetail(restored.failure),
              },
            });
          } else {
            const expectedOwnerId = context.nativeWorkOwnerId;
            const expectedActivityRevision = context.nativeWorkActivityRevision;
            const expectedPendingRequestRevision = context.pendingRequestRevision;
            const nativeWork = yield* Effect.result(readNativeWork(context));
            if (nativeWork._tag === "Failure") {
              yield* holdNativeWork(context);
              yield* emit({
                context,
                threadId: input.threadId,
                type: "runtime.warning",
                payload: {
                  message: "OpenCode could not confirm whether the resumed session is idle.",
                  detail: openCodeRuntimeErrorDetail(nativeWork.failure),
                },
              });
            } else {
              const proofStillCurrent =
                context.nativeWorkOwnerId === expectedOwnerId &&
                context.nativeWorkActivityRevision === expectedActivityRevision &&
                context.pendingRequestRevision === expectedPendingRequestRevision;
              if (nativeWork.success || !proofStillCurrent) {
                yield* holdNativeWork(context);
                yield* emit({
                  context,
                  threadId: input.threadId,
                  type: "runtime.warning",
                  payload: {
                    message: proofStillCurrent
                      ? "This OpenCode session is already active outside the current T3 turn."
                      : "OpenCode activity changed while T3 was confirming whether this session is idle.",
                    detail: proofStillCurrent
                      ? "Wait for the OpenCode session to become idle before sending another turn."
                      : "T3 kept the session running because the idle check became stale. Wait for OpenCode to confirm that it is idle before sending another turn.",
                  },
                });
              }
            }
          }
        }
        return context.session;
      } finally {
        if (resumeSnapshotRevision !== undefined) {
          endPendingRequestReconciliation(context);
        }
      }
    });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("OpenCodeV2Adapter.sendTurn")(
      function* (input) {
        const context = sessions.get(input.threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const modelSelection = input.modelSelection;
        if (modelSelection?.instanceId && modelSelection.instanceId !== instanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `OpenCode model selection is bound to instance '${modelSelection.instanceId}', expected '${instanceId}'.`,
          });
        }
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model ?? context.session.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }
        const text = input.input?.trim() ?? "";
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        });
        if (!text && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode turns require text input or at least one supported attachment.",
          });
        }
        const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
        const explicitAgent = getModelSelectionStringOptionValue(modelSelection, "agent");
        let agent = explicitAgent ?? (input.interactionMode === "plan" ? "plan" : undefined);
        if (!agent) {
          const available = yield* runOpenCodeSdk("agent.list", () =>
            context.client.agent.list({ location: { directory: context.directory } }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agent.list",
                  detail: cause.detail,
                  cause: cause.cause,
                }),
            ),
          );
          agent = nativeDefaultAgent(available.data);
        }
        if (!agent) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode did not return a selectable default agent for this directory.",
          });
        }
        yield* runOpenCodeSdk("session.switchAgent", () =>
          context.client.session.switchAgent({ sessionID: context.sessionId, agent }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.switchAgent",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
        const previousTurnId = context.activeTurnId;
        const turnId = previousTurnId ?? TurnId.make(`opencode-v2-${NodeCrypto.randomUUID()}`);
        context.activeTurnId = turnId;
        context.activeAssistantText = "";
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!previousTurnId) {
          context.interruptRequestedTurnId = undefined;
          yield* emit({
            context,
            threadId: input.threadId,
            turnId,
            type: "turn.started",
            payload: {
              model: modelSelection?.model ?? context.session.model,
              ...(variant ? { effort: variant } : {}),
            },
          });
        }
        const submit = Effect.gen(function* () {
          yield* runOpenCodeSdk("session.switchModel", () =>
            context.client.session.switchModel({
              sessionID: context.sessionId,
              model: {
                id: parsedModel.modelID,
                providerID: parsedModel.providerID,
                ...(variant ? { variant } : {}),
              },
            }),
          );
          yield* runOpenCodeSdk("session.prompt", () =>
            context.client.session.prompt({
              sessionID: context.sessionId,
              text,
              ...(fileParts.length > 0
                ? {
                    files: fileParts.map((part) => ({
                      uri: part.url,
                      ...(part.filename ? { name: part.filename } : {}),
                      description: part.mime,
                    })),
                  }
                : {}),
              ...(previousTurnId ? { delivery: "steer" as const } : {}),
            }),
          );
        });
        const submitResult = yield* Effect.result(submit);
        if (submitResult._tag === "Failure") {
          const detail = openCodeRuntimeErrorDetail(submitResult.failure);
          const nativeBusy = yield* Effect.result(readNativeWork(context));
          if (nativeBusy._tag === "Success" && !nativeBusy.success) {
            yield* finishTurn(context, "failed", detail);
          } else {
            yield* emit({
              context,
              threadId: input.threadId,
              turnId,
              type: "runtime.error",
              payload: {
                message: "OpenCode could not confirm whether the submitted turn is still active.",
                class: "transport_error",
                detail,
              },
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt",
            detail,
            cause: submitResult.failure,
          });
        }
        const completion = Effect.gen(function* () {
          yield* runOpenCodeSdk("session.wait", () =>
            context.client.session.wait({ sessionID: context.sessionId }),
          );
          if (!context.activeTurnId || context.activeTurnId !== turnId) return;
          if (context.interruptRequestedTurnId === turnId) return;
          const messages = yield* runOpenCodeSdk("message.list", () =>
            context.client.message.list({
              sessionID: context.sessionId,
              order: "desc",
              limit: 1,
              type: "assistant",
            }),
          );
          const assistant = messages.data.find((message) => message.type === "assistant");
          if (assistant?.type === "assistant" && assistant.error) {
            yield* finishTurn(context, "failed", assistant.error.message, assistant);
            return;
          }
          const finalText = assistant ? parseSessionMessageText(assistant) : "";
          if (finalText && context.activeAssistantText.length === 0) {
            yield* emit({
              context,
              threadId: input.threadId,
              turnId,
              ...(assistant ? { itemId: assistant.id } : {}),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: finalText },
            });
          }
          yield* finishTurn(context, "completed", undefined, assistant);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const detail = openCodeRuntimeErrorDetail(Cause.squash(cause));
              const nativeBusy = yield* Effect.result(readNativeWork(context));
              if (nativeBusy._tag === "Success" && !nativeBusy.success) {
                yield* finishTurn(context, "failed", detail, cause);
              }
              yield* emit({
                context,
                threadId: input.threadId,
                turnId,
                type: "runtime.error",
                payload: {
                  message:
                    nativeBusy._tag === "Success" && !nativeBusy.success
                      ? "OpenCode V2 turn completion could not be read."
                      : "OpenCode V2 may still be working; completion could not be confirmed.",
                  class: "transport_error",
                  detail,
                },
              });
            }),
          ),
          Effect.forkIn(context.scope),
        );
        yield* completion;
        return {
          threadId: input.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      },
    );

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn(
      "OpenCodeV2Adapter.interruptTurn",
    )(function* (threadId, turnId) {
      const context = sessions.get(threadId);
      if (!context)
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      if (turnId && context.activeTurnId !== turnId) return;
      const interruptingTurnId = context.activeTurnId;
      if (interruptingTurnId) context.interruptRequestedTurnId = interruptingTurnId;
      const interrupt = yield* Effect.exit(
        runOpenCodeSdk("session.interrupt", () =>
          context.client.session.interrupt({ sessionID: context.sessionId }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.interrupt",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        ),
      );
      if (Exit.isFailure(interrupt)) {
        if (context.interruptRequestedTurnId === interruptingTurnId) {
          context.interruptRequestedTurnId = undefined;
        }
        return yield* Effect.failCause(interrupt.cause);
      }
      if (!interrupt.value.interrupted && context.interruptRequestedTurnId === interruptingTurnId) {
        context.interruptRequestedTurnId = undefined;
      }
    });

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "OpenCodeV2Adapter.respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = sessions.get(threadId);
      const request = context?.pendingPermissions.get(requestId);
      if (!context || !request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending OpenCode V2 permission request: ${requestId}`,
        });
      }
      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          sessionID: context.sessionId,
          requestID: requestId,
          decision: toOpenCodePermissionReply(decision),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.reply",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      const pending = yield* runOpenCodeSdk("permission.request.list", () =>
        context.client.permission.request.list({ location: { directory: context.directory } }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.request.list",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      if (
        !pending.data.some(
          (entry) => entry.id === requestId && entry.sessionID === context.sessionId,
        )
      ) {
        notePendingRequestChange(context, "permission", requestId);
        context.pendingPermissions.delete(requestId);
        yield* emit({
          context,
          threadId,
          requestId,
          type: "request.resolved",
          payload: {
            requestType: requestType(request.action),
            decision: toOpenCodePermissionReply(decision),
            resolution: {},
          },
        });
      }
      yield* releaseNativeWorkIfIdle(context);
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "OpenCodeV2Adapter.respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = sessions.get(threadId);
      const form = context?.pendingForms.get(requestId);
      if (!context || !form) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.form.reply",
          detail: `Unknown pending OpenCode V2 form: ${requestId}`,
        });
      }
      const answer: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
      for (const [questionId, fieldKey] of form.questionIds) {
        const field = form.fields.find((candidate) => candidate.key === fieldKey);
        const raw = answers[questionId] ?? answers[fieldKey];
        if (!field || raw === undefined) continue;
        const customAnswer =
          isRecord(raw) && raw._tag === "custom" && typeof raw.value === "string"
            ? raw.value
            : undefined;
        if (field.type === "multiselect") {
          if (customAnswer !== undefined && field.custom) {
            answer[fieldKey] = [customAnswer];
          } else {
            const selected = Array.isArray(raw)
              ? raw.filter((value): value is string => typeof value === "string")
              : typeof raw === "string"
                ? [raw]
                : [];
            answer[fieldKey] = selected.map(
              (label) => field.options.find((option) => option.label === label)?.value ?? label,
            );
          }
        } else if (field.type === "boolean") {
          answer[fieldKey] = raw === true || raw === "true";
        } else if (field.type === "number" || field.type === "integer") {
          const value = typeof raw === "number" ? raw : Number(raw);
          if (Number.isFinite(value) && (field.type !== "integer" || Number.isInteger(value))) {
            answer[fieldKey] = value;
          }
        } else if (field.type === "string" && customAnswer !== undefined && field.custom) {
          answer[fieldKey] = customAnswer;
        } else if (typeof raw === "string") {
          answer[fieldKey] =
            "options" in field
              ? (field.options?.find((option) => option.label === raw)?.value ?? raw)
              : raw;
        } else if (Array.isArray(raw)) {
          answer[fieldKey] = raw.filter((value): value is string => typeof value === "string");
        }
      }
      yield* runOpenCodeSdk("session.form.reply", () =>
        context.client.session.form.reply({
          sessionID: context.sessionId,
          formID: form.formId,
          answer,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.form.reply",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      const pending = yield* runOpenCodeSdk("session.form.list", () =>
        context.client.session.form.list({ sessionID: context.sessionId }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.form.list",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      if (!pending.some((entry) => entry.id === requestId)) {
        notePendingRequestChange(context, "form", requestId);
        context.pendingForms.delete(requestId);
        yield* emit({
          context,
          threadId,
          requestId,
          type: "user-input.resolved",
          payload: { answers: answer },
        });
      }
      yield* releaseNativeWorkIfIdle(context);
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn(
      "OpenCodeV2Adapter.stopSession",
    )(function* (threadId) {
      const context = sessions.get(threadId);
      if (!context)
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });

      const expectedOwnerId = context.nativeWorkOwnerId;
      const expectedActivityRevision = context.nativeWorkActivityRevision;
      if (!(yield* Ref.get(context.usable))) {
        yield* reconcileDisconnectedPendingRequests(context);
      }
      if (
        context.nativeWorkOwnerId !== expectedOwnerId ||
        context.nativeWorkActivityRevision !== expectedActivityRevision
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.active",
          detail: "OpenCode activity changed while reconciling pending requests before stop.",
        });
      }
      const expectedPendingRequestRevision = context.pendingRequestRevision;
      const initialBusy = yield* readNativeWork(context).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.active",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      if (
        context.nativeWorkOwnerId !== expectedOwnerId ||
        context.nativeWorkActivityRevision !== expectedActivityRevision ||
        context.pendingRequestRevision !== expectedPendingRequestRevision
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.active",
          detail: "OpenCode activity changed while confirming whether the session is idle.",
        });
      }
      if (initialBusy) {
        const interrupt = yield* runOpenCodeSdk("session.interrupt", () =>
          context.client.session.interrupt({ sessionID: context.sessionId }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.interrupt",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
        if (!interrupt.interrupted) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.interrupt",
            detail: "OpenCode did not confirm that the session was interrupted.",
          });
        }
        yield* runOpenCodeSdk("session.wait", () =>
          context.client.session.wait({ sessionID: context.sessionId }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.wait",
                detail: cause.detail,
                cause: cause.cause,
              }),
          ),
        );
      }
      const finalOwnerId = context.nativeWorkOwnerId;
      const finalActivityRevision = context.nativeWorkActivityRevision;
      const finalPendingRequestRevision = context.pendingRequestRevision;
      const stillBusy = yield* readNativeWork(context).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.active",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      if (
        stillBusy ||
        context.nativeWorkOwnerId !== finalOwnerId ||
        context.nativeWorkActivityRevision !== finalActivityRevision ||
        context.pendingRequestRevision !== finalPendingRequestRevision
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.active",
          detail: "OpenCode still reports active work, pending requests, or changed activity after stop.",
        });
      }
      if (finalOwnerId) {
        const released = yield* releaseNativeWork(
          context,
          finalOwnerId,
          finalActivityRevision,
          finalPendingRequestRevision,
        );
        if (workGuard && !released) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.active",
            detail: "OpenCode activity changed before its native work owner could be released.",
          });
        }
      }

      for (const request of context.pendingPermissions.values()) {
        yield* emit({
          context,
          threadId,
          requestId: request.id,
          type: "request.resolved",
          payload: {
            requestType: requestType(request.action),
            decision: "cancelled",
            resolution: {},
          },
        });
      }
      for (const form of context.pendingForms.values()) {
        yield* emit({
          context,
          threadId,
          requestId: form.formId,
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      context.pendingPermissions.clear();
      context.pendingForms.clear();
      if (context.activeTurnId) yield* finishTurn(context, "interrupted");
      sessions.delete(threadId);
      yield* closeContext(context);
      yield* emit({
        context,
        threadId,
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
      });
    });

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));
    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        return context ? yield* Ref.get(context.usable) : false;
      });

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn(
      "OpenCodeV2Adapter.readThread",
    )(function* (threadId) {
      const context = sessions.get(threadId);
      if (!context)
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      const messages = yield* listAllMessages(context, "asc");
      return {
        threadId,
        turns: messages
          .filter((message) => message.type === "assistant")
          .map((message) => ({ id: TurnId.make(message.id), items: [message] })),
      };
    });

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn(
      "OpenCodeV2Adapter.rollbackThread",
    )(function* (threadId, numTurns) {
      const context = sessions.get(threadId);
      if (!context)
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      const messages = yield* listAllMessages(context, "asc");
      const assistants = messages.filter((message) => message.type === "assistant");
      const target = assistants[assistants.length - numTurns - 1];
      if (!target) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "T3's OpenCode V2 adapter cannot roll back past the first assistant turn.",
        });
      }
      yield* runOpenCodeSdk("session.revert.stage", () =>
        context.client.session.revert.stage({ sessionID: context.sessionId, messageID: target.id }),
      ).pipe(
        Effect.andThen(
          runOpenCodeSdk("session.revert.commit", () =>
            context.client.session.revert.commit({ sessionID: context.sessionId }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.revert",
              detail: cause.detail,
              cause: cause.cause,
            }),
        ),
      );
      return yield* readThread(threadId);
    });

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        concurrency: 1,
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(Queue.shutdown(events)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(events),
    } satisfies OpenCodeAdapterShape;
  });
}
