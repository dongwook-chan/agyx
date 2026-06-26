import { createInterface } from "node:readline/promises";
import { loadState, saveState } from "./config.js";
import { installShellIntegration, shellIntegrationInstalled } from "./install.js";
import { run } from "./processes.js";

const repository = "dongwook-chan/agyx";

async function ask(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await interface_.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return ["y", "yes"].includes(answer);
  } finally {
    interface_.close();
  }
}

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

  if (!await ask("Install agy shell integration so `agy` runs through agyx?", true)) {
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
  console.log(`Installed shell integration in ${path}`);
  console.log(`Run now: source ${path}`);
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

  if (!await ask(`Star ${repository} on GitHub with gh?`, false)) return;

  try {
    await run("/usr/bin/env", ["gh", "repo", "star", repository]);
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

