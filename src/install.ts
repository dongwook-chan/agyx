import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureParent } from "./config.js";
import { findRealAgy } from "./processes.js";

const startMarker = "# >>> agyx >>>";
const endMarker = "# <<< agyx <<<";

export function shellInit(): string {
  return `agy() { command agyx session -- "$@"; }`;
}

export async function installShellIntegration(): Promise<string> {
  await findRealAgy();
  const shell = process.env.SHELL?.split("/").at(-1) ?? "zsh";
  const rcPath = shell === "bash"
    ? join(homedir(), ".bashrc")
    : join(homedir(), ".zshrc");
  await ensureParent(rcPath);
  let content = "";
  try { content = await readFile(rcPath, "utf8"); }
  catch { /* New shell rc file. */ }
  const block = `${startMarker}\n${shellInit()}\n${endMarker}`;
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, "m");
  content = pattern.test(content)
    ? content.replace(pattern, block)
    : `${content.trimEnd()}\n\n${block}\n`;
  await writeFile(rcPath, content, { mode: 0o600 });
  await chmod(rcPath, 0o600);
  return rcPath;
}
