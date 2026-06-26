import { ProfileRecord, State } from "./config.js";
import { effectiveProfileStatus } from "./selection.js";

export interface ProfileView {
  marker: string;
  number: string;
  name: string;
  expectedEmail: string;
  actualEmail: string;
  status: string;
  quotaReset: string;
  lastRequest: string;
  activated: string;
  verified: string;
  switches: string;
  profile: ProfileRecord;
}

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
  if (status === "mismatch") return "mismatch";
  if (status === "error") return "auth-error";
  if (status === "exhausted") return "quota";
  return profile.quotaStatus === "available" ? "ready" : "unknown";
}

export function buildProfileViews(
  state: Pick<State, "activeProfile" | "profiles">,
  now = new Date(),
): ProfileView[] {
  return state.profiles.map((profile, index) => ({
    marker: profile.name === state.activeProfile ? "*" : "",
    number: String(index + 1),
    name: profile.name,
    expectedEmail: profile.email ?? "-",
    actualEmail: profile.verifiedEmail ?? "-",
    status: profileStatusText(profile, now),
    quotaReset: relativeTime(profile.quotaResetAt, now),
    lastRequest: relativeTime(profile.lastRequestAt, now),
    activated: relativeTime(profile.lastActivatedAt, now),
    verified: relativeTime(profile.credentialVerifiedAt ?? profile.credentialMismatchAt, now),
    switches: String(profile.selectionCount ?? 0),
    profile,
  }));
}
