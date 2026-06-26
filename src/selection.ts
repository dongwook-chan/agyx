import { ProfileRecord, State } from "./config.js";

export type ProfileRuntimeStatus =
  | "ready"
  | "exhausted"
  | "disabled"
  | "mismatch"
  | "error";

export function effectiveProfileStatus(
  profile: ProfileRecord,
  now = new Date(),
): ProfileRuntimeStatus {
  if (profile.disabled) return "disabled";
  if (profile.credentialStatus === "mismatch") return "mismatch";
  if (profile.credentialStatus === "error") return "error";
  if (profile.quotaStatus !== "exhausted") return "ready";
  if (!profile.quotaResetAt) return "exhausted";
  return Date.parse(profile.quotaResetAt) > now.getTime()
    ? "exhausted"
    : "ready";
}

export function isProfileSelectable(
  profile: ProfileRecord,
  now = new Date(),
): boolean {
  return effectiveProfileStatus(profile, now) === "ready";
}

export function selectNextProfile(
  state: State,
  now = new Date(),
): ProfileRecord {
  if (!state.profiles.length) throw new Error("No saved profiles.");
  const activeIndex = state.activeProfile
    ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
    : -1;

  for (let offset = 1; offset <= state.profiles.length; offset += 1) {
    const profile = state.profiles[(activeIndex + offset + state.profiles.length)
      % state.profiles.length]!;
    if (isProfileSelectable(profile, now)) return profile;
  }

  const earliestReset = state.profiles
    .filter((profile) => profile.quotaResetAt)
    .sort((left, right) =>
      Date.parse(left.quotaResetAt!) - Date.parse(right.quotaResetAt!)
    )[0];
  const credentialIssues = state.profiles
    .filter((profile) =>
      profile.credentialStatus === "mismatch"
      || profile.credentialStatus === "error"
    )
    .map((profile) => `${profile.name}:${profile.credentialStatus}`)
    .join(", ");
  const resetText = earliestReset
    ? ` Earliest reset: ${earliestReset.name} at ${earliestReset.quotaResetAt}.`
    : "";
  const credentialText = credentialIssues
    ? ` Credential issues: ${credentialIssues}.`
    : "";
  throw new Error(`No selectable profiles.${credentialText}${resetText}`);
}
