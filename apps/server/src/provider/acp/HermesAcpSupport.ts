import {
  type HermesSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { resolveHermesAcpPython } from "../hermesExecutable.ts";
import { HERMES_ACP_REASONING_BRIDGE } from "./HermesAcpBridge.ts";

const HERMES_REASONING_CONFIG_ID = "t3:reasoning-effort";

export function hermesModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [],
): ModelCapabilities {
  const reasoning = configOptions.find((option) => option.id === HERMES_REASONING_CONFIG_ID);
  if (!reasoning || reasoning.type !== "select") return { optionDescriptors: [] };
  const options = reasoning.options.flatMap((option) =>
    "options" in option ? option.options : [option],
  );
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "default",
        options: options.map((option) => ({
          id: option.value,
          label: option.name,
          ...(option.value === "default" ? { isDefault: true } : {}),
        })),
      },
    ],
  };
}

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform,
): AcpSessionRuntime.AcpSpawnInput {
  const command = hermesSettings?.binaryPath || "hermes";
  const python = resolveHermesAcpPython(command, environment ?? process.env, platform);
  return {
    command: python ?? command,
    args: python ? ["-c", HERMES_ACP_REASONING_BRIDGE] : ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(
          input.hermesSettings,
          input.cwd,
          input.environment,
          platform,
        ),
        // Hermes session/new works without authenticate when a provider is
        // already configured; calling it would pick a dynamic method id or
        // spawn the terminal `hermes-setup` flow.
        authMethodId: null,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setSessionModel" | "getConfigOptions" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (
    cause: EffectAcpErrors.AcpError,
    method: "session/set_model" | "session/set_config_option",
  ) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const modelId = input.requestedModelId ?? input.currentModelId;
    if (modelId !== undefined && modelId !== input.currentModelId) {
      yield* input.runtime
        .setSessionModel(modelId)
        .pipe(Effect.mapError((cause) => input.mapError(cause, "session/set_model")));
    }
    const effort = getProviderOptionStringSelectionValue(input.selections, "reasoningEffort");
    if (effort !== undefined) {
      const configOptions = yield* input.runtime.getConfigOptions;
      if (configOptions.some((option) => option.id === HERMES_REASONING_CONFIG_ID)) {
        yield* input.runtime
          .setConfigOption(HERMES_REASONING_CONFIG_ID, effort)
          .pipe(Effect.mapError((cause) => input.mapError(cause, "session/set_config_option")));
      } else if (effort !== "default") {
        return yield* Effect.fail(
          input.mapError(
            EffectAcpErrors.AcpRequestError.invalidParams(
              "This Hermes launcher does not expose reasoning effort. Configure T3 to use the Hermes Python entry point.",
            ),
            "session/set_config_option",
          ),
        );
      }
    }
    return modelId;
  });
}
