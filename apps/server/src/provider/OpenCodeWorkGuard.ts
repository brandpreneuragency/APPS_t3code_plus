import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export interface OpenCodeWorkGuardShape {
  /** Serialize work admission and account transitions for this T3 environment. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly beginTurn: (threadId: string, ownerId?: string) => Effect.Effect<boolean>;
  readonly endTurn: (threadId: string, ownerId?: string) => Effect.Effect<void>;
  readonly setPendingRequest: (
    threadId: string,
    requestId: string,
    pending: boolean,
    ownerId?: string,
  ) => Effect.Effect<void>;
  readonly endThread: (threadId: string, ownerId?: string) => Effect.Effect<void>;
  readonly registerNativeWorkRevalidator: (
    threadId: string,
    ownerId: string,
    revalidate: Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly revalidateNativeContexts: Effect.Effect<void>;
  readonly isBusy: Effect.Effect<boolean>;
  readonly runTextGeneration: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class OpenCodeWorkGuard extends Context.Service<OpenCodeWorkGuard, OpenCodeWorkGuardShape>()(
  "t3/provider/OpenCodeWorkGuard",
) {}

export const make = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  const activeTurns = new Map<string, { readonly threadId: string; readonly ownerId: string }>();
  const pendingRequests = new Map<
    string,
    { readonly threadId: string; readonly ownerId: string }
  >();
  const nativeWorkRevalidators = new Map<
    string,
    {
      readonly threadId: string;
      readonly ownerId: string;
      readonly revalidate: Effect.Effect<void>;
    }
  >();
  let activeTextGenerations = 0;

  const withLock: OpenCodeWorkGuardShape["withLock"] = (effect) => semaphore.withPermit(effect);
  const isBusy: OpenCodeWorkGuardShape["isBusy"] = Effect.sync(
    () => activeTurns.size > 0 || pendingRequests.size > 0 || activeTextGenerations > 0,
  );

  const keyFor = (threadId: string, ownerId: string, requestId?: string) =>
    `${threadId}\u0000${ownerId}\u0000${requestId ?? ""}`;
  const beginTurn: OpenCodeWorkGuardShape["beginTurn"] = (threadId, ownerId = threadId) =>
    withLock(
      Effect.sync(() => {
        const key = keyFor(threadId, ownerId);
        const newlyAdmitted = !activeTurns.has(key);
        activeTurns.set(key, { threadId, ownerId });
        return newlyAdmitted;
      }),
    );
  const endTurn: OpenCodeWorkGuardShape["endTurn"] = (threadId, ownerId = threadId) =>
    withLock(
      Effect.sync(() => {
        activeTurns.delete(keyFor(threadId, ownerId));
        nativeWorkRevalidators.delete(keyFor(threadId, ownerId));
      }),
    ).pipe(Effect.asVoid);
  const setPendingRequest: OpenCodeWorkGuardShape["setPendingRequest"] = (
    threadId,
    requestId,
    pending,
    ownerId = threadId,
  ) =>
    withLock(
      Effect.sync(() => {
        const key = keyFor(threadId, ownerId, requestId);
        if (pending) pendingRequests.set(key, { threadId, ownerId });
        else pendingRequests.delete(key);
      }),
    );
  const isOwnedBy = (ownerId: string, requestedOwnerId: string) =>
    ownerId === requestedOwnerId || ownerId.startsWith(`${requestedOwnerId}:native:`);
  const registerNativeWorkRevalidator: OpenCodeWorkGuardShape["registerNativeWorkRevalidator"] = (
    threadId,
    ownerId,
    revalidate,
  ) =>
    withLock(
      Effect.sync(() =>
        nativeWorkRevalidators.set(keyFor(threadId, ownerId), { threadId, ownerId, revalidate }),
      ),
    ).pipe(Effect.asVoid);
  const revalidateNativeContexts: OpenCodeWorkGuardShape["revalidateNativeContexts"] = Effect.gen(
    function* () {
      const revalidators = yield* withLock(
        Effect.sync(() => [...nativeWorkRevalidators.values()].map(({ revalidate }) => revalidate)),
      );
      yield* Effect.forEach(revalidators, (revalidate) => Effect.exit(revalidate), {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );
  const endThread: OpenCodeWorkGuardShape["endThread"] = (threadId, ownerId) =>
    withLock(
      Effect.sync(() => {
        for (const [key, owner] of activeTurns) {
          if (
            owner.threadId === threadId &&
            (ownerId === undefined || isOwnedBy(owner.ownerId, ownerId))
          ) {
            activeTurns.delete(key);
          }
        }
        for (const [key, owner] of pendingRequests) {
          if (
            owner.threadId === threadId &&
            (ownerId === undefined || isOwnedBy(owner.ownerId, ownerId))
          ) {
            pendingRequests.delete(key);
          }
        }
        for (const [key, owner] of nativeWorkRevalidators) {
          if (
            owner.threadId === threadId &&
            (ownerId === undefined || isOwnedBy(owner.ownerId, ownerId))
          ) {
            nativeWorkRevalidators.delete(key);
          }
        }
      }),
    );
  const runTextGeneration: OpenCodeWorkGuardShape["runTextGeneration"] = (effect) =>
    Effect.uninterruptibleMask((restore) =>
      restore(withLock(Effect.sync(() => (activeTextGenerations += 1)))).pipe(
        Effect.andThen(
          restore(effect).pipe(
            Effect.ensuring(
              withLock(
                Effect.sync(() => (activeTextGenerations = Math.max(0, activeTextGenerations - 1))),
              ),
            ),
          ),
        ),
      ),
    );

  return OpenCodeWorkGuard.of({
    withLock,
    beginTurn,
    endTurn,
    setPendingRequest,
    endThread,
    registerNativeWorkRevalidator,
    revalidateNativeContexts,
    isBusy,
    runTextGeneration,
  });
});

export const layer = Layer.effect(OpenCodeWorkGuard, make);
