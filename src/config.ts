import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProfileRecord {
  name: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
  authenticatedAt?: string;
  lastActivatedAt?: string;
  lastRequestAt?: string;
  lastSuccessfulRequestAt?: string;
  lastQuotaErrorAt?: string;
  quotaResetAt?: string;
  quotaStatus?: "unknown" | "available" | "exhausted";
  lastQuotaReason?: string;
  selectionCount?: number;
  disabled?: boolean;
  priority?: number;
}

export interface State {
  version: 1;
  activeProfile?: string;
  realAgyPath?: string;
  onboarding?: {
    shellIntegrationPromptedAt?: string;
    shellIntegrationInstalledAt?: string;
    githubStarPromptedAt?: string;
    githubStarredAt?: string;
  };
  profiles: ProfileRecord[];
}

export const configDir = process.env.AGYX_CONFIG_DIR
  ?? join(homedir(), ".config", "agyx");
export const runtimeDir = join(configDir, "run");
export const logDir = join(configDir, "logs");
export const statePath = join(configDir, "state.json");

export async function ensureDirectories(): Promise<void> {
  for (const directory of [configDir, runtimeDir, logDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, profiles: [] };
    }
    throw error;
  }
}

export async function saveState(state: State): Promise<void> {
  await ensureDirectories();
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

export async function upsertProfile(
  name: string,
  email: string | undefined,
  makeActive: boolean,
  countActivation = makeActive,
): Promise<void> {
  const state = await loadState();
  const now = new Date();
  const nowString = now.toISOString();
  const existing = state.profiles.find((profile) => profile.name === name);
  if (existing) {
    existing.email = email ?? existing.email;
    existing.authenticatedAt = nowString;
    existing.updatedAt = nowString;
    if (existing.quotaStatus === "exhausted") {
      existing.quotaStatus = "available";
      existing.quotaResetAt = undefined;
      existing.lastQuotaReason = undefined;
    }
  } else {
    state.profiles.push({
      name,
      email,
      createdAt: nowString,
      updatedAt: nowString,
      authenticatedAt: nowString,
      quotaStatus: "available",
      selectionCount: 0,
    });
  }
  state.profiles.sort((left, right) => left.name.localeCompare(right.name));
  if (makeActive) markProfileActivated(state, name, now, countActivation);
  await saveState(state);
}

export function markProfileActivated(
  state: State,
  name: string,
  now = new Date(),
  incrementSelection = true,
): void {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  const nowString = now.toISOString();
  state.activeProfile = name;
  profile.lastActivatedAt = nowString;
  profile.updatedAt = nowString;
  if (incrementSelection) {
    profile.selectionCount = (profile.selectionCount ?? 0) + 1;
  }
  if (
    profile.quotaStatus === "exhausted"
    && profile.quotaResetAt
    && Date.parse(profile.quotaResetAt) <= now.getTime()
  ) {
    profile.quotaStatus = "available";
    profile.quotaResetAt = undefined;
    profile.lastQuotaReason = undefined;
  }
}

export function markProfileRequest(
  state: State,
  name: string,
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return;
  const nowString = now.toISOString();
  profile.lastRequestAt = nowString;
  profile.updatedAt = nowString;
  if (profile.quotaStatus !== "exhausted") profile.quotaStatus = "available";
}

export function markProfileQuotaExhausted(
  state: State,
  name: string,
  event: { reason: string; resetAt?: string },
  now = new Date(),
): void {
  const profile = state.profiles.find((entry) => entry.name === name);
  if (!profile) return;
  const nowString = now.toISOString();
  profile.quotaStatus = "exhausted";
  profile.lastQuotaErrorAt = nowString;
  profile.lastQuotaReason = event.reason;
  profile.quotaResetAt = event.resetAt;
  profile.updatedAt = nowString;
}

export async function recordProfileQuotaExhausted(
  name: string,
  event: { reason: string; resetAt?: string },
): Promise<void> {
  const state = await loadState();
  markProfileQuotaExhausted(state, name, event);
  await saveState(state);
}

export async function recordProfileRequest(
  name: string,
  now = new Date(),
): Promise<void> {
  const state = await loadState();
  markProfileRequest(state, name, now);
  await saveState(state);
}

export async function cleanupRuntimeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export function validateProfileName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name '${name}'. Use letters, numbers, '.', '_' or '-'.`,
    );
  }
  return name;
}

export function profileNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const normalized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, "-");
  return validateProfileName(normalized || "account");
}

export function uniqueProfileName(baseName: string, state: State): string {
  const base = validateProfileName(baseName);
  const names = new Set(state.profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused profile name for '${base}'.`);
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
