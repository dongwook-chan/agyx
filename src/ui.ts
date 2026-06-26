import { confirm, select } from "@inquirer/prompts";
import Table from "cli-table3";
import stringWidth from "string-width";
import { State } from "./config.js";
import { buildProfileViews, ProfileView } from "./profile_view.js";
import { selectNextProfile } from "./selection.js";

function padEndWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}

function padStartWidth(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - stringWidth(value))) + value;
}

function profileRows(state: Pick<State, "activeProfile" | "profiles">): ProfileView[] {
  return buildProfileViews(state);
}

export function printProfileTable(state: Pick<State, "activeProfile" | "profiles">): void {
  if (!state.profiles.length) {
    console.log("No saved profiles.");
    return;
  }

  const table = new Table({
    head: [
      "",
      "#",
      "name",
      "expected-email",
      "actual-email",
      "status",
      "quota-reset",
      "last-request",
      "activated",
      "verified",
      "switches",
    ],
    colAligns: [
      "center",
      "right",
      "left",
      "left",
      "left",
      "left",
      "left",
      "left",
      "left",
      "left",
      "right",
    ],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const row of profileRows(state)) {
    table.push([
      row.marker,
      row.number,
      row.name,
      row.expectedEmail,
      row.actualEmail,
      row.status,
      row.quotaReset,
      row.lastRequest,
      row.activated,
      row.verified,
      row.switches,
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
  state: Pick<State, "activeProfile" | "profiles">,
): Promise<string> {
  if (!state.profiles.length) throw new Error("No saved profiles.");

  const rows = profileRows(state);
  const widths = {
    number: Math.max(...rows.map((row) => stringWidth(row.number))),
    name: Math.max(...rows.map((row) => stringWidth(row.name))),
    status: Math.max(...rows.map((row) => stringWidth(row.status))),
    quotaReset: Math.max(...rows.map((row) => stringWidth(row.quotaReset))),
    lastRequest: Math.max(...rows.map((row) => stringWidth(row.lastRequest))),
    activated: Math.max(...rows.map((row) => stringWidth(row.activated))),
    verified: Math.max(...rows.map((row) => stringWidth(row.verified))),
    switches: Math.max(...rows.map((row) => stringWidth(row.switches))),
  };

  const suggested = (() => {
    try {
      return selectNextProfile({
        version: 1,
        activeProfile: state.activeProfile,
        profiles: state.profiles,
      }).name;
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
        padEndWidth(row.quotaReset, widths.quotaReset),
        padEndWidth(row.lastRequest, widths.lastRequest),
        padEndWidth(row.activated, widths.activated),
        padEndWidth(row.verified, widths.verified),
        padStartWidth(row.switches, widths.switches),
        row.expectedEmail,
        row.actualEmail === "-" ? "" : `actual=${row.actualEmail}`,
      ].join("  "),
      description: row.profile.name === suggested ? "next" : undefined,
    })),
  });
}
