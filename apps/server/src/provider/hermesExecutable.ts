// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function findHermesBinaryOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return NodeFS.existsSync(trimmed) ? trimmed : undefined;
  }
  const names = platform === "win32" ? [trimmed, `${trimmed}.exe`, `${trimmed}.cmd`] : [trimmed];
  for (const dir of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    const base = dir.trim().replace(/^["']|["']$/g, "");
    if (!base) continue;
    for (const name of names) {
      const candidate = NodePath.join(base, name);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveHermesPythonCandidate(
  hermesPath: string,
  platform: NodeJS.Platform,
): string | undefined {
  let resolved = hermesPath;
  try {
    resolved = NodeFS.realpathSync(hermesPath);
  } catch {
    return undefined;
  }
  const dir = NodePath.dirname(resolved);
  const names = platform === "win32" ? ["python.exe"] : ["python", "python3"];
  return names
    .map((name) => NodePath.join(dir, name))
    .find((candidate) => NodeFS.existsSync(candidate));
}

/** Only bootstrap standard Python entry points; configured shell wrappers must keep their behavior. */
export function resolveHermesAcpPython(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const binary = findHermesBinaryOnPath(command, environment, platform);
  if (!binary) return undefined;
  const python = resolveHermesPythonCandidate(binary, platform);
  if (!python) return undefined;
  if (platform === "win32" && binary.toLowerCase().endsWith(".exe")) return python;
  try {
    const entryPoint = NodeFS.readFileSync(binary, "utf8");
    return /^#![^\r\n]*python[^\r\n]*\r?\n/.test(entryPoint) &&
      entryPoint.includes("from hermes_cli.main import main")
      ? python
      : undefined;
  } catch {
    return undefined;
  }
}
