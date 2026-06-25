import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProfileRecord {
  name: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
}

export interface State {
  version: 1;
  activeProfile?: string;
  realAgyPath?: string;
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
): Promise<void> {
  const state = await loadState();
  const now = new Date().toISOString();
  const existing = state.profiles.find((profile) => profile.name === name);
  if (existing) {
    existing.email = email ?? existing.email;
    existing.updatedAt = now;
  } else {
    state.profiles.push({ name, email, createdAt: now, updatedAt: now });
  }
  state.profiles.sort((left, right) => left.name.localeCompare(right.name));
  if (makeActive) state.activeProfile = name;
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

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}
