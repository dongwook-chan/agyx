import { ChildProcess, spawn } from "node:child_process";
import { createServer, Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupRuntimeFile,
  ensureDirectories,
  loadState,
  logDir,
  recordProfileQuotaExhausted,
  recordProfileRequest,
  runtimeDir,
} from "./config.js";
import {
  findRealAgy,
  isRestartable,
  withConversation,
} from "./processes.js";
import { isRequestEventLine, parseQuotaEventLine } from "./quota.js";

export interface SessionRecord {
  id: string;
  pid: number;
  childPid?: number;
  cwd: string;
  args: string[];
  conversationId?: string;
  socketPath: string;
  logPath: string;
  paused: boolean;
  restartable: boolean;
  startedAt: string;
}

type SessionCommand = { command: "pause" | "resume" | "status" | "shutdown" };

export function detectConversation(content: string): string | undefined {
  const patterns = [
    /Created conversation ([0-9a-f-]{36})/gi,
    /GetConversationDetail: found conversation ([0-9a-f-]{36})/gi,
    /Conversation using ID: ([0-9a-f-]{36})/gi,
  ];
  let latest: string | undefined;
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) latest = match[1];
  }
  return latest;
}

function writeJSON(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

export async function supervise(args: string[]): Promise<number> {
  if (!isRestartable(args)) {
    const realAgy = await findRealAgy();
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(realAgy, args, { stdio: "inherit", cwd: process.cwd() });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
    });
  }

  await ensureDirectories();
  const id = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  // macOS limits Unix-domain socket paths to roughly 104 bytes. Keep the
  // transport filename minimal; the full session identity remains in metadata.
  const socketPath = join(runtimeDir, `${process.pid}.sock`);
  const recordPath = join(runtimeDir, `${id}.json`);
  const logPath = join(logDir, `session-${id}.log`);
  const realAgy = await findRealAgy();
  let child: ChildProcess | undefined;
  let paused = false;
  let intentionalStop = false;
  let conversationId: string | undefined;
  let finalCode = 0;
  let logOffset = 0;
  let scanningLogEvents = false;
  let profileAtStart: string | undefined;
  let quotaMarked = false;
  let quotaInterval: NodeJS.Timeout | undefined;

  const persist = async (): Promise<void> => {
    const record: SessionRecord = {
      id,
      pid: process.pid,
      childPid: child?.pid,
      cwd: process.cwd(),
      args,
      conversationId,
      socketPath,
      logPath,
      paused,
      restartable: true,
      startedAt: new Date().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  };

  const refreshConversation = async (): Promise<void> => {
    try {
      conversationId = detectConversation(await readFile(logPath, "utf8"))
        ?? conversationId;
    } catch {
      // The log may not exist until agy has initialized.
    }
  };

  const scanLogEvents = async (): Promise<void> => {
    if (scanningLogEvents) return;
    scanningLogEvents = true;
    try {
      const profileName = profileAtStart;
      if (!profileName) return;
      const content = await readFile(logPath, "utf8");
      if (content.length < logOffset) logOffset = 0;
      const appended = content.slice(logOffset);
      logOffset = content.length;
      for (const line of appended.split(/\r?\n/)) {
        if (isRequestEventLine(line)) {
          await recordProfileRequest(profileName);
        }
        const event = parseQuotaEventLine(line);
        if (!event) continue;
        if (quotaMarked) continue;
        quotaMarked = true;
        await recordProfileQuotaExhausted(profileName, event);
      }
    } catch {
      // The log or state file may not exist yet.
    } finally {
      scanningLogEvents = false;
    }
  };

  const startChild = async (): Promise<void> => {
    intentionalStop = false;
    paused = false;
    profileAtStart = (await loadState()).activeProfile;
    quotaMarked = false;
    const launchArgs = withConversation(args, conversationId);
    if (!launchArgs.some((argument) =>
      argument === "--log-file" || argument.startsWith("--log-file=")
    )) {
      launchArgs.push("--log-file", logPath);
    }
    child = spawn(realAgy, launchArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        AGYX_MANAGED: "1",
        AGYX_SESSION_ID: id,
      },
    });
    await persist();
    child.on("exit", async (code, signal) => {
      finalCode = code ?? (signal ? 128 : 1);
      await refreshConversation();
      await scanLogEvents();
      child = undefined;
      await persist();
      if (!intentionalStop && !paused) {
        await shutdown();
        process.exit(finalCode);
      }
    });
  };

  const stopChild = async (): Promise<void> => {
    if (!child?.pid) return;
    intentionalStop = true;
    const current = child;
    current.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        if (current.exitCode === null) current.kill("SIGKILL");
      }, 5000);
      const finish = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      current.once("exit", finish);
      if (current.exitCode !== null || current.signalCode !== null) finish();
    });
    await refreshConversation();
  };

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("end", async () => {
      try {
        const request = JSON.parse(input) as SessionCommand;
        if (request.command === "pause") {
          paused = true;
          await stopChild();
          await persist();
          writeJSON(socket, { ok: true, record: JSON.parse(await readFile(recordPath, "utf8")) });
        } else if (request.command === "resume") {
          if (!child) await startChild();
          writeJSON(socket, { ok: true });
        } else if (request.command === "shutdown") {
          await stopChild();
          writeJSON(socket, { ok: true });
          await shutdown();
          process.exit(0);
        } else {
          await refreshConversation();
          await persist();
          writeJSON(socket, { ok: true, record: JSON.parse(await readFile(recordPath, "utf8")) });
        }
      } catch (error) {
        writeJSON(socket, { ok: false, error: (error as Error).message });
      }
    });
  });

  const shutdown = async (): Promise<void> => {
    if (quotaInterval) clearInterval(quotaInterval);
    await cleanupRuntimeFile(socketPath);
    await cleanupRuntimeFile(recordPath);
    server.close();
  };

  await cleanupRuntimeFile(socketPath);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolvePromise());
  });
  process.on("SIGINT", async () => {
    await stopChild();
    await shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await stopChild();
    await shutdown();
    process.exit(143);
  });
  await startChild();
  quotaInterval = setInterval(() => {
    void scanLogEvents();
  }, 750);
  quotaInterval.unref();
  return await new Promise<number>(() => undefined);
}
