import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  hermesModelCapabilities,
} from "./HermesAcpSupport.ts";

const REASONING_CONFIG = {
  id: "t3:reasoning-effort",
  name: "Reasoning effort",
  type: "select",
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "none", name: "None" },
    { value: "high", name: "High" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

describe("buildHermesAcpSpawnInput", () => {
  it("defaults the binary to hermes with the acp subcommand", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project", { PATH: "" }, "linux")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "" },
    });
  });

  it("uses settings.binaryPath and passes env through", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      { OPENAI_API_KEY: "secret" },
      "linux",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        OPENAI_API_KEY: "secret",
      },
    });
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (
    failure?: EffectAcpErrors.AcpError,
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [REASONING_CONFIG],
  ) => {
    const modelCalls: Array<{ modelId: string; meta?: unknown }> = [];
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          configCalls.push({ configId, value });
          if (failure) return yield* failure;
          return { configOptions };
        }),
      setSessionModel: (modelId: string, meta?: unknown) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls, configCalls };
  };

  it.effect("changes reasoning on the same model and can restore the configured default", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      for (const effort of ["high", "none", "default"]) {
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai-codex:gpt-5.6-sol",
          requestedModelId: "openai-codex:gpt-5.6-sol",
          selections: [{ id: "reasoningEffort", value: effort }],
          mapError: (cause) => cause.message,
        });
      }
      expect(modelCalls).toEqual([]);
      expect(configCalls.map((call) => call.value)).toEqual(["high", "none", "default"]);
      expect(configCalls.every((call) => call.configId === "t3:reasoning-effort")).toBe(true);
    }),
  );

  it.effect("applies the selected effort after switching the model", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime();
      const order: string[] = [];
      yield* applyHermesAcpModelSelection({
        runtime: {
          ...runtime,
          setSessionModel: (modelId) =>
            runtime
              .setSessionModel(modelId)
              .pipe(Effect.tap(() => Effect.sync(() => order.push("model")))),
          setConfigOption: (configId, value) =>
            runtime
              .setConfigOption(configId, value)
              .pipe(Effect.tap(() => Effect.sync(() => order.push(String(value))))),
        },
        currentModelId: "old-model",
        requestedModelId: "new-model",
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(order).toEqual(["model", "high"]);
    }),
  );

  it.effect("rejects explicit effort when the launcher cannot apply it", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime(undefined, []);
      const result = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "model",
          requestedModelId: undefined,
          selections: [{ id: "reasoningEffort", value: "high" }],
          mapError: (cause) => cause.message,
        }),
      );
      expect(result).toContain("does not expose reasoning effort");
      expect(configCalls).toEqual([]);
    }),
  );

  it.effect("propagates reasoning update failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unsupported effort");
      const { runtime } = makeRecordingRuntime(failure);
      expect(
        yield* Effect.flip(
          applyHermesAcpModelSelection({
            runtime,
            currentModelId: "model",
            requestedModelId: undefined,
            selections: [{ id: "reasoningEffort", value: "high" }],
            mapError: (cause) => cause.message,
          }),
        ),
      ).toBe(failure.message);
    }),
  );

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "openai-codex:gpt-5.4" }]);
      expect(result).toBe("openai-codex:gpt-5.4");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.6-sol",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openai-codex:gpt-5.6-sol");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("openai-codex:gpt-5.6-sol");
    }),
  );

  it.effect("does not send _meta on session/set_model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openai-codex:gpt-5.6-sol",
        requestedModelId: "openai-codex:gpt-5.4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls[0]).toEqual({ modelId: "openai-codex:gpt-5.4" });
      expect("meta" in (modelCalls[0] ?? {})).toBe(false);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai-codex:gpt-5.6-sol",
          requestedModelId: "openai-codex:gpt-5.4",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("hermesModelCapabilities", () => {
  it("exposes only the effort choices the Hermes bridge advertises", () => {
    expect(hermesModelCapabilities([REASONING_CONFIG]).optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "none", label: "None" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it("does not advertise a control for an unbridged launcher", () => {
    expect(hermesModelCapabilities().optionDescriptors).toEqual([]);
  });
});
