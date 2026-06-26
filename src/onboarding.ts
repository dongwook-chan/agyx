import { loadState, saveState } from "./config.js";
import { installShellIntegration, shellIntegrationInstalled } from "./install.js";
import { run } from "./processes.js";
import { confirmAction } from "./ui.js";

const repository = "dongwook-chan/agyx";

async function ghInstalled(): Promise<boolean> {
  const result = await run(
    "/bin/sh",
    ["-lc", "command -v gh >/dev/null 2>&1"],
    { allowFailure: true },
  );
  return result.code === 0;
}

async function promptShellIntegration(): Promise<void> {
  const state = await loadState();
  if (state.onboarding?.shellIntegrationPromptedAt) return;
  if (await shellIntegrationInstalled()) return;

  const now = new Date().toISOString();
  state.onboarding = {
    ...state.onboarding,
    shellIntegrationPromptedAt: now,
  };
  await saveState(state);

  if (!await confirmAction("Install agy shell integration so `agy` runs through agyx?", true)) {
    console.log("Skipped shell integration. You can run it later with: agyx install");
    return;
  }

  const path = await installShellIntegration();
  const updated = await loadState();
  updated.onboarding = {
    ...updated.onboarding,
    shellIntegrationInstalledAt: new Date().toISOString(),
  };
  await saveState(updated);
  console.log(`Installed agy shell function in ${path}`);
  console.log("This does not change the current terminal automatically.");
  console.log("Open a new terminal, or run:");
  console.log(`  source ${path}`);
  console.log("For this terminal only, you can also run:");
  console.log('  eval "$(agyx shell-init)"');
  console.log("Verify with:");
  console.log("  type agy");
}

async function promptGithubStar(): Promise<void> {
  const state = await loadState();
  if (state.onboarding?.githubStarPromptedAt || state.onboarding?.githubStarredAt) return;
  if (!await ghInstalled()) return;

  const now = new Date().toISOString();
  state.onboarding = {
    ...state.onboarding,
    githubStarPromptedAt: now,
  };
  await saveState(state);

  if (!await confirmAction(`Star ${repository} on GitHub with gh?`, false)) return;

  try {
    await run("/usr/bin/env", [
      "gh",
      "api",
      "--method", "PUT",
      "/user/starred/dongwook-chan/agyx",
      "--silent",
    ]);
    const updated = await loadState();
    updated.onboarding = {
      ...updated.onboarding,
      githubStarredAt: new Date().toISOString(),
    };
    await saveState(updated);
    console.log(`Starred ${repository}.`);
  } catch (error) {
    console.error(`agyx: failed to star ${repository}: ${(error as Error).message}`);
  }
}

export async function maybeRunOnboarding(command: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (process.env.AGYX_NO_ONBOARDING === "1") return;
  if (["session", "shell-init", "_activate"].includes(command)) return;

  if (command !== "install") await promptShellIntegration();
  await promptGithubStar();
}
