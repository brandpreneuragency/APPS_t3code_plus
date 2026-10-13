import { it } from "@effect/vitest";
import {
  OpenCodeAccountError,
  ProviderInstanceId,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";
import { makeOpenCodeAccountManagement } from "./OpenCodeAccountManagement.ts";
import * as OpenCodeWorkGuard from "./OpenCodeWorkGuard.ts";

interface TestCredential {
  readonly type: "credential";
  readonly id: string;
  readonly label: string;
  readonly method: "key" | "oauth";
}

interface TestEnvironmentConnection {
  readonly type: "env";
  readonly name: string;
}

type TestConnection = TestCredential | TestEnvironmentConnection;

const initialConnections: ReadonlyArray<TestConnection> = [
  { type: "credential", id: "credential-a", label: "alice@example.com", method: "oauth" },
  { type: "env", name: "OPENAI_API_KEY" },
  { type: "credential", id: "credential-b", label: "sk-live-secret-value", method: "key" },
];

const makeFixture = (options?: {
  readonly activeSessions?: Readonly<Record<string, { readonly type: "running" }>>;
  readonly pendingForms?: ReadonlyArray<{ readonly id: string }>;
  readonly failActivateAfterMutation?: boolean;
  readonly failReadback?: boolean;
  readonly protocol?: "v1" | "v2";
}) =>
  Effect.gen(function* () {
    let connections: ReadonlyArray<TestConnection> = initialConnections;
    let activeSessions: Readonly<Record<string, { readonly type: "running" }>> =
      options?.activeSessions ?? {};
    let pendingForms: ReadonlyArray<{ readonly id: string }> = options?.pendingForms ?? [];
    let failNextReadback = false;
    let integrationReads = 0;
    let activationCalls = 0;
    const client = {
      integration: {
        get: async () => {
          integrationReads += 1;
          if (failNextReadback) {
            failNextReadback = false;
            throw new Error("readback unavailable");
          }
          return {
            data: {
              id: "openai",
              name: "OpenAI",
              methods: [],
              connections,
            },
          };
        },
      },
      credential: {
        activate: async (input: { readonly credentialID: string }) => {
          activationCalls += 1;
          const selected = connections.find(
            (connection): connection is TestCredential =>
              connection.type === "credential" && connection.id === input.credentialID,
          );
          if (!selected) throw new Error("credential not found");
          connections = [selected, ...connections.filter((connection) => connection !== selected)];
          if (options?.failActivateAfterMutation) {
            failNextReadback = options.failReadback === true;
            throw new Error("activation response lost");
          }
        },
      },
      session: {
        active: async () => activeSessions,
      },
      permission: {
        request: {
          list: async () => ({ data: [] }),
        },
      },
      form: {
        list: async () => ({ data: pendingForms }),
      },
    };
    const connection = {
      url: "https://opencode.example",
      version: options?.protocol === "v1" ? "1.18.33" : "2.0.18",
      protocol: options?.protocol ?? "v2",
      exitCode: null,
      external: true,
    };
    const runtime = {
      connectToOpenCodeServer: () => Effect.succeed(connection),
      createOpenCodeV2Client: () => client,
    } as unknown as OpenCodeRuntimeShape;
    const owner = {
      withServer: () => Effect.die("local server is not used in this test"),
    } as unknown as OpenCodeServerOwner.OpenCodeServerOwner["Service"];
    const workGuard = yield* OpenCodeWorkGuard.make;
    const settings = {
      binaryPath: "opencode",
      serverUrl: connection.url,
      serverPassword: "test-password",
    } as OpenCodeSettings;
    const management = yield* makeOpenCodeAccountManagement({
      instanceId: ProviderInstanceId.make("opencode_test"),
      settings,
      environment: { OPENCODE_SERVER_PASSWORD: "instance-password" },
      workGuard,
    }).pipe(
      Effect.provideService(OpenCodeRuntime, runtime),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "C:/workspace",
      } as ServerConfig.ServerConfig["Service"]),
      Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, owner),
    );

    return {
      management,
      workGuard,
      setActiveSessions: (value: Readonly<Record<string, { readonly type: "running" }>>) => {
        activeSessions = value;
      },
      setPendingForms: (value: ReadonlyArray<{ readonly id: string }>) => {
        pendingForms = value;
      },
      registerNativeContext: (threadId: string, ownerId: string, sessionId: string) =>
        workGuard.registerNativeWorkRevalidator(
          threadId,
          ownerId,
          Effect.gen(function* () {
            const nativeBusy = activeSessions[sessionId] !== undefined || pendingForms.length > 0;
            if (!nativeBusy) yield* workGuard.endThread(threadId, ownerId);
          }),
        ),
      getActivationCalls: () => activationCalls,
      getIntegrationReads: () => integrationReads,
    };
  });

it.effect("lists only OpenAI credential records with safe labels and the verified active ID", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const state = yield* fixture.management.list;

    expect(state.support).toBe("supported");
    expect(state.accounts.map((account) => account.credentialId)).toEqual([
      "credential-a",
      "credential-b",
    ]);
    expect(state.accounts[0]?.label).not.toContain("alice@example.com");
    expect(state.accounts[1]?.label).not.toContain("sk-live-secret-value");
    expect(state.activeCredentialId).toBe("credential-a");
    expect(state.activeKnown).toBe(true);
    expect(state.busy).toBe(false);
    expect(state.accounts.map((account) => account.label)).not.toContain("OPENAI_API_KEY");
    expect(state.accounts.map((account) => account.label)).not.toContain("sk-live-secret-value");
  }),
);

it.effect("rejects another provider's credential without calling OpenCode activation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const error = yield* fixture.management
      .activate({ credentialId: "claude-credential" }, () => Effect.succeed("refreshed"))
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(OpenCodeAccountError);
    expect(error.reason).toBe("account_not_found");
    expect(fixture.getActivationCalls()).toBe(0);
  }),
);

it.effect("rejects a stale active-account expectation before mutating credentials", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const error = yield* fixture.management
      .activate(
        {
          credentialId: "credential-b",
          expectedActiveCredentialId: "credential-stale",
        },
        () => Effect.succeed("refreshed"),
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("conflict");
    expect(fixture.getActivationCalls()).toBe(0);
  }),
);

it.effect("blocks activation while T3 work or an external V2 session is active", () =>
  Effect.gen(function* () {
    const local = yield* makeFixture();
    yield* local.workGuard.beginTurn("thread-busy");
    const localError = yield* local.management
      .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
      .pipe(Effect.flip);
    expect(localError.reason).toBe("busy");
    expect(local.getIntegrationReads()).toBe(0);

    const external = yield* makeFixture({
      activeSessions: { "session-running": { type: "running" } },
    });
    const externalError = yield* external.management
      .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
      .pipe(Effect.flip);
    expect(externalError.reason).toBe("busy");
    expect(external.getActivationCalls()).toBe(0);
  }),
);

it.effect(
  "revalidates settled native forms before activation and preserves other guard owners",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ pendingForms: [{ id: "form-external" }] });
      const nativeOwner = "route-form:native:session-form";
      yield* fixture.workGuard.beginTurn("thread-form", nativeOwner);
      yield* fixture.registerNativeContext("thread-form", nativeOwner, "session-form");

      const pendingError = yield* fixture.management
        .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
        .pipe(Effect.flip);
      expect(pendingError.reason).toBe("busy");
      expect(yield* fixture.workGuard.isBusy).toBe(true);
      expect(fixture.getActivationCalls()).toBe(0);

      fixture.setPendingForms([]);
      fixture.setActiveSessions({ "session-form": { type: "running" } });
      const runningError = yield* fixture.management
        .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
        .pipe(Effect.flip);
      expect(runningError.reason).toBe("busy");
      expect(yield* fixture.workGuard.isBusy).toBe(true);
      expect(fixture.getActivationCalls()).toBe(0);

      fixture.setActiveSessions({});
      yield* fixture.workGuard.beginTurn("thread-other", "route-other");
      const otherOwnerError = yield* fixture.management
        .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
        .pipe(Effect.flip);
      expect(otherOwnerError.reason).toBe("busy");
      expect(yield* fixture.workGuard.isBusy).toBe(true);
      expect(fixture.getActivationCalls()).toBe(0);

      yield* fixture.workGuard.endThread("thread-other", "route-other");
      const result = yield* fixture.management.activate({ credentialId: "credential-b" }, () =>
        Effect.succeed("refreshed"),
      );
      expect(result.activation).toBe("activated");
      expect(yield* fixture.workGuard.isBusy).toBe(false);
      expect(fixture.getActivationCalls()).toBe(1);
    }),
);

it.effect("reconciles a lost activation response by reading OpenCode again without retrying", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ failActivateAfterMutation: true });
    let refreshCalls = 0;
    const result = yield* fixture.management.activate(
      {
        credentialId: "credential-b",
        expectedActiveCredentialId: "credential-a",
      },
      () => {
        refreshCalls += 1;
        return Effect.succeed("refreshed");
      },
    );

    expect(fixture.getActivationCalls()).toBe(1);
    expect(fixture.getIntegrationReads()).toBe(2);
    expect(result.activation).toBe("activated");
    expect(result.state.activeCredentialId).toBe("credential-b");
    expect(result.state.activeKnown).toBe(true);
    expect(result.catalogRefresh).toBe("refreshed");
    expect(refreshCalls).toBe(1);
  }),
);

it.effect(
  "returns explicit unknown active state when both activation and readback are ambiguous",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        failActivateAfterMutation: true,
        failReadback: true,
      });
      const result = yield* fixture.management.activate({ credentialId: "credential-b" }, () =>
        Effect.succeed("failed"),
      );

      expect(fixture.getActivationCalls()).toBe(1);
      expect(result.activation).toBe("unknown");
      expect(result.state.activeKnown).toBe(false);
      expect(result.state.activeCredentialId).toBe(null);
      expect(result.catalogRefresh).toBe("failed");
    }),
);

it.effect("keeps V1 usable without advertising account switching", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ protocol: "v1" });
    const state = yield* fixture.management.list;
    const error = yield* fixture.management
      .activate({ credentialId: "credential-b" }, () => Effect.succeed("refreshed"))
      .pipe(Effect.flip);

    expect(state.support).toBe("unsupported");
    expect(state.accounts).toEqual([]);
    expect(state.activeKnown).toBe(false);
    expect(error.reason).toBe("unsupported");
    expect(fixture.getActivationCalls()).toBe(0);
  }),
);

it.effect("serializes simultaneous account selections from multiple clients", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const activate = () =>
      fixture.management.activate(
        {
          credentialId: "credential-b",
          expectedActiveCredentialId: "credential-a",
        },
        () => Effect.succeed("refreshed"),
      );

    const outcomes = yield* Effect.all([Effect.result(activate()), Effect.result(activate())], {
      concurrency: 2,
    });
    const successes = outcomes.filter(Result.isSuccess);
    const conflict = outcomes.find(
      (outcome) => Result.isFailure(outcome) && outcome.failure.reason === "conflict",
    );

    expect(successes).toHaveLength(1);
    expect(conflict && Result.isFailure(conflict) ? conflict.failure.reason : undefined).toBe(
      "conflict",
    );
    expect(fixture.getActivationCalls()).toBe(1);
  }),
);
