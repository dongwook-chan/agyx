#!/usr/bin/env node
import {
  activateProfile,
  loginProfile,
  pauseAll,
  resumeAll,
  saveCurrent,
  sessionRecords,
  switchProfile,
} from "./coordinator.js";
import { installShellIntegration, shellInit } from "./install.js";
import { keychain } from "./keychain.js";
import { findRealAgy } from "./processes.js";
import { loadState, saveState, validateProfileName } from "./config.js";
import { supervise } from "./session.js";

const help = `agyx — multi-account session supervisor for Antigravity CLI

Usage:
  agyx install                         Install transparent agy shell shim
  agyx session -- [agy options]        Run agy under a restartable supervisor
  agyx save <name> [--email EMAIL]     Save the current Keychain account
  agyx login <name> [--no-resume]      Pause all sessions and add an account
  agyx use <name>                      Switch account and resume every session
  agyx next                            Rotate to the next saved account
  agyx list                            List profiles
  agyx current                         Print the active profile
  agyx status                          List supervised terminal sessions
  agyx pause | resume                  Pause or resume all supervised sessions
  agyx remove <name>                   Delete a saved profile
  agyx shell-init                      Print the shell integration function
  agyx doctor                          Diagnose the installation

All arguments passed through "agy" are forwarded to the real agy executable.
Non-interactive --print/--prompt commands are not automatically restarted.`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args.splice(index, 2)[1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
    return 0;
  }

  switch (command) {
    case "install": {
      const path = await installShellIntegration();
      console.log(`Installed agyx shell integration in ${path}`);
      console.log("Open a new terminal or run: source " + path);
      return 0;
    }
    case "shell-init":
      console.log(shellInit());
      return 0;
    case "session":
      if (args[0] === "--") args.shift();
      return await supervise(args);
    case "save": {
      const name = args.shift();
      if (!name) throw new Error("Usage: agyx save <name> [--email EMAIL]");
      const email = takeOption(args, "--email");
      if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
      await saveCurrent(name, email);
      console.log(`Saved and activated profile '${name}'.`);
      return 0;
    }
    case "login": {
      const name = args.shift();
      if (!name) throw new Error("Usage: agyx login <name> [--email EMAIL] [--no-resume]");
      const email = takeOption(args, "--email");
      const noResume = args.includes("--no-resume");
      args.splice(args.indexOf("--no-resume"), noResume ? 1 : 0);
      if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
      await loginProfile(name, email, !noResume);
      return 0;
    }
    case "use": {
      const name = args.shift();
      if (!name || args.length) throw new Error("Usage: agyx use <name>");
      await switchProfile(name);
      console.log(`Activated profile '${name}' and resumed all sessions.`);
      return 0;
    }
    case "next": {
      const state = await loadState();
      if (!state.profiles.length) throw new Error("No saved profiles.");
      const index = state.activeProfile
        ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
        : -1;
      const name = state.profiles[(index + 1) % state.profiles.length]!.name;
      await switchProfile(name);
      console.log(`Activated profile '${name}' and resumed all sessions.`);
      return 0;
    }
    case "list": {
      const state = await loadState();
      if (!state.profiles.length) console.log("No saved profiles.");
      for (const profile of state.profiles) {
        console.log(
          `${profile.name === state.activeProfile ? "*" : " "} ${profile.name}`
          + (profile.email ? `  ${profile.email}` : ""),
        );
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
    case "remove": {
      const name = args.shift();
      if (!name || args.length) throw new Error("Usage: agyx remove <name>");
      validateProfileName(name);
      await keychain.deleteProfile(name);
      const state = await loadState();
      state.profiles = state.profiles.filter((profile) => profile.name !== name);
      if (state.activeProfile === name) state.activeProfile = undefined;
      await saveState(state);
      console.log(`Removed profile '${name}'.`);
      return 0;
    }
    case "doctor": {
      const state = await loadState();
      const sessions = await sessionRecords();
      console.log(`agy: ${await findRealAgy()}`);
      console.log(`platform: ${process.platform}`);
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
