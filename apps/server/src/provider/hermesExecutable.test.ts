import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveHermesAcpPython } from "./hermesExecutable.ts";

it.layer(NodeServices.layer)("resolveHermesAcpPython", (it) => {
  it.effect(
    "finds a standard Python entry point through PATH while preserving shell wrappers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-entry-" });
        const hermes = path.join(root, "hermes");
        const python = path.join(root, "python");
        yield* fs.writeFileString(python, "");
        yield* fs.writeFileString(
          hermes,
          "#!/venv/bin/python\nfrom hermes_cli.main import main\nmain()\n",
        );
        expect(resolveHermesAcpPython("hermes", { PATH: root }, "linux")).toBe(python);
        yield* fs.writeFileString(hermes, "#!/bin/sh\nexec hermes --profile custom acp\n");
        expect(resolveHermesAcpPython(hermes, {}, "linux")).toBeUndefined();
      }),
  );

  it.effect("uses the Windows virtual environment interpreter and leaves cmd launchers alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-entry-win-" });
      const python = path.join(root, "python.exe");
      const hermes = path.join(root, "hermes.exe");
      const wrapper = path.join(root, "hermes.cmd");
      yield* fs.writeFileString(python, "");
      yield* fs.writeFileString(hermes, "fixture launcher");
      yield* fs.writeFileString(wrapper, "@echo off\r\nhermes.exe acp\r\n");
      expect(resolveHermesAcpPython("hermes", { Path: root }, "win32")).toBe(python);
      expect(resolveHermesAcpPython(wrapper, {}, "win32")).toBeUndefined();
    }),
  );
});
