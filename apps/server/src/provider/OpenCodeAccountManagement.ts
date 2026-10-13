import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  OpenCodeAccountError,
  ProviderInstanceId,
  type OpenCodeAccountActivationResult,
  type OpenCodeAccountState,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import {
  isOpenCodeV2Server,
  runOpenCodeSdk,
  OpenCodeRuntime,
  type OpenCodeRuntimeError,
  type OpenCodeServerConnection,
} from "./opencodeRuntime.ts";
import type { OpenCodeWorkGuardShape } from "./OpenCodeWorkGuard.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import { ServerConfig } from "../config.ts";

type OpenCodeAccountManagementShape = {
  readonly list: Effect.Effect<OpenCodeAccountState, OpenCodeAccountError>;
  readonly activate: (
    input: {
      readonly credentialId: string;
      readonly expectedActiveCredentialId?: string | null;
    },
    refreshCatalog: () => Effect.Effect<"refreshed" | "failed">,
  ) => Effect.Effect<OpenCodeAccountActivationResult, OpenCodeAccountError>;
};

export type OpenCodeAccountManagement = OpenCodeAccountManagementShape;

type AccountConnection = Pick<
  OpenCodeServerConnection,
  "url" | "serverPassword" | "version" | "protocol"
>;

function isCredentialConnection(connection: { readonly type: string }): connection is {
  readonly type: "credential";
  readonly id: string;
  readonly label: string;
  readonly method: "key" | "oauth";
} {
  return connection.type === "credential";
}

function safeLabel(input: {
  readonly id: string;
  readonly label: string;
  readonly method: "key" | "oauth";
}): string {
  const label = input.label
    .trim()
    .replace(/\p{Cc}/gu, "")
    .slice(0, 120);
  const looksSensitive =
    label.includes("@") ||
    /(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/i.test(label) ||
    /\bBearer\s+\S+/i.test(label);
  if (label.length > 0 && !looksSensitive) return label;
  const suffix = NodeCrypto.createHash("sha256").update(input.id).digest("hex").slice(0, 6);
  return `OpenAI ${input.method === "oauth" ? "OAuth" : "API key"} · ${suffix}`;
}

export function makeOpenCodeAccountManagement(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly workGuard: OpenCodeWorkGuardShape;
}) {
  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime;
    const serverConfig = yield* ServerConfig;
    const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;
    const directory = serverConfig.cwd;
    const accountError = (reason: OpenCodeAccountError["reason"], message: string) =>
      new OpenCodeAccountError({ instanceId: input.instanceId, reason, message });

    const withOpenCodeServer = <A, E>(
      use: (server: AccountConnection) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | OpenCodeRuntimeError> =>
      input.settings.serverUrl.trim().length > 0
        ? runtime
            .connectToOpenCodeServer({
              binaryPath: input.settings.binaryPath,
              directory,
              serverUrl: input.settings.serverUrl,
              ...(input.settings.serverPassword
                ? { serverPassword: input.settings.serverPassword }
                : {}),
              environment: input.environment,
            })
            .pipe(Effect.flatMap(use), Effect.scoped)
        : serverOwner.withServer(use);

    const getClient = (server: AccountConnection) =>
      runtime.createOpenCodeV2Client({
        baseUrl: server.url,
        directory,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
      });

    const readIntegration = (server: AccountConnection) => {
      const client = getClient(server);
      return runOpenCodeSdk("integration.get", () =>
        client.integration.get({
          integrationID: "openai",
          location: { directory },
        }),
      ).pipe(Effect.map((response) => response.data));
    };

    const readBusy = (server: AccountConnection) => {
      const client = getClient(server);
      return Effect.all(
        [
          runOpenCodeSdk("session.active", () => client.session.active()),
          runOpenCodeSdk("permission.request.list", () => client.permission.request.list()),
          runOpenCodeSdk("form.list", () => client.form.list()),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          ([activeSessions, permissions, forms]) =>
            Object.keys(activeSessions).length > 0 ||
            permissions.data.length > 0 ||
            forms.data.length > 0,
        ),
      );
    };

    const makeState = (inputState: {
      readonly support: "supported" | "unsupported";
      readonly accounts?: OpenCodeAccountState["accounts"];
      readonly activeCredentialId?: string | null;
      readonly activeKnown: boolean;
      readonly busy: boolean;
      readonly detail?: string;
    }): OpenCodeAccountState => ({
      support: inputState.support,
      accounts: inputState.accounts ?? [],
      activeCredentialId: inputState.activeCredentialId ?? null,
      activeKnown: inputState.activeKnown,
      busy: inputState.busy,
      ...(inputState.detail ? { detail: inputState.detail } : {}),
    });

    const readState = (server: AccountConnection) =>
      Effect.gen(function* () {
        if (!isOpenCodeV2Server(server)) {
          return makeState({
            support: "unsupported",
            activeKnown: false,
            busy: yield* input.workGuard.isBusy,
            detail: "OpenCode V1 does not support account switching.",
          });
        }
        const integration = yield* readIntegration(server);
        const credentials = integration.connections.filter(isCredentialConnection);
        const accounts = credentials.map((connection) => ({
          credentialId: connection.id,
          label: safeLabel(connection),
          method: connection.method,
        }));
        const externallyBusy = yield* readBusy(server);
        return makeState({
          support: "supported",
          accounts,
          activeCredentialId: credentials[0]?.id ?? null,
          activeKnown: true,
          busy: externallyBusy || (yield* input.workGuard.isBusy),
        });
      });

    const list: OpenCodeAccountManagementShape["list"] = input.workGuard.withLock(
      withOpenCodeServer(readState).pipe(
        Effect.mapError(() =>
          accountError("unavailable", "OpenCode account state could not be read."),
        ),
      ),
    );

    const activate: OpenCodeAccountManagementShape["activate"] = (
      activationInput,
      refreshCatalog,
    ) =>
      input.workGuard.revalidateNativeContexts.pipe(
        Effect.andThen(
          input.workGuard.withLock(
            Effect.gen(function* () {
              if (yield* input.workGuard.isBusy) {
                return yield* accountError("busy", "OpenCode is handling active work.");
              }

              const activation = yield* withOpenCodeServer((server) =>
                Effect.gen(function* () {
                  if (!isOpenCodeV2Server(server)) {
                    return yield* accountError(
                      "unsupported",
                      "OpenCode V1 does not support account switching.",
                    );
                  }
                  const client = getClient(server);
                  const integration = yield* readIntegration(server);
                  const credentials = integration.connections.filter(isCredentialConnection);
                  const currentId = credentials[0]?.id ?? null;
                  const state = (
                    activeCredentialId: string | null,
                    activeKnown: boolean,
                    busy: boolean,
                    accountConnections = credentials,
                  ) =>
                    makeState({
                      support: "supported",
                      accounts: accountConnections.map((connection) => ({
                        credentialId: connection.id,
                        label: safeLabel(connection),
                        method: connection.method,
                      })),
                      activeCredentialId,
                      activeKnown,
                      busy,
                    });

                  if (
                    activationInput.expectedActiveCredentialId !== undefined &&
                    activationInput.expectedActiveCredentialId !== currentId
                  ) {
                    return yield* accountError(
                      "conflict",
                      "The active OpenCode account changed. Refresh and try again.",
                    );
                  }
                  const selected = credentials.find(
                    (connection) => connection.id === activationInput.credentialId,
                  );
                  if (!selected) {
                    return yield* accountError(
                      "account_not_found",
                      "That credential is not an OpenAI account on this OpenCode server.",
                    );
                  }

                  const externallyBusy = yield* readBusy(server);
                  if (externallyBusy) {
                    return yield* accountError("busy", "OpenCode is handling active work.");
                  }
                  if (currentId === selected.id) {
                    return {
                      state: state(currentId, true, false),
                      activation: "unchanged" as const,
                      catalogRefresh: "not-needed" as const,
                    };
                  }

                  yield* Effect.result(
                    runOpenCodeSdk("credential.activate", () =>
                      client.credential.activate({ credentialID: selected.id }),
                    ),
                  );
                  const readback = yield* Effect.result(readIntegration(server));
                  const readbackCredentials =
                    readback._tag === "Success"
                      ? readback.success.connections.filter(isCredentialConnection)
                      : credentials;
                  const activeCredentialId =
                    readback._tag === "Success" ? (readbackCredentials[0]?.id ?? null) : null;
                  const activeKnown = readback._tag === "Success";
                  const activationStatus =
                    readback._tag === "Success" && activeCredentialId === selected.id
                      ? ("activated" as const)
                      : ("unknown" as const);
                  const refreshed = yield* Effect.exit(refreshCatalog());
                  return {
                    state: state(activeCredentialId, activeKnown, false, readbackCredentials),
                    activation: activationStatus,
                    catalogRefresh: Exit.isSuccess(refreshed)
                      ? refreshed.value
                      : ("failed" as const),
                  };
                }),
              ).pipe(
                Effect.catchTag("OpenCodeRuntimeError", () =>
                  Effect.fail(
                    accountError(
                      "unavailable",
                      "OpenCode account activation could not be confirmed.",
                    ),
                  ),
                ),
              );
              return activation;
            }),
          ),
        ),
      );

    return { list, activate } satisfies OpenCodeAccountManagementShape;
  });
}
