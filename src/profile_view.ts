import { ProfileRecord, State } from "./config.js";
import {
  effectiveProfileStatus,
  EffectiveStatusOptions,
  exhaustedQuotaScopeForOptions,
  ProfileRuntimeStatus,
  scopedQuotaResetAt,
} from "./selection.js";

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
  selectable: boolean;
  runtimeStatus: ProfileRuntimeStatus;
  disabledReason?: string;
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

export function profileStatusText(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): string {
  const status = effectiveProfileStatus(profile, now, options);
  if (status === "disabled") return "disabled";
  if (status === "mismatch") return "mismatch";
  if (status === "error") return "auth-error";
  if (status === "ineligible") return "ineligible";
  if (status === "exhausted") {
    const exhaustedScope = exhaustedQuotaScopeForOptions(profile, options, now);
    return exhaustedScope && exhaustedScope !== "unknown" ? `quota:${exhaustedScope}` : "quota";
  }
  const scopedQuotaText = Object.keys(profile.quotaScopes ?? {})
    .filter((scope) => scope !== "unknown")
    .join(",");
  if (scopedQuotaText) return `ready/${scopedQuotaText}`;
  return profile.quotaStatus === "available" ? "ready" : "unknown";
}

export function buildProfileViews(
  state: Pick<State, "activeProfile" | "profiles">,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileView[] {
  return state.profiles.map((profile, index) => {
    const runtimeStatus = effectiveProfileStatus(profile, now, options);
    const firstScope = options.quotaScope
      ?? options.quotaScopes?.find((scope) => scope !== "unknown");
    const resetAt = firstScope && firstScope !== "unknown"
      ? scopedQuotaResetAt(profile, firstScope, now) ?? profile.quotaResetAt
      : profile.quotaResetAt;
    const disabledReason = (() => {
      if (runtimeStatus === "ready") return undefined;
      if (runtimeStatus === "mismatch") {
        return profile.credentialError
          ?? `expected ${profile.email ?? "-"}, got ${profile.verifiedEmail ?? "-"}`;
      }
      if (runtimeStatus === "error") {
        return profile.credentialError ?? "credential could not be verified";
      }
      if (runtimeStatus === "ineligible") {
        return profile.eligibilityReason
          ?? "account is not eligible for Antigravity; verify it in the browser or login another account";
      }
      if (runtimeStatus === "exhausted") {
        const exhaustedScope = exhaustedQuotaScopeForOptions(profile, options, now);
        const scopeText = exhaustedScope && exhaustedScope !== "unknown"
          ? `${exhaustedScope} quota`
          : "quota";
        return resetAt
          ? `${scopeText} resets ${relativeTime(resetAt, now)}`
          : "quota exhausted";
      }
      return "disabled";
    })();
    return {
      marker: profile.name === state.activeProfile ? "*" : "",
      number: String(index + 1),
      name: profile.name,
      expectedEmail: profile.email ?? "-",
      actualEmail: profile.verifiedEmail ?? "-",
      status: profileStatusText(profile, now, options),
      quotaReset: relativeTime(resetAt, now),
      lastRequest: relativeTime(profile.lastRequestAt, now),
      activated: relativeTime(profile.lastActivatedAt, now),
      verified: relativeTime(profile.credentialVerifiedAt ?? profile.credentialMismatchAt, now),
      switches: String(profile.selectionCount ?? 0),
      selectable: runtimeStatus === "ready",
      runtimeStatus,
      disabledReason,
      profile,
    };
  });
}
