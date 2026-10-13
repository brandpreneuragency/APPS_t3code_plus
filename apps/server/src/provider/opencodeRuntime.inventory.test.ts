// @effect-diagnostics nodeBuiltinImport:off - This local HTTP fixture exercises the runtime's real capability probe.
import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeHttp from "node:http";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  isOpenCodeV2Server,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
const localConnectionFixture = { url: "", spawnCalls: 0, passwordAliasesMatch: false };
const localConnectionSpawner = ChildProcessSpawner.make((command) => {
  localConnectionFixture.spawnCalls += 1;
  if (command._tag === "StandardCommand") {
    const environment = command.options.env;
    localConnectionFixture.passwordAliasesMatch =
      environment?.OPENCODE_SERVER_PASSWORD === "synthetic-settings-password" &&
      environment?.OPENCODE_PASSWORD === "synthetic-settings-password";
  }
  return Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(
        new TextEncoder().encode(`opencode server listening on ${localConnectionFixture.url}\n`),
      ),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  );
});
const localConnectionTestLayer = OpenCodeRuntimeLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, localConnectionSpawner),
      Layer.succeed(HostProcessPlatform, "win32"),
    ),
  ),
);

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("loads V2 catalogs after cold-location plugins have activated", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      let activated = false;
      const client = {
        integration: {
          list: () => Promise.resolve().then(() => {
            activated = true;
            return { data: [{ id: "test-integration" }] };
          }),
        },
        provider: {
          list: () => Promise.resolve({ data: activated ? [{ id: "test-provider" }] : [] }),
        },
        model: {
          list: () => Promise.resolve({ data: activated ? [{ modelID: "test-model" }] : [] }),
        },
        agent: {
          list: () => Promise.resolve({ data: activated ? [{ id: "test-agent" }] : [] }),
        },
        skill: {
          list: () => Promise.resolve({ data: activated ? [{ name: "test-skill" }] : [] }),
        },
      } as unknown as Parameters<OpenCodeRuntimeShape["loadOpenCodeV2Inventory"]>[0];

      const inventory = yield* runtime.loadOpenCodeV2Inventory(client, process.cwd());

      NodeAssert.deepEqual(inventory.providers.map((provider) => provider.id), ["test-provider"]);
      NodeAssert.deepEqual(inventory.models.map((model) => model.modelID), ["test-model"]);
      NodeAssert.deepEqual(inventory.agents.map((agent) => agent.id), ["test-agent"]);
      NodeAssert.deepEqual(inventory.skills.map((skill) => skill.name), ["test-skill"]);
      NodeAssert.deepEqual(inventory.integrations.map((integration) => integration.id), ["test-integration"]);
    }),
  );

  it.effect("keeps provider inventory when agent discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.reject(new Error("agents endpoint unavailable")),
          skills: () => Promise.resolve({ data: [] }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error("skills endpoint unavailable")),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "unused skill content",
                },
              ],
            }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          location: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("drops oversized CLI skill output without losing the model inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-inventory-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const oversizedContentBytes = 8 * 1024 * 1024 + 1;

      yield* fs.writeFileString(
        scriptPath,
        [
          'if (process.argv[2] === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (process.argv[2] === "debug") {',
          `  const content = "x".repeat(${oversizedContentBytes});`,
          '  process.stdout.write(`[{"name":"oversized","content":"${content}"}]`);',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.skills.length, 0);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});

const withLocalOpenCodeServer = <A, E, R>(
  scenario: "v2" | "v2.0.23" | "v2.0.24" | "v1-404" | "http-401" | "http-403" | "http-500" | "network",
  use: (
    runtime: OpenCodeRuntimeShape,
    requests: ReadonlyArray<string>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const server = NodeHttp.createServer((request, response) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        requests.push(pathname);
        if (pathname === "/api/info") {
          if (scenario === "v2" || scenario === "v2.0.23" || scenario === "v2.0.24") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                version: scenario === "v2" ? "2.0.18" : scenario.slice(1),
                pid: 1,
                urls: [],
                paths: { tmp: process.cwd() },
              }),
            );
            return;
          }
          if (scenario === "v1-404") {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "not available" }));
            return;
          }
          if (scenario === "network") {
            request.socket.destroy();
            return;
          }
          const status = scenario === "http-401" ? 401 : scenario === "http-403" ? 403 : 500;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not available" }));
          return;
        }
        if (pathname === "/global/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ healthy: true, version: "1.18.33" }));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      const port = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                  reject(new Error("Local fixture did not bind a TCP port."));
                  return;
                }
                resolve(address.port);
              });
            }),
        ),
        () =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      localConnectionFixture.url = `http://127.0.0.1:${port}`;
      localConnectionFixture.spawnCalls = 0;

      const runtime = yield* OpenCodeRuntime;
      return yield* use(runtime, requests);
    }).pipe(Effect.provide(localConnectionTestLayer)),
  );

const connectToLocalTestServer = (runtime: OpenCodeRuntimeShape) =>
  runtime.connectToOpenCodeServer({
    binaryPath: "fake-opencode",
    directory: process.cwd(),
    port: 0,
    hostname: "127.0.0.1",
  });

it.live("overrides both password aliases for a local V2 server", () =>
  withLocalOpenCodeServer("v2", (runtime) =>
    Effect.gen(function* () {
      yield* runtime.startOpenCodeServerProcess({
        binaryPath: "fake-opencode",
        directory: process.cwd(),
        port: 0,
        serverPassword: "synthetic-settings-password",
        environment: { OPENCODE_PASSWORD: "synthetic-conflicting-password" },
      });

      NodeAssert.equal(localConnectionFixture.passwordAliasesMatch, true);
    }),
  ),
);

it.live("preserves V2 capability through connectToOpenCodeServer for a local process", () =>
  withLocalOpenCodeServer("v2", (runtime, requests) =>
    Effect.gen(function* () {
      const connection = yield* connectToLocalTestServer(runtime);

      NodeAssert.equal(localConnectionFixture.spawnCalls, 1);
      NodeAssert.equal(connection.version, "2.0.18");
      NodeAssert.equal(connection.protocol, "v2");
      NodeAssert.equal(connection.external, false);
      NodeAssert.equal(isOpenCodeV2Server(connection), true);
      NodeAssert.deepEqual(requests, ["/api/info"]);
    }),
  ),
);

for (const scenario of ["v2.0.23", "v2.0.24"] as const) {
  it.live(`connects to OpenCode ${scenario} without falling back to V1`, () =>
    withLocalOpenCodeServer(scenario, (runtime, requests) =>
      Effect.gen(function* () {
        const connection = yield* connectToLocalTestServer(runtime);

        NodeAssert.equal(connection.version, scenario.slice(1));
        NodeAssert.equal(connection.protocol, "v2");
        NodeAssert.deepEqual(requests, ["/api/info"]);
      }),
    ),
  );
}

it.live("uses V1 health only after a local V2 capability 404", () =>
  withLocalOpenCodeServer("v1-404", (runtime, requests) =>
    Effect.gen(function* () {
      const connection = yield* connectToLocalTestServer(runtime);

      NodeAssert.equal(connection.version, "1.18.33");
      NodeAssert.equal(connection.protocol, "v1");
      NodeAssert.equal(connection.external, false);
      NodeAssert.equal(isOpenCodeV2Server(connection), false);
      NodeAssert.deepEqual([...requests].sort(), ["/api/info", "/global/health"]);
    }),
  ),
);

for (const scenario of ["http-401", "http-403", "http-500", "network"] as const) {
  it.live(`does not fall back to V1 health after ${scenario}`, () =>
    withLocalOpenCodeServer(scenario, (runtime, requests) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(connectToLocalTestServer(runtime));

        NodeAssert.equal(exit._tag, "Failure");
        NodeAssert.equal(requests.includes("/api/info"), true);
        NodeAssert.equal(requests.includes("/global/health"), false);
      }),
    ),
  );
}
