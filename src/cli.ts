#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
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
import { maybeRunOnboarding } from "./onboarding.js";
import { findRealAgy } from "./processes.js";
import { ProfileRecord, loadState, saveState, validateProfileName } from "./config.js";
import { effectiveProfileStatus, selectNextProfile } from "./selection.js";
import { supervise } from "./session.js";

const help = `agyx — multi-account session supervisor for Antigravity CLI

Usage:
  agyx install                         Install transparent agy shell shim
  agyx session -- [agy options]        Run agy under a restartable supervisor
  agyx save [name] [--email EMAIL]     Save the current Keychain account
  agyx login [name] [--email EMAIL] [--no-resume]
                                       Pause all sessions and add an account
  agyx use [name]                      Switch account and resume every session
  agyx next                            Rotate to the next selectable account
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

function relativeTime(value: string | undefined, now = new Date()): string {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "-";
  const delta = timestamp - now.getTime();
  const absolute = Math.abs(delta);
  const units: Array<[number, string]> = [
    [24 * 60 * 60 * 1000, "d"],
    [60 * 60 * 1000, "h"],
    [60 * 1000, "m"],
    [1000, "s"],
  ];
  const [unitMs, suffix] = units.find(([ms]) => absolute >= ms) ?? units.at(-1)!;
  const amount = Math.max(1, Math.round(absolute / unitMs));
  return delta >= 0 ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
}

function profileStatusText(profile: ProfileRecord, now = new Date()): string {
  const status = effectiveProfileStatus(profile, now);
  if (status === "disabled") return "disabled";
  if (status === "exhausted") return "quota";
  return profile.quotaStatus === "available" ? "ready" : "unknown";
}

function profileRow(
  index: number,
  profile: ProfileRecord,
  activeProfile: string | undefined,
  now = new Date(),
): string {
  const marker = profile.name === activeProfile ? "*" : " ";
  const number = String(index + 1).padStart(2);
  const name = profile.name.padEnd(18);
  const email = (profile.email ?? "-").padEnd(28);
  const status = profileStatusText(profile, now).padEnd(8);
  const reset = relativeTime(profile.quotaResetAt, now).padEnd(8);
  const lastUsed = relativeTime(profile.lastActivatedAt, now).padEnd(9);
  const picks = String(profile.selectionCount ?? 0).padStart(5);
  return `${marker} ${number} ${name} ${email} ${status} ${reset} ${lastUsed} ${picks}`;
}

function printProfiles(profiles: ProfileRecord[], activeProfile?: string): void {
  if (!profiles.length) {
    console.log("No saved profiles.");
    return;
  }
  const now = new Date();
  console.log("    # name               email                        status   reset    last-used picks");
  for (const [index, profile] of profiles.entries()) {
    console.log(profileRow(index, profile, activeProfile, now));
  }
}

async function pickProfile(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Usage: agyx use <name> or run 'agyx use' in an interactive terminal.");
  }
  const state = await loadState();
  if (!state.profiles.length) throw new Error("No saved profiles.");
  printProfiles(state.profiles, state.activeProfile);
  const suggested = (() => {
    try { return selectNextProfile(state).name; }
    catch { return undefined; }
  })();
  const prompt = suggested
    ? `Select profile number/name [next: ${suggested}]: `
    : "Select profile number/name: ";
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await interface_.question(prompt)).trim();
    if (!answer && suggested) return suggested;
    if (!answer) throw new Error("No profile selected.");
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= state.profiles.length) {
      return state.profiles[index - 1]!.name;
    }
    const profile = state.profiles.find(({ name }) => name === answer);
    if (!profile) throw new Error(`Profile not found: ${answer}`);
    return profile.name;
  } finally {
    interface_.close();
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
      const selected = name ?? await pickProfile();
      await switchProfile(selected);
      console.log(`Activated profile '${selected}' and resumed all sessions.`);
      return 0;
    }
    case "next": {
      const state = await loadState();
      const name = selectNextProfile(state).name;
      await switchProfile(name);
      console.log(`Activated profile '${name}' and resumed all sessions.`);
      return 0;
    }
    case "list": {
      const state = await loadState();
      printProfiles(state.profiles, state.activeProfile);
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
