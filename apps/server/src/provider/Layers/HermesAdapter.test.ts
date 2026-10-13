import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HermesSettings, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import * as HermesAcpSupport from "../acp/HermesAcpSupport.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

it.scoped("keeps Hermes reasoning separate and drains all work before turn completion", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spy = vi.spyOn(HermesAcpSupport, "makeHermesAcpRuntime").mockImplementation((input) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(AcpSessionRuntime.layer({
          ...input,
          authMethodId: "test",
          spawn: {
            command: process.execPath,
            args: [path.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts")],
            env: { ...process.env, T3_ACP_EMIT_REASONING: "1", T3_ACP_EMIT_TOOL_CALLS: "1" },
          },
        }));
        return yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
    const adapter = yield* makeHermesAdapter(Schema.decodeSync(HermesSettings)({}));
    const events: Array<ProviderRuntimeEvent> = [];
    const consumer = yield* adapter.streamEvents.pipe(
      Stream.tap((event) => Effect.sync(() => { events.push(event); })),
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runDrain,
      Effect.forkScoped,
    );
    const threadId = ThreadId.make("hermes-reasoning-test");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId, input: "inspect" });
    yield* Fiber.join(consumer);
    expect(events.filter((event) => event.type === "item.completed" && event.payload.itemType === "reasoning")
      .map((event) => event.payload)).toEqual([
        expect.objectContaining({ detail: "Inspect the code." }),
        expect.objectContaining({ detail: "Final check." }),
      ]);
    expect(events.some((event) => event.type === "item.completed" && event.payload.itemType === "command_execution")).toBe(true);
    expect(events.filter((event) => event.type === "content.delta").map((event) => event.payload.delta).join("")).toBe("hello from mock");
    expect(events.at(-1)?.type).toBe("turn.completed");
  }).pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd())),
    Effect.provide(NodeServices.layer),
  ),
);
