import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import { confirm, input } from "@inquirer/prompts";
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
      return value;
    case "exhausted":
      return color.gray(value);
    case "mismatch":
    case "error":
    case "ineligible":
      return color.gray(value);
    case "disabled":
      return color.gray(value);
  }
}

function colorCell(row: ProfileView, value: string): string {
  if (row.runtimeStatus === "ready") return value;
  return color.gray(value);
}

const profileHeaders = [
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
] as const;

function profileCells(row: ProfileView): string[] {
  return [
    colorCell(row, row.marker || " "),
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

function profileCellValues(row: ProfileView): string[] {
  return [
    row.marker || " ",
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
  ];
}

function profileLine(row: ProfileView, widths: number[]): string {
  const rawValues = profileCellValues(row);
  const cells = row.marker === "*" ? rawValues : profileCells(row);
  const line = cells.map((cell, index) => {
    const raw = profileCellValues(row)[index] ?? "";
    return index === 1 || index === 10
      ? padStartWidth(cell, widths[index] ?? stringWidth(raw))
      : padEndWidth(cell, widths[index] ?? stringWidth(raw));
  }).join("  ");
  return row.marker === "*" ? color.inverse(line) : line;
}

function profileHeaderLine(widths: number[]): string {
  return profileHeaders.map((header, index) =>
    index === 1 || index === 10
      ? padStartWidth(header, widths[index] ?? stringWidth(header))
      : padEndWidth(header, widths[index] ?? stringWidth(header))
  ).join("  ");
}

interface ProfileChoice {
  value: string;
  name: string;
  short: string;
  description?: string;
  blockedDescription?: string;
  selectable: boolean;
  active: boolean;
}

export type ProfilePickerMode = "list" | "use";

export type ProfilePickerAction =
  | { type: "select"; name: string }
  | { type: "delete"; name: string }
  | { type: "rename"; name: string }
  | { type: "exit" };

const profilePicker = createPrompt<ProfilePickerAction, {
  message: string;
  mode: ProfilePickerMode;
  header: string;
  choices: ProfileChoice[];
  notice?: string;
  default?: string;
  pageSize?: number;
}>((config, done) => {
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [blockedValue, setBlockedValue] = useState<string | undefined>(undefined);
  const [activeNoticeValue, setActiveNoticeValue] = useState<string | undefined>(undefined);
  const [finalAction, setFinalAction] = useState<ProfilePickerAction["type"] | undefined>(undefined);
  const initial = config.default
    ? config.choices.findIndex((choice) => choice.value === config.default)
    : -1;
  const [active, setActive] = useState(initial >= 0 ? initial : 0);
  const prefix = usePrefix({ status });
  const choice = config.choices[active]!;

  useKeypress((key) => {
    const keyName = key.name?.toLowerCase();
    if (keyName === "q" || keyName === "escape") {
      setFinalAction("exit");
      setStatus("done");
      done({ type: "exit" });
      return;
    }
    if (keyName === "d" || keyName === "delete") {
      setFinalAction("delete");
      setStatus("done");
      done({ type: "delete", name: choice.value });
      return;
    }
    if (keyName === "r") {
      setFinalAction("rename");
      setStatus("done");
      done({ type: "rename", name: choice.value });
      return;
    }
    if (isEnterKey(key)) {
      if (config.mode === "list") {
        setFinalAction("exit");
        setStatus("done");
        done({ type: "exit" });
        return;
      }
      if (choice.active) {
        setActiveNoticeValue(choice.value);
        setBlockedValue(undefined);
      } else if (choice.selectable) {
        setFinalAction("select");
        setStatus("done");
        done({ type: "select", name: choice.value });
      } else {
        setBlockedValue(choice.value);
        setActiveNoticeValue(undefined);
      }
      return;
    }
    if (isUpKey(key) || isDownKey(key)) {
      const offset = isUpKey(key) ? -1 : 1;
      setActive((active + offset + config.choices.length) % config.choices.length);
      setBlockedValue(undefined);
      setActiveNoticeValue(undefined);
    }
  });

  const page = usePagination({
    items: config.choices,
    active,
    loop: true,
    pageSize: config.pageSize ?? 7,
    renderItem: ({ item, isActive }) => `${isActive ? "❯" : " "} ${item.name}`,
  });

  if (status === "done") {
    if (finalAction && finalAction !== "select") return "";
    return config.mode === "list"
      ? config.message
      : [prefix, config.message].filter(Boolean).join(" ");
  }

  const description = activeNoticeValue === choice.value
    ? `'${choice.value}' is already active.`
    : blockedValue === choice.value
    ? choice.blockedDescription
    : config.notice ?? choice.description;
  const help = config.mode === "use"
    ? color.gray("↑↓ navigate • ⏎ select • r rename • d delete • q quit")
    : color.gray("↑↓ navigate • r rename • d delete • q quit");
  const reservedDescription = description ?? " ";
  const title = config.mode === "list"
    ? config.message
    : [prefix, config.message].filter(Boolean).join(" ");
  return [
    title,
    `  ${config.header}`,
    page,
    reservedDescription,
    help,
  ].filter(Boolean).join("\n").trimEnd() + cursorHide;
});

export function printProfileTable(state: Pick<State, "activeProfile" | "profiles">): void {
  if (!state.profiles.length) {
    console.log("No saved profiles.");
    return;
  }

  const table = new Table({
    head: [...profileHeaders],
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
    table.push(row.marker === "*"
      ? profileCellValues(row).map((cell) => color.inverse(cell))
      : profileCells(row));
  }

  console.log(table.toString());
}

export async function pickProfileAction(
  state: Pick<State, "activeProfile" | "profiles">,
  mode: ProfilePickerMode,
  notice?: string,
): Promise<ProfilePickerAction> {
  if (!state.profiles.length) throw new Error("No saved profiles.");

  const rows = profileRows(state);
  const widths = profileHeaders.map((header, index) =>
    Math.max(
      stringWidth(header),
      ...rows.map((row) => stringWidth(profileCellValues(row)[index] ?? "")),
    )
  );

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

  return await profilePicker({
    mode,
    message: mode === "use" ? "Select profile" : "Saved profiles",
    header: profileHeaderLine(widths),
    notice,
    default: state.activeProfile ?? (mode === "use" ? suggested : undefined),
    choices: rows.map((row) => ({
      value: row.profile.name,
      name: profileLine(row, widths),
      short: profileLine(row, widths),
      selectable: row.selectable,
      active: row.marker === "*",
      description: !row.selectable && row.disabledReason
        ? color.yellow(row.disabledReason)
        : undefined,
      blockedDescription: color.red(
        `Blocked: '${row.profile.name}' was not activated. ${row.disabledReason ?? "Profile is not selectable."}`,
      ),
    })),
  });
}

export async function confirmAction(
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  return await confirm({ message, default: defaultValue });
}

export async function promptText(
  message: string,
  defaultValue?: string,
): Promise<string | undefined> {
  try {
    return await input({ message, default: defaultValue });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return undefined;
    }
    throw error;
  }
}

export async function selectProfileName(
  state: Pick<State, "activeProfile" | "profiles">,
): Promise<string> {
  const action = await pickProfileAction(state, "use");
  if (action.type === "select") return action.name;
  throw new Error("No profile selected.");
}
