import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureParent } from "./config.js";
import { findRealAgy } from "./processes.js";

const startMarker = "# >>> agyx >>>";
const endMarker = "# <<< agyx <<<";

export function shellIntegrationPath(): string {
  const shell = process.env.SHELL?.split("/").at(-1) ?? "zsh";
  return shell === "bash"
    ? join(homedir(), ".bashrc")
    : join(homedir(), ".zshrc");
}

export function shellInit(): string {
  return [
    "agy() {",
    "  if command -v agyx-supervisor >/dev/null 2>&1; then",
    "    command agyx-supervisor \"$@\"",
    "  else",
    "    command agyx-agy \"$@\"",
    "  fi",
    "}",
  ].join("\n");
}

export async function shellIntegrationInstalled(): Promise<boolean> {
  const rcPath = shellIntegrationPath();
  try {
    return (await readFile(rcPath, "utf8")).includes(startMarker);
  } catch {
    return false;
  }
}

export async function installShellIntegration(): Promise<string> {
  await findRealAgy();
  const rcPath = shellIntegrationPath();
  await ensureParent(rcPath);
  let content = "";
  let existing = true;
  try { content = await readFile(rcPath, "utf8"); }
  catch { existing = false; }
  const block = `${startMarker}\n${shellInit()}\n${endMarker}`;
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, "m");
  const trimmed = content.trimEnd();
  content = pattern.test(content)
    ? content.replace(pattern, block)
    : `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
  await writeFile(rcPath, content, { mode: 0o600 });
  if (!existing) await chmod(rcPath, 0o600);
  return rcPath;
}
