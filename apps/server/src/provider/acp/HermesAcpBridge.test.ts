// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { HERMES_ACP_REASONING_BRIDGE } from "./HermesAcpBridge.ts";

// Opt in with the Python executable from a Hermes environment with the ACP extra installed.
const python = process.env.T3CODE_HERMES_PYTHON;
it.skipIf(!python)("applies reasoning to real Hermes ACP sessions in an isolated home", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-reasoning-"));
  try {
    const probe = NodeFS.readFileSync(
      new URL("../testFixtures/hermesReasoningProbe.py", import.meta.url),
      "utf8",
    );
    expect(() =>
      NodeChildProcess.execFileSync(python!, ["-c", probe], {
        env: { ...process.env, HERMES_HOME: home },
        input: JSON.stringify({ bridge: HERMES_ACP_REASONING_BRIDGE }),
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ).not.toThrow();
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
