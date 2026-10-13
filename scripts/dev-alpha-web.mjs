import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { DEV_PROXIED_PATH_PREFIXES } from "@t3tools/shared/devProxy";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const alphaHome = process.env.T3CODE_ALPHA_HOME || NodePath.join(NodeOS.homedir(), ".t3-fork");
const stateDir = NodePath.join(alphaHome, "userdata");
const runtime = JSON.parse(
  await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
);
const environmentId = (
  await NodeFSP.readFile(NodePath.join(stateDir, "environment-id"), "utf8")
).trim();
const backendUrl = new URL(runtime.origin);

if (
  backendUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(backendUrl.hostname) ||
  !Number.isInteger(runtime.port) ||
  runtime.port < 1 ||
  runtime.port > 65535 ||
  Number(backendUrl.port || 80) !== runtime.port
) {
  throw new Error("Alpha must be running with a local HTTP backend.");
}

const response = await fetch(new URL("/.well-known/t3/environment", backendUrl), {
  signal: AbortSignal.timeout(5000),
});
if (!response.ok || (await response.json()).environmentId !== environmentId) {
  throw new Error("The running backend does not match the Alpha profile. Open T3 Code + first.");
}

process.env.T3CODE_SINGLE_ORIGIN_DEV = "1";
process.env.VITE_ALPHA_WORKSPACES = "1";
process.env.T3CODE_PORT = String(runtime.port);
delete process.env.VITE_HTTP_URL;
delete process.env.VITE_WS_URL;
process.chdir(NodePath.join(repoRoot, "apps", "web"));

const { createServer } = await import("vite-plus");
const server = await createServer({
  server: {
    host: "127.0.0.1",
    port: 5734,
    strictPort: false,
    open: false,
    proxy: Object.fromEntries(
      DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
        prefix,
        {
          target: backendUrl.origin,
          changeOrigin: true,
          ...(prefix === "/ws" ? { ws: true } : {}),
        },
      ]),
    ),
  },
});
await server.listen();
console.log(`Alpha backend: ${backendUrl.origin} (${alphaHome})`);
server.printUrls();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
