import { confirm, select } from "@inquirer/prompts";
import Table from "cli-table3";
import stringWidth from "string-width";
import { color } from "./color.js";
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

function colorStatus(row: ProfileView, value: string): string {
  switch (row.runtimeStatus) {
    case "ready":
      return color.green(value);
    case "exhausted":
      return color.yellow(value);
    case "mismatch":
    case "error":
      return color.red(value);
    case "disabled":
      return color.gray(value);
  }
}

function colorCell(row: ProfileView, value: string): string {
  if (row.runtimeStatus === "ready") return value;
  if (row.runtimeStatus === "exhausted") return color.yellow(value);
  if (row.runtimeStatus === "mismatch" || row.runtimeStatus === "error") {
    return color.red(value);
  }
  return color.gray(value);
}

function tableRow(row: ProfileView): string[] {
  return [
    colorCell(row, row.marker),
    colorCell(row, row.number),
    colorCell(row, row.name),
    colorCell(row, row.expectedEmail),
    colorCell(row, row.actualEmail),
    colorStatus(row, row.status),
    colorCell(row, row.quotaReset),
    colorCell(row, row.lastRequest),
    colorCell(row, row.activated),
    colorCell(row, row.verified),
    colorCell(row, row.switches),
  ];
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
    table.push(tableRow(row));
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

  while (true) {
    const selected = await select<string>({
      message: suggested
        ? `Select profile (default: next ${suggested})`
        : "Select profile",
      default: suggested,
      choices: rows.map((row) => ({
        value: row.profile.name,
        name: [
          colorCell(row, row.marker || " "),
          colorCell(row, padStartWidth(row.number, widths.number)),
          colorCell(row, padEndWidth(row.name, widths.name)),
          colorStatus(row, padEndWidth(row.status, widths.status)),
          colorCell(row, padEndWidth(row.quotaReset, widths.quotaReset)),
          colorCell(row, padEndWidth(row.lastRequest, widths.lastRequest)),
          colorCell(row, padEndWidth(row.activated, widths.activated)),
          colorCell(row, padEndWidth(row.verified, widths.verified)),
          colorCell(row, padStartWidth(row.switches, widths.switches)),
          colorCell(row, row.expectedEmail),
          row.actualEmail === "-" ? "" : colorCell(row, `actual=${row.actualEmail}`),
        ].join("  "),
        description: row.selectable
          ? row.profile.name === suggested ? "next" : undefined
          : row.disabledReason,
      })),
    });
    const row = rows.find((entry) => entry.profile.name === selected);
    if (row?.selectable) return selected;
    console.error(color.red(
      `Blocked: '${selected}' was not activated. ${row?.disabledReason ?? "Profile is not selectable."}`,
    ));
    console.error(color.gray("Choose another profile, or press Ctrl-C to exit."));
  }
}
