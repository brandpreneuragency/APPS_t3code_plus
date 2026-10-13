import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import { make } from "./OpenCodeWorkGuard.ts";

it.effect("keeps an account transition ahead of queued turn admission", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    const transitionEntered = yield* Deferred.make<void>();
    const releaseTransition = yield* Deferred.make<void>();
    const admissionRequested = yield* Deferred.make<void>();
    const admitted = yield* Deferred.make<void>();

    const transition = yield* guard
      .withLock(
        Deferred.succeed(transitionEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTransition)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(transitionEntered);

    const admission = yield* Effect.gen(function* () {
      yield* Deferred.succeed(admissionRequested, undefined);
      yield* guard.beginTurn("thread-1");
      yield* Deferred.succeed(admitted, undefined);
    }).pipe(Effect.forkChild);
    yield* Deferred.await(admissionRequested);
    expect(yield* guard.isBusy).toBe(false);

    yield* Deferred.succeed(releaseTransition, undefined);
    yield* Fiber.join(transition);
    yield* Deferred.await(admitted);
    yield* Fiber.join(admission);
    expect(yield* guard.isBusy).toBe(true);

    yield* guard.endTurn("thread-1");
    expect(yield* guard.isBusy).toBe(false);
  }),
);

it.effect("keeps pending approvals and utility generation busy until they finish", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    yield* guard.setPendingRequest("thread-1", "approval-1", true);
    expect(yield* guard.isBusy).toBe(true);
    yield* guard.setPendingRequest("thread-1", "approval-1", false);
    expect(yield* guard.isBusy).toBe(false);

    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const generation = yield* guard
      .runTextGeneration(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* guard.isBusy).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(generation);
    expect(yield* guard.isBusy).toBe(false);
  }),
);

it.effect("clears thread-scoped work when a provider session is stopped", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    yield* guard.beginTurn("thread-1");
    yield* guard.setPendingRequest("thread-1", "form-1", true);
    yield* guard.setPendingRequest("thread-2", "form-2", true);

    yield* guard.endThread("thread-1");
    expect(yield* guard.isBusy).toBe(true);

    yield* guard.endThread("thread-2");
    expect(yield* guard.isBusy).toBe(false);
  }),
);

it.effect("clears only the route lease that emitted an exit event", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    yield* guard.beginTurn("thread-1", "route-old");
    yield* guard.setPendingRequest("thread-1", "form-1", true, "route-old");
    yield* guard.beginTurn("thread-1", "route-old:native:session-1");
    yield* guard.setPendingRequest("thread-1", "form-2", true, "route-old:native:session-1");
    yield* guard.beginTurn("thread-1", "route-new");
    yield* guard.setPendingRequest("thread-1", "form-1", true, "route-new");
    yield* guard.beginTurn("thread-1", "route-oldish");
    yield* guard.beginTurn("thread-2", "route-other-thread");

    yield* guard.endThread("thread-1", "route-old");
    expect(yield* guard.isBusy).toBe(true);
    yield* guard.endThread("thread-1", "route-new");
    expect(yield* guard.isBusy).toBe(true);
    yield* guard.endThread("thread-1", "route-oldish");
    expect(yield* guard.isBusy).toBe(true);
    yield* guard.endThread("thread-2", "route-other-thread");
    expect(yield* guard.isBusy).toBe(false);
  }),
);

it.effect("revalidates a snapshot outside the lock and keeps unknown or unrelated owners", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    const nativeOwner = "route-a:native:session-1";
    const unknownOwner = "route-a:native:session-2";
    let confirmedIdleChecks = 0;
    let unknownChecks = 0;

    yield* guard.beginTurn("thread-1", "route-a");
    yield* guard.beginTurn("thread-1", nativeOwner);
    yield* guard.beginTurn("thread-1", unknownOwner);
    yield* guard.beginTurn("thread-1", "route-ab");
    yield* guard.registerNativeWorkRevalidator(
      "thread-1",
      nativeOwner,
      Effect.gen(function* () {
        confirmedIdleChecks += 1;
        yield* guard.endThread("thread-1", nativeOwner);
      }),
    );
    yield* guard.registerNativeWorkRevalidator(
      "thread-1",
      unknownOwner,
      Effect.sync(() => (unknownChecks += 1)).pipe(
        Effect.andThen(Effect.die("native state unavailable")),
      ),
    );

    yield* guard.revalidateNativeContexts;
    expect(confirmedIdleChecks).toBe(1);
    expect(unknownChecks).toBe(1);
    expect(yield* guard.isBusy).toBe(true);

    yield* guard.endThread("thread-1", "route-a");
    expect(yield* guard.isBusy).toBe(true);
    yield* guard.revalidateNativeContexts;
    expect(confirmedIdleChecks).toBe(1);
    expect(unknownChecks).toBe(1);

    yield* guard.endThread("thread-1", "route-ab");
    expect(yield* guard.isBusy).toBe(false);
  }),
);

it.effect("does not decrement another generation when queued admission is cancelled", () =>
  Effect.gen(function* () {
    const guard = yield* make;
    const generationStarted = yield* Deferred.make<void>();
    const releaseGeneration = yield* Deferred.make<void>();
    const transitionEntered = yield* Deferred.make<void>();
    const releaseTransition = yield* Deferred.make<void>();

    const running = yield* guard
      .runTextGeneration(
        Deferred.succeed(generationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseGeneration)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(generationStarted);

    const transition = yield* guard
      .withLock(
        Deferred.succeed(transitionEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTransition)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(transitionEntered);

    const cancelledAdmission = yield* guard.runTextGeneration(Effect.void).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(cancelledAdmission);
    yield* Deferred.succeed(releaseTransition, undefined);
    yield* Fiber.join(transition);

    expect(yield* guard.isBusy).toBe(true);
    yield* Deferred.succeed(releaseGeneration, undefined);
    yield* Fiber.join(running);
    expect(yield* guard.isBusy).toBe(false);
  }),
);
