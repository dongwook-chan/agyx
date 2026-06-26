import { confirm, select } from "@inquirer/prompts";
import Table from "cli-table3";
import stringWidth from "string-width";
import { ProfileRecord } from "./config.js";
import { effectiveProfileStatus, selectNextProfile } from "./selection.js";

export function relativeTime(value: string | undefined, now = new Date()): string {
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

export function profileStatusText(profile: ProfileRecord, now = new Date()): string {
  const status = effectiveProfileStatus(profile, now);
  if (status === "disabled") return "disabled";
  if (status === "exhausted") return "quota";
  return profile.quotaStatus === "available" ? "ready" : "unknown";
}

function padEndWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}

function padStartWidth(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - stringWidth(value))) + value;
}

function profileRows(profiles: ProfileRecord[], activeProfile?: string, now = new Date()) {
  return profiles.map((profile, index) => ({
    marker: profile.name === activeProfile ? "*" : "",
    number: String(index + 1),
    name: profile.name,
    email: profile.email ?? "-",
    status: profileStatusText(profile, now),
    reset: relativeTime(profile.quotaResetAt, now),
    lastUsed: relativeTime(profile.lastActivatedAt, now),
    picks: String(profile.selectionCount ?? 0),
    profile,
  }));
}

export function printProfileTable(
  profiles: ProfileRecord[],
  activeProfile?: string,
): void {
  if (!profiles.length) {
    console.log("No saved profiles.");
    return;
  }

  const table = new Table({
    head: ["", "#", "name", "email", "status", "reset", "last-used", "picks"],
    colAligns: ["center", "right", "left", "left", "left", "left", "left", "right"],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const row of profileRows(profiles, activeProfile)) {
    table.push([
      row.marker,
      row.number,
      row.name,
      row.email,
      row.status,
      row.reset,
      row.lastUsed,
      row.picks,
    ]);
  }

  console.log(table.toString());
}

export async function confirmAction(
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  return await confirm({ message, default: defaultValue });
}

export async function selectProfileName(
  profiles: ProfileRecord[],
  activeProfile?: string,
): Promise<string> {
  if (!profiles.length) throw new Error("No saved profiles.");

  const rows = profileRows(profiles, activeProfile);
  const widths = {
    number: Math.max(...rows.map((row) => stringWidth(row.number))),
    name: Math.max(...rows.map((row) => stringWidth(row.name))),
    status: Math.max(...rows.map((row) => stringWidth(row.status))),
    reset: Math.max(...rows.map((row) => stringWidth(row.reset))),
    lastUsed: Math.max(...rows.map((row) => stringWidth(row.lastUsed))),
    picks: Math.max(...rows.map((row) => stringWidth(row.picks))),
  };

  const suggested = (() => {
    try {
      return selectNextProfile({ version: 1, activeProfile, profiles }).name;
    } catch {
      return undefined;
    }
  })();

  return await select<string>({
    message: suggested
      ? `Select profile (default: next ${suggested})`
      : "Select profile",
    default: suggested,
    choices: rows.map((row) => ({
      value: row.profile.name,
      name: [
        row.marker || " ",
        padStartWidth(row.number, widths.number),
        padEndWidth(row.name, widths.name),
        padEndWidth(row.status, widths.status),
        padEndWidth(row.reset, widths.reset),
        padEndWidth(row.lastUsed, widths.lastUsed),
        padStartWidth(row.picks, widths.picks),
        row.email,
      ].join("  "),
      description: row.profile.name === suggested ? "next" : undefined,
    })),
  });
}
