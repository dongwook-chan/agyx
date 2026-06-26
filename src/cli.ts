#!/usr/bin/env node
import {
  activateProfile,
  loginProfile,
  pauseAll,
  resumeAll,
  saveCurrent,
  sessionRecords,
  switchProfile,
  switchToNextProfile,
  verifyAllProfiles,
} from "./coordinator.js";
import {
  installShellIntegration,
  shellInit,
  shellIntegrationInstalled,
  shellIntegrationPath,
} from "./install.js";
import { keychain } from "./keychain.js";
import { maybeRunOnboarding } from "./onboarding.js";
import { findRealAgy } from "./processes.js";
import { loadState, saveState, validateProfileName } from "./config.js";
import { supervise } from "./session.js";
import { confirmAction, pickProfileAction, printProfileTable, promptText } from "./ui.js";

const help = `agyx — multi-account session supervisor for Antigravity CLI

Usage:
  agyx install                         Install agy shell function
  agyx session -- [agy options]        Run agy under a restartable supervisor
  agyx save [name] [--email EMAIL]     Save the current Keychain account
  agyx login [name] [--email EMAIL] [--no-resume]
                                       Pause all sessions and add an account
  agyx use [name]                      Switch account and resume every session
  agyx next                            Rotate to the next selectable account
  agyx list [--verify]                 List profiles; optionally verify saved credentials
  agyx current                         Print the active profile
  agyx status                          List supervised terminal sessions
  agyx pause | resume                  Pause or resume all supervised sessions
  agyx rename <old> <new>              Rename a saved profile
  agyx remove <name>                   Delete a saved profile
  agyx shell-init                      Print the shell integration function
  agyx doctor                          Diagnose the installation

All arguments passed through "agy" are forwarded to the real agy executable.
Non-interactive --print/--prompt commands are not automatically restarted.`;

function printSwitchResult(result: { name: string; email?: string; alreadyActive?: boolean }): void {
  if (result.alreadyActive) {
    console.log(
      `Profile '${result.name}' is already active.`
      + (result.email ? ` (${result.email})` : ""),
    );
    return;
  }
  console.log(
    `Activated profile '${result.name}'`
    + (result.email ? ` (${result.email})` : "")
    + " and resumed all sessions.",
  );
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args.splice(index, 2)[1];
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOptionalName(args: string[], usage: string): string | undefined {
  if (args.length > 1) throw new Error(`Usage: ${usage}`);
  return args.shift();
}

async function removeProfile(name: string): Promise<void> {
  validateProfileName(name);
  await keychain.deleteProfile(name);
  const state = await loadState();
  state.profiles = state.profiles.filter((profile) => profile.name !== name);
  if (state.activeProfile === name) state.activeProfile = undefined;
  await saveState(state);
}

async function renameProfile(oldNameInput: string, newNameInput: string): Promise<boolean> {
  const oldName = validateProfileName(oldNameInput);
  const newName = validateProfileName(newNameInput.trim());
  if (oldName === newName) return false;

  const state = await loadState();
  const profile = state.profiles.find((entry) => entry.name === oldName);
  if (!profile) throw new Error(`Profile not found: ${oldName}`);
  if (state.profiles.some((entry) =>
    entry !== profile
    && (entry.name === newName || entry.previousNames?.includes(newName))
  )) {
    throw new Error(`Profile already exists: ${newName}`);
  }

  const credential = await keychain.readProfile(oldName);
  await keychain.writeProfile(newName, credential);
  const previousNames = new Set(profile.previousNames ?? []);
  previousNames.delete(newName);
  previousNames.add(oldName);
  profile.previousNames = [...previousNames].sort();
  profile.name = newName;
  profile.updatedAt = new Date().toISOString();
  if (state.activeProfile === oldName) state.activeProfile = newName;
  state.profiles.sort((left, right) => left.name.localeCompare(right.name));
  await saveState(state);
  await keychain.deleteProfile(oldName);
  return true;
}

async function confirmAndRemoveProfile(name: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing to delete without an interactive confirmation.");
  }
  const confirmed = await confirmAction(`Delete profile '${name}'?`, false);
  if (!confirmed) return false;
  await removeProfile(name);
  return true;
}

async function promptAndRenameProfile(name: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Refusing to rename without an interactive terminal.");
  }
  const nextName = (await promptText(`Rename profile '${name}' to`)).trim();
  if (!nextName || nextName === name) return undefined;
  const renamed = await renameProfile(name, nextName);
  return renamed ? nextName : undefined;
}

async function browseProfiles(mode: "list" | "use"): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (mode === "list") {
      printProfileTable(await loadState());
      return undefined;
    }
    throw new Error("Usage: agyx use <name> or run 'agyx use' in an interactive terminal.");
  }

  let notice: string | undefined;
  while (true) {
    const state = await loadState();
    const action = await pickProfileAction(state, mode, notice);
    notice = undefined;
    if (action.type === "exit") return undefined;
    if (action.type === "select") return action.name;
    if (action.type === "delete") {
      if (await confirmAndRemoveProfile(action.name)) {
        notice = `Removed profile '${action.name}'.`;
      }
    } else if (action.type === "rename") {
      const nextName = await promptAndRenameProfile(action.name);
      if (nextName) {
        notice = `Renamed profile '${action.name}' to '${nextName}'.`;
      }
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
    return 0;
  }
  await maybeRunOnboarding(command);

  switch (command) {
    case "install": {
      const path = await installShellIntegration();
      console.log(`Installed agy shell function in ${path}`);
      console.log("This does not change the current terminal automatically.");
      console.log("Open a new terminal, or run:");
      console.log(`  source ${path}`);
      console.log("For this terminal only, you can also run:");
      console.log('  eval "$(agyx shell-init)"');
      console.log("Verify with:");
      console.log("  type agy");
      return 0;
    }
    case "shell-init":
      console.log(shellInit());
      return 0;
    case "session":
      if (args[0] === "--") args.shift();
      return await supervise(args);
    case "save": {
      const email = takeOption(args, "--email");
      const name = takeOptionalName(args, "agyx save [name] [--email EMAIL]");
      const result = await saveCurrent(name, email);
      console.log(
        `Saved and activated profile '${result.name}'.`
        + (result.email ? ` (${result.email})` : ""),
      );
      return 0;
    }
    case "login": {
      const email = takeOption(args, "--email");
      const noResume = takeFlag(args, "--no-resume");
      const name = takeOptionalName(args, "agyx login [name] [--email EMAIL] [--no-resume]");
      await loginProfile(name, email, !noResume);
      return 0;
    }
    case "use": {
      const name = args.shift();
      if (args.length) throw new Error("Usage: agyx use [name]");
      const selected = name ?? await browseProfiles("use");
      if (!selected) return 0;
      const result = await switchProfile(selected);
      printSwitchResult(result);
      return 0;
    }
    case "next": {
      const result = await switchToNextProfile();
      printSwitchResult(result);
      return 0;
    }
    case "list": {
      const verify = takeFlag(args, "--verify");
      if (args.length) throw new Error("Usage: agyx list [--verify]");
      const state = verify ? await verifyAllProfiles() : await loadState();
      if (process.stdin.isTTY && process.stdout.isTTY) {
        let notice: string | undefined;
        while (true) {
          const action = await pickProfileAction(await loadState(), "list", notice);
          notice = undefined;
          if (action.type === "exit") break;
          if (action.type === "delete") {
            if (await confirmAndRemoveProfile(action.name)) {
              notice = `Removed profile '${action.name}'.`;
            }
          } else if (action.type === "rename") {
            const nextName = await promptAndRenameProfile(action.name);
            if (nextName) {
              notice = `Renamed profile '${action.name}' to '${nextName}'.`;
            }
          }
        }
      } else {
        printProfileTable(state);
      }
      return 0;
    }
    case "current":
      console.log((await loadState()).activeProfile ?? "unmanaged");
      return 0;
    case "status": {
      const records = await sessionRecords();
      if (!records.length) console.log("No supervised agy sessions.");
      for (const record of records) {
        console.log(
          `${record.id}  pid=${record.pid} child=${record.childPid ?? "-"}`
          + `  ${record.paused ? "paused" : "running"}  cwd=${record.cwd}`
          + (record.conversationId ? `  conversation=${record.conversationId}` : ""),
        );
      }
      return 0;
    }
    case "pause": {
      const records = await pauseAll();
      console.log(`Paused ${records.length} supervised session(s).`);
      return 0;
    }
    case "resume": {
      const records = await sessionRecords();
      await resumeAll(records);
      console.log(`Resumed ${records.length} supervised session(s).`);
      return 0;
    }
    case "rename": {
      const oldName = args.shift();
      const newName = args.shift();
      if (!oldName || !newName || args.length) {
        throw new Error("Usage: agyx rename <old> <new>");
      }
      const renamed = await renameProfile(oldName, newName);
      console.log(renamed
        ? `Renamed profile '${oldName}' to '${newName}'.`
        : `Profile '${oldName}' is already named '${newName}'.`);
      return 0;
    }
    case "remove": {
      const name = args.shift();
      if (!name || args.length) throw new Error("Usage: agyx remove <name>");
      await confirmAndRemoveProfile(name);
      return 0;
    }
    case "doctor": {
      const state = await loadState();
      const sessions = await sessionRecords();
      console.log(`agy: ${await findRealAgy()}`);
      console.log(`platform: ${process.platform}`);
      console.log(`shell integration file: ${shellIntegrationPath()}`);
      console.log(`shell integration installed: ${await shellIntegrationInstalled() ? "yes" : "no"}`);
      console.log("current shell check: run `type agy` in your terminal; it should report a shell function");
      console.log(`profiles: ${state.profiles.length}`);
      console.log(`active profile: ${state.activeProfile ?? "unmanaged"}`);
      console.log(`supervised sessions: ${sessions.length}`);
      return 0;
    }
    case "_activate":
      await activateProfile(args[0] ?? "");
      return 0;
    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`agyx: ${(error as Error).message}`);
    process.exitCode = 1;
  });
