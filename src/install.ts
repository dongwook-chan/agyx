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
    "  if ! command -v agyx-supervisor > /dev/null 2>&1; then",
    "    command agyx-agy \"$@\"",
    "    return",
    "  fi",
    "  # Non-interactive (print/prompt) mode: run once, no restart",
    "  for arg in \"$@\"; do",
    "    case \"$arg\" in -p|--print|--prompt) command agyx-supervisor \"$@\"; return ;; esac",
    "  done",
    "  # Interactive mode: auto-restart on unexpected exit",
    "  local _agyx_conversation=\"\"",
    "  while true; do",
    "    local _start_time=$(date +%s)",
    "    if [ -n \"$_agyx_conversation\" ]; then",
    "      command agyx-supervisor --conversation \"$_agyx_conversation\" \"$@\"",
    "    else",
    "      command agyx-supervisor \"$@\"",
    "    fi",
    "    local _agyx_exit=$?",
    "    local _end_time=$(date +%s)",
    "    local _duration=$((_end_time - _start_time))",
    "    # Exit 0 = clean quit, exit 2 = flag error, exit 130 = Ctrl+C",
    "    if [ $_agyx_exit -eq 0 ] || [ $_agyx_exit -eq 2 ] || [ $_agyx_exit -eq 130 ]; then",
    "      break",
    "    fi",
    "    # If the process ran for less than 3 seconds, it's likely a configuration/crash loop",
    "    if [ $_duration -lt 3 ]; then",
    "      echo \"[agyx] Session exited too quickly (exit $_agyx_exit, duration ${_duration}s). Disabling auto-restart.\"",
    "      break",
    "    fi",
    "    # Unexpected exit: extract last conversation ID from agyx status and restart",
    "    _agyx_conversation=$(agyx status 2>/dev/null | grep -o 'conversation=[^ ]*' | tail -1 | cut -d= -f2)",
    "    if [ -z \"$_agyx_conversation\" ]; then",
    "      break",
    "    fi",
    "    echo \"[agyx] Session ended (exit $_agyx_exit). Restarting conversation $_agyx_conversation...\"",
    "    sleep 1",
    "  done",
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
