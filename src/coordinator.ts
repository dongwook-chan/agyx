import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import {
  ensureDirectories,
  loadState,
  logDir,
  markProfileActivated,
  profileNameFromEmail,
  readActiveGoogleAccountEmail,
  runtimeDir,
  saveState,
  upsertProfile,
  uniqueProfileName,
  validateProfileName,
} from "./config.js";
import { keychain } from "./keychain.js";
import {
  findRealAgy,
  runningAgy,
  stopProcesses,
} from "./processes.js";
import { SessionRecord } from "./session.js";

interface SessionReply {
  ok: boolean;
  error?: string;
  record?: SessionRecord;
}

async function send(socketPath: string, command: string): Promise<SessionReply> {
  return await new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ command })}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      try { resolvePromise(JSON.parse(input) as SessionReply); }
      catch { reject(new Error(`Invalid response from session ${socketPath}`)); }
    });
  });
}

export async function sessionRecords(): Promise<SessionRecord[]> {
  await ensureDirectories();
  const entries = await readdir(runtimeDir);
  const records: SessionRecord[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const path = join(runtimeDir, entry);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as SessionRecord;
      process.kill(record.pid, 0);
      records.push(record);
    } catch {
      await rm(path, { force: true });
    }
  }
  return records;
}

export async function pauseAll(): Promise<SessionRecord[]> {
  const records = await sessionRecords();
  const paused: SessionRecord[] = [];
  for (const record of records) {
    const reply = await send(record.socketPath, "pause");
    if (!reply.ok) throw new Error(reply.error ?? `Failed to pause ${record.id}`);
    paused.push(reply.record ?? record);
  }

  const managedPIDs = new Set(paused.map((record) => record.childPid).filter(Boolean));
  const unmanaged = (await runningAgy()).filter(({ pid }) => !managedPIDs.has(pid));
  if (unmanaged.length) await stopProcesses(unmanaged);
  return paused;
}

export async function resumeAll(records: SessionRecord[]): Promise<void> {
  for (const record of records) {
    try {
      const reply = await send(record.socketPath, "resume");
      if (!reply.ok) throw new Error(reply.error);
    } catch (error) {
      console.error(`agyx: failed to resume session ${record.id}: ${(error as Error).message}`);
    }
  }
}

export interface ProfileCaptureResult {
  name: string;
  email?: string;
}

function resolveProfileName(
  state: Awaited<ReturnType<typeof loadState>>,
  nameInput: string | undefined,
  email: string | undefined,
  context: "save" | "login",
): string {
  if (nameInput) return validateProfileName(nameInput);
  if (!email) {
    throw new Error(
      context === "save"
        ? "Usage: agyx save [name] [--email EMAIL]. Profile name could not be inferred because no active Google account email was found."
      : "Usage: agyx login [name] [--email EMAIL] [--no-resume]. Profile name could not be inferred because login email was not detected.",
    );
  }
  const existingByEmail = state.profiles.find((profile) => profile.email === email);
  if (existingByEmail) return existingByEmail.name;
  return uniqueProfileName(profileNameFromEmail(email), state);
}

export async function saveCurrent(
  nameInput?: string,
  explicitEmail?: string,
): Promise<ProfileCaptureResult> {
  const state = await loadState();
  const activeProfileEmail = state.profiles.find(
    (profile) => profile.name === state.activeProfile,
  )?.email;
  const email = explicitEmail ?? await readActiveGoogleAccountEmail() ?? activeProfileEmail;
  const name = resolveProfileName(state, nameInput, email, "save");
  const credential = await keychain.readActive();
  await keychain.writeProfile(name, credential);
  await upsertProfile(name, email, true, false);
  return { name, email };
}

export async function activateProfile(nameInput: string): Promise<void> {
  const name = validateProfileName(nameInput);
  const state = await loadState();
  if (!state.profiles.some((profile) => profile.name === name)) {
    throw new Error(`Profile not found: ${name}`);
  }
  const credential = await keychain.readProfile(name);
  await keychain.writeActive(credential);
  markProfileActivated(state, name);
  await saveState(state);
}

export async function switchProfile(name: string): Promise<void> {
  const sessions = await pauseAll();
  try {
    await activateProfile(name);
  } finally {
    await resumeAll(sessions);
  }
}

export function detectEmail(content: string): string | undefined {
  const matches = [...content.matchAll(
    /authenticated successfully as ([^\s]+@[^\s]+)/gi,
  )];
  return matches.at(-1)?.[1];
}

async function interactiveLogin(logPath: string): Promise<string | undefined> {
  const realAgy = await findRealAgy();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(realAgy, ["--log-file", logPath], { stdio: "inherit" });
    let detectedEmail: string | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const interval = setInterval(async () => {
      try {
        const email = detectEmail(await readFile(logPath, "utf8"));
        if (!email || detectedEmail) return;
        detectedEmail = email;
        clearInterval(interval);
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
          terminationTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 5000);
        }, 750);
      } catch {
        // Wait for the log file and successful OAuth line.
      }
    }, 200);
    child.on("error", (error) => {
      clearInterval(interval);
      reject(error);
    });
    child.on("exit", () => {
      clearInterval(interval);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolvePromise(detectedEmail);
    });
  });
}

export async function loginProfile(
  nameInput?: string,
  explicitEmail?: string,
  resume = true,
): Promise<ProfileCaptureResult> {
  const sessions = await pauseAll();
  const state = await loadState();
  const previousCredential = await keychain.readActive().catch(() => undefined);
  if (state.activeProfile && previousCredential) {
    await keychain.writeProfile(state.activeProfile, previousCredential);
  }

  const logPath = join(logDir, `login-${Date.now()}.log`);
  try {
    await keychain.deleteActive();
    console.log("Complete Google sign-in in the browser. agyx will continue automatically.");
    const detectedEmail = await interactiveLogin(logPath);
    const credential = await keychain.readActive().catch(() => undefined);
    if (!credential) throw new Error("Login ended without creating an agy credential.");
    const email = explicitEmail ?? detectedEmail ?? await readActiveGoogleAccountEmail();
    const name = resolveProfileName(await loadState(), nameInput, email, "login");
    await keychain.writeProfile(name, credential);
    await upsertProfile(name, email, true);
    console.log(`Captured and activated profile '${name}'.`);
    return { name, email };
  } catch (error) {
    if (previousCredential) await keychain.writeActive(previousCredential);
    await saveState(state);
    throw error;
  } finally {
    if (resume) await resumeAll(sessions);
  }
}
