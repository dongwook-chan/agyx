import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadState, saveState } from "./config.js";

export interface RunningAgy {
  pid: number;
  command: string;
}

export async function run(
  executable: string,
  args: string[],
  options: { input?: Buffer; allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!options.allowFailure && result.code !== 0) {
        reject(new Error(
          result.stderr.toString("utf8").trim()
          || `${executable} exited with status ${result.code}`,
        ));
      } else {
        resolvePromise(result);
      }
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findRealAgy(): Promise<string> {
  const override = process.env.AGYX_REAL_AGY;
  if (override && await executable(override)) return resolve(override);

  const state = await loadState();
  if (state.realAgyPath && await executable(state.realAgyPath)) {
    return state.realAgyPath;
  }

  const candidates = [
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    ...((process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, "agy"))),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (!await executable(candidate)) continue;
    try {
      const header = await readFile(candidate, { encoding: "utf8" });
      if (header.includes("agyx session")) continue;
    } catch {
      // Native binaries are expected to fail UTF-8 inspection.
    }
    state.realAgyPath = candidate;
    await saveState(state);
    return candidate;
  }
  throw new Error("The real agy executable was not found. Set AGYX_REAL_AGY.");
}

export function parsePS(output: string): RunningAgy[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[2]!;
    const first = command.split(/\s+/, 1)[0]!;
    if (first.split("/").at(-1) !== "agy") return [];
    return [{ pid: Number(match[1]), command }];
  });
}

export async function runningAgy(): Promise<RunningAgy[]> {
  const result = await run("/bin/ps", ["-axo", "pid=,command="]);
  return parsePS(result.stdout.toString("utf8"));
}

export async function stopProcesses(processes: RunningAgy[]): Promise<void> {
  for (const processInfo of processes) {
    try { process.kill(processInfo.pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 5000;
  let remaining = processes;
  while (remaining.length && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const live = new Set((await runningAgy()).map(({ pid }) => pid));
    remaining = processes.filter(({ pid }) => live.has(pid));
  }
  for (const processInfo of remaining) {
    try { process.kill(processInfo.pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export function isRestartable(args: string[]): boolean {
  return !args.some((argument) =>
    ["-p", "--print", "--prompt"].includes(argument)
  );
}

export function withConversation(args: string[], conversationId?: string): string[] {
  if (!conversationId) return [...args];
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-c" || argument === "--continue") continue;
    if (argument === "--conversation") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--conversation=")) continue;
    result.push(argument);
  }
  return [...result, "--conversation", conversationId];
}
