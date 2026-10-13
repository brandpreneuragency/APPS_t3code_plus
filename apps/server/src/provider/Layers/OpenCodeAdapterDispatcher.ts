import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
} from "../opencodeRuntime.ts";
import {
  makeOpenCodeAdapter as makeOpenCodeV1Adapter,
  type OpenCodeAdapterLiveOptions,
} from "./OpenCodeAdapter.ts";
import { makeOpenCodeV2Adapter } from "./OpenCodeV2Adapter.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);

interface OpenCodeSessionRoute {
  readonly adapter: OpenCodeAdapterShape;
  readonly scope: Scope.Closeable;
  readonly ownerId: string;
  readonly protocol: "v1" | "v2";
  readonly exitCode: Effect.Effect<number, never> | null;
  stopping: boolean;
}

export function makeOpenCodeAdapter(
  settings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const adapterScope = yield* Scope.make();
    const routes = new Map<ThreadId, OpenCodeSessionRoute>();
    const workGuard = options?.workGuard;

    const closeRoute = (threadId: ThreadId, route: OpenCodeSessionRoute) =>
      Effect.gen(function* () {
        if (route.stopping) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "The OpenCode session route is already stopping.",
          });
        }
        route.stopping = true;
        const stopExit = yield* Effect.exit(route.adapter.stopAll());
        if (route.exitCode === null && Exit.isFailure(stopExit)) {
          route.stopping = false;
          return yield* Effect.failCause(stopExit.cause);
        }
        yield* Scope.close(route.scope, Exit.void).pipe(Effect.ignore);
        if (route.exitCode !== null) yield* route.exitCode;
        if (routes.get(threadId) === route) routes.delete(threadId);
        yield* workGuard?.endThread(threadId, route.ownerId) ?? Effect.void;
      });

    const getRoute = (threadId: ThreadId) => {
      const route = routes.get(threadId);
      return route
        ? Effect.succeed(route)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn(
      "OpenCodeAdapterDispatcher.startSession",
    )(function* (input) {
      const existing = routes.get(input.threadId);
      if (existing) {
        if (existing.stopping) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "The OpenCode session route is stopping. Retry after it has closed.",
          });
        }
        if (
          existing.protocol === "v2" ||
          (yield* existing.adapter.hasSession(input.threadId))
        ) {
          return yield* existing.adapter.startSession(input);
        }
        yield* closeRoute(input.threadId, existing);
      }

      const scope = yield* Scope.make();
      const serverExit = yield* Effect.exit(
        runtime.connectToOpenCodeServer({
          binaryPath: settings.binaryPath,
          directory: input.cwd ?? serverConfig.cwd,
          serverUrl: settings.serverUrl,
          ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      if (Exit.isFailure(serverExit)) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: openCodeRuntimeErrorDetail(Cause.squash(serverExit.cause)),
          cause: serverExit.cause,
        });
      }

      const serverConnection = serverExit.value;
      const ownerId = `${instanceId}:${NodeCrypto.randomUUID()}`;
      const adapterOptions = {
        ...options,
        instanceId,
        serverConnection,
        workGuardOwnerId: ownerId,
      } satisfies OpenCodeAdapterLiveOptions & { readonly workGuardOwnerId: string };
      const adapterExit = yield* Effect.exit(
        (serverConnection.protocol === "v2"
          ? makeOpenCodeV2Adapter(settings, adapterOptions)
          : makeOpenCodeV1Adapter(settings, adapterOptions)
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(OpenCodeRuntime, runtime),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      if (Exit.isFailure(adapterExit)) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        return yield* Effect.failCause(adapterExit.cause);
      }

      const adapter = adapterExit.value;
      const startExit = yield* Effect.exit(adapter.startSession(input));
      if (Exit.isFailure(startExit)) {
        yield* adapter.stopAll().pipe(Effect.catchCause(() => Effect.void));
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        return yield* Effect.failCause(startExit.cause);
      }
      const route: OpenCodeSessionRoute = {
        adapter,
        scope,
        ownerId,
        protocol: serverConnection.protocol === "v2" ? "v2" : "v1",
        exitCode: serverConnection.exitCode,
        stopping: false,
      };
      routes.set(input.threadId, route);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (workGuard) {
              switch (event.type) {
                case "turn.started":
                  yield* workGuard.beginTurn(event.threadId, route.ownerId);
                  break;
                case "turn.completed":
                case "turn.aborted":
                  yield* workGuard.endTurn(event.threadId, route.ownerId);
                  break;
                case "request.opened":
                case "user-input.requested":
                  if (event.requestId) {
                    yield* workGuard.setPendingRequest(
                      event.threadId,
                      event.requestId,
                      true,
                      route.ownerId,
                    );
                  }
                  break;
                case "request.resolved":
                case "user-input.resolved":
                  if (event.requestId) {
                    yield* workGuard.setPendingRequest(
                      event.threadId,
                      event.requestId,
                      false,
                      route.ownerId,
                    );
                  }
                  break;
                case "session.exited":
                  yield* workGuard.endThread(event.threadId, route.ownerId);
                  break;
                default:
                  break;
              }
            }
            if (routes.get(event.threadId) === route) yield* Queue.offer(events, event);
            if (event.type === "session.exited" && route.exitCode !== null && !route.stopping) {
              if (routes.get(event.threadId) === route) routes.delete(event.threadId);
              yield* Scope.close(route.scope, Exit.void).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkIn(adapterScope),
      );
      return startExit.value;
    });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn(
      "OpenCodeAdapterDispatcher.sendTurn",
    )(function* (input) {
      const route = yield* getRoute(input.threadId);
      let newlyAdmitted = false;
      if (workGuard) newlyAdmitted = yield* workGuard.beginTurn(input.threadId, route.ownerId);
      const sent = yield* Effect.exit(route.adapter.sendTurn(input));
      if (Exit.isFailure(sent)) {
        const error = Cause.squash(sent.cause);
        const definitelyNotSubmitted =
          isProviderAdapterValidationError(error) ||
          isProviderAdapterSessionNotFoundError(error) ||
          (isProviderAdapterRequestError(error) && error.method !== "session.prompt");
        if (newlyAdmitted && definitelyNotSubmitted) {
          yield* workGuard?.endTurn(input.threadId, route.ownerId) ?? Effect.void;
        }
        return yield* Effect.failCause(sent.cause);
      }
      return sent.value;
    });
    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.flatMap(getRoute(threadId), (route) => route.adapter.interruptTurn(threadId, turnId));
    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.flatMap(getRoute(threadId), (route) =>
        route.adapter.respondToRequest(threadId, requestId, decision),
      );
    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.flatMap(getRoute(threadId), (route) =>
        route.adapter.respondToUserInput(threadId, requestId, answers),
      );
    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.flatMap(getRoute(threadId), (route) => closeRoute(threadId, route));
    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.all([...routes.values()].map((route) => route.adapter.listSessions())).pipe(
        Effect.map((sessionsByRoute) => sessionsByRoute.flat()),
      );
    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) => {
      const route = routes.get(threadId);
      return route ? route.adapter.hasSession(threadId) : Effect.succeed(false);
    };
    const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
      Effect.flatMap(getRoute(threadId), (route) => route.adapter.readThread(threadId));
    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.flatMap(getRoute(threadId), (route) => route.adapter.rollbackThread(threadId, numTurns));
    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        [...routes.entries()],
        ([threadId, route]) =>
          closeRoute(threadId, route),
        { concurrency: "unbounded", discard: true },
      );

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
