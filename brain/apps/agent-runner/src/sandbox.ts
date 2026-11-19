import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DESTRUCTIVE_COMMANDS } from "./queue.js";

const execFileAsync = promisify(execFile);

export const ALLOWED_RUNNER_COMMANDS = new Set(["git status", "git diff", "npm test", "node --test"]);

export async function runSandboxedCommand(
  command: string,
  cwd: string,
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string }> {
  const normalized = command.trim();
  if (DESTRUCTIVE_COMMANDS.test(normalized) || !ALLOWED_RUNNER_COMMANDS.has(normalized)) {
    throw new Error(`Comando bloqueado pela allowlist do Brain Runner: '${command}'.`);
  }
  const [bin, ...args] = normalized.split(/\s+/);
  return execFileAsync(bin!, args, { cwd, timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" } });
}

export async function runDockerSandbox(
  workspaceDir: string,
  command: string,
  image = "node:22-alpine"
): Promise<{ stdout: string; stderr: string }> {
  const normalized = command.trim();
  if (DESTRUCTIVE_COMMANDS.test(normalized) || !ALLOWED_RUNNER_COMMANDS.has(normalized)) {
    throw new Error(`Comando bloqueado no sandbox Docker: '${command}'.`);
  }
  const [bin, ...args] = normalized.split(/\s+/);
  return execFileAsync("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "-v",
    `${workspaceDir}:/workspace:ro`,
    "-w",
    "/workspace",
    image,
    bin!,
    ...args
  ]);
}

