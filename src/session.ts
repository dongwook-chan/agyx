import { ChildProcess, spawn } from "node:child_process";
import { createServer, Socket } from "node:net";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  cleanupRuntimeFile,
  ensureDirectories,
  loadState,
  logDir,
  recordProfileIneligible,
  recordProfileQuotaExhausted,
  recordProfileRequest,
  runtimeDir,
} from "./config.js";
import {
  findRealAgy,
  isRestartable,
} from "./processes.js";
import { buildAgyLaunchArgs } from "./launch_args.js";
import { parseEligibilityEventLine } from "./eligibility.js";
import {
  isRequestEventLine,
  parseModelEventLine,
  parseQuotaEventLine,
  QuotaScope,
} from "./quota.js";

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
  currentModelLabel?: string;
  currentQuotaScope?: QuotaScope;
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

interface AutoSwitchAction {
  kind?: string;
  message?: string;
  retryKey?: string;
}

async function triggerAutoSwitch(scope: QuotaScope): Promise<AutoSwitchAction | undefined> {
  const cliPath = process.argv[1];
  if (!cliPath) return undefined;
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, "_auto-next", scope], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGYX_AUTO_SWITCH_TRIGGER: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      console.error(`\n[agyx] Automatic quota failover failed: ${error.message}`);
      resolvePromise({ kind: "stop_retrying", retryKey: `quota:${scope}` });
    });
    child.on("exit", () => {
      try {
        const action = stdout.trim()
          ? JSON.parse(stdout.trim()) as AutoSwitchAction
          : undefined;
        if (action?.message) console.error(action.message);
        else if (stderr.trim()) console.error(stderr.trim());
        resolvePromise(action);
      } catch {
        if (stderr.trim()) console.error(stderr.trim());
        resolvePromise({ kind: "stop_retrying", retryKey: `quota:${scope}` });
      }
    });
  });
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
  const startedAt = new Date().toISOString();
  let child: ChildProcess | undefined;
  let paused = false;
  let intentionalStop = false;
  let conversationId: string | undefined;
  let finalCode = 0;
  let logOffset = 0;
  let scanningLogEvents = false;
  let profileAtStart: string | undefined;
  let quotaMarkedScopes = new Set<QuotaScope>();
  const autoSwitchStoppedScopes = new Set<QuotaScope>();
  let quotaInterval: NodeJS.Timeout | undefined;
  let persistCount = 0;
  let currentModelLabel: string | undefined;
  let currentQuotaScope: QuotaScope | undefined;

  const currentRecord = (): SessionRecord => ({
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
    startedAt,
    currentModelLabel,
    currentQuotaScope,
  });

  const persist = async (): Promise<SessionRecord> => {
    const record = currentRecord();
    const temporary = `${recordPath}.${process.pid}.${persistCount++}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, recordPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return record;
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
      let modelChanged = false;
      for (const line of appended.split(/\r?\n/)) {
        const modelEvent = parseModelEventLine(line);
        if (modelEvent) {
          currentModelLabel = modelEvent.label;
          currentQuotaScope = modelEvent.scope;
          modelChanged = true;
        }
        if (isRequestEventLine(line)) {
          await recordProfileRequest(profileName);
        }
        const eligibilityEvent = parseEligibilityEventLine(line);
        if (eligibilityEvent) {
          await recordProfileIneligible(profileName, eligibilityEvent);
        }
        const event = parseQuotaEventLine(line);
        if (!event) continue;
        const scope = currentQuotaScope ?? "unknown";
        if (autoSwitchStoppedScopes.has(scope)) continue;
        if (quotaMarkedScopes.has(scope)) continue;
        quotaMarkedScopes.add(scope);
        await recordProfileQuotaExhausted(profileName, {
          ...event,
          scope,
          modelLabel: currentModelLabel,
        });
        const action = await triggerAutoSwitch(scope);
        if (action?.kind === "stop_retrying") autoSwitchStoppedScopes.add(scope);
      }
      if (modelChanged) await persist();
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
    quotaMarkedScopes = new Set<QuotaScope>();
    currentModelLabel = undefined;
    currentQuotaScope = undefined;
    const state = await loadState();
    const launchArgs = buildAgyLaunchArgs(args, { conversationId, logPath, state });
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
        let isAbnormal = finalCode !== 0;
        if (!isAbnormal) {
          try {
            const logContent = readFileSync(logPath, "utf8");
            const keywords = [
              "signal terminated",
              "Got signal",
              "model unreachable",
              "context canceled",
              "quota reached",
              "quota exceeded",
              "RESOURCE_EXHAUSTED",
              "connection lost",
              "connection closed",
              "stream error",
            ];
            isAbnormal = keywords.some(kw => logContent.includes(kw));
          } catch {}
        }
        if (isAbnormal) {
          console.error(`\n[agyx] Session ended unexpectedly (exit code ${finalCode}). Restarting...`);
          setTimeout(() => { void startChild(); }, 1000);
        } else {
          await shutdown();
          process.exit(0);
        }
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
          const record = await persist();
          writeJSON(socket, { ok: true, record });
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
          const record = await persist();
          writeJSON(socket, { ok: true, record });
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
