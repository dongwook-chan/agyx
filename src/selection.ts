import { AutoSwitchMode, ProfileRecord, State } from "./config.js";
import { QuotaScope } from "./quota.js";

export type ProfileRuntimeStatus =
  | "ready"
  | "exhausted"
  | "disabled"
  | "mismatch"
  | "error"
  | "ineligible";

export interface EffectiveStatusOptions {
  quotaScope?: QuotaScope;
  quotaScopes?: QuotaScope[];
}

function effectiveScopes(options: EffectiveStatusOptions): QuotaScope[] {
  return [
    ...(options.quotaScopes ?? []),
    ...(options.quotaScope ? [options.quotaScope] : []),
  ].filter((scope, index, scopes) =>
    scope !== "unknown" && scopes.indexOf(scope) === index
  );
}

const providerQuotaScopes: QuotaScope[] = ["claude", "gemini"];

function quotaActive(resetAt: string | undefined, now: Date): boolean {
  return !resetAt || Date.parse(resetAt) > now.getTime();
}

function hasProfileWideQuota(profile: ProfileRecord, now: Date): boolean {
  if (
    profile.quotaStatus === "exhausted"
    && quotaActive(profile.quotaResetAt, now)
  ) {
    return true;
  }
  const unknown = profile.quotaScopes?.unknown;
  return Boolean(unknown && quotaActive(unknown.resetAt, now));
}

export function isScopeQuotaExhausted(
  profile: ProfileRecord,
  scope: QuotaScope,
  now = new Date(),
): boolean {
  if (scope === "unknown") return hasProfileWideQuota(profile, now);
  if (hasProfileWideQuota(profile, now)) return true;
  const quota = profile.quotaScopes?.[scope];
  return Boolean(quota && quotaActive(quota.resetAt, now));
}

function isBaseSelectable(profile: ProfileRecord): boolean {
  return !profile.disabled
    && profile.credentialStatus !== "mismatch"
    && profile.credentialStatus !== "error"
    && profile.eligibilityStatus !== "ineligible";
}

function targetScopesFor(scope: QuotaScope): QuotaScope[] {
  return scope === "unknown" ? providerQuotaScopes : [scope];
}

export function scopedQuotaResetAt(
  profile: ProfileRecord,
  scope: QuotaScope | undefined,
  now = new Date(),
): string | undefined {
  if (!scope || scope === "unknown") return undefined;
  const quota = profile.quotaScopes?.[scope];
  if (!quota) return undefined;
  if (!quota.resetAt) return undefined;
  return Date.parse(quota.resetAt) > now.getTime() ? quota.resetAt : undefined;
}

export function exhaustedQuotaScope(
  profile: ProfileRecord,
  scope: QuotaScope | undefined,
  now = new Date(),
): QuotaScope | undefined {
  if (hasProfileWideQuota(profile, now)) return "unknown";
  if (!scope || scope === "unknown") return undefined;
  return isScopeQuotaExhausted(profile, scope, now) ? scope : undefined;
}

export function exhaustedQuotaScopeForOptions(
  profile: ProfileRecord,
  options: EffectiveStatusOptions,
  now = new Date(),
): QuotaScope | undefined {
  const profileWide = exhaustedQuotaScope(profile, undefined, now);
  if (profileWide) return profileWide;
  for (const scope of effectiveScopes(options)) {
    const exhaustedScope = exhaustedQuotaScope(profile, scope, now);
    if (exhaustedScope) return exhaustedScope;
  }
  return undefined;
}

export function effectiveProfileStatus(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileRuntimeStatus {
  if (profile.disabled) return "disabled";
  if (profile.credentialStatus === "mismatch") return "mismatch";
  if (profile.credentialStatus === "error") return "error";
  if (profile.eligibilityStatus === "ineligible") return "ineligible";
  return exhaustedQuotaScopeForOptions(profile, options, now) ? "exhausted" : "ready";
}

function earliestQuotaReset(profile: ProfileRecord): number {
  const resetTimes = [
    profile.quotaResetAt,
    ...Object.values(profile.quotaScopes ?? {}).map((quota) => quota?.resetAt),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));
  return resetTimes.length ? Math.min(...resetTimes) : 0;
}

function hasAnyProviderQuota(profile: ProfileRecord, now: Date): boolean {
  return providerQuotaScopes.some((scope) => isScopeQuotaExhausted(profile, scope, now));
}

function hasAllProviderQuotas(profile: ProfileRecord, now: Date): boolean {
  return providerQuotaScopes.every((scope) => isScopeQuotaExhausted(profile, scope, now));
}

function autoSwitchCategory(
  profile: ProfileRecord,
  mode: Exclude<AutoSwitchMode, "off">,
  quotaScope: QuotaScope,
  now: Date,
): number | undefined {
  if (!isBaseSelectable(profile)) return undefined;

  const targetScopes = targetScopesFor(quotaScope);
  if (targetScopes.some((scope) => isScopeQuotaExhausted(profile, scope, now))) {
    return undefined;
  }

  if (mode === "provider-first") return 0;

  return hasAnyProviderQuota(profile, now) ? 1 : 0;
}

export function shouldAutoSwitchAfterQuota(
  profile: ProfileRecord | undefined,
  mode: AutoSwitchMode | undefined,
  quotaScope: QuotaScope,
  now = new Date(),
): boolean {
  if (!profile || !mode || mode === "off") return false;
  if (mode === "provider-first") return true;
  if (quotaScope === "unknown") return true;
  return hasAllProviderQuotas(profile, now);
}

export function selectAutoSwitchProfile(
  state: State,
  mode: Exclude<AutoSwitchMode, "off">,
  quotaScope: QuotaScope,
  now = new Date(),
): ProfileRecord {
  if (!state.profiles.length) throw new Error("No saved profiles.");
  const activeIndex = state.activeProfile
    ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
    : -1;
  const candidates = state.profiles
    .map((profile, index) => {
      const category = profile.name === state.activeProfile
        ? undefined
        : autoSwitchCategory(profile, mode, quotaScope, now);
      if (category === undefined) return undefined;
      const offset = (index - activeIndex + state.profiles.length) % state.profiles.length;
      return {
        profile,
        category,
        resetAt: earliestQuotaReset(profile),
        offset,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) =>
      left.category - right.category
      || left.resetAt - right.resetAt
      || left.offset - right.offset
    );
  const selected = candidates[0]?.profile;
  if (!selected) throw new Error("No selectable profile for automatic quota failover.");
  return selected;
}

export function isProfileSelectable(
  profile: ProfileRecord,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): boolean {
  return effectiveProfileStatus(profile, now, options) === "ready";
}

export function selectNextProfile(
  state: State,
  now = new Date(),
  options: EffectiveStatusOptions = {},
): ProfileRecord {
  if (!state.profiles.length) throw new Error("No saved profiles.");
  const activeIndex = state.activeProfile
    ? state.profiles.findIndex(({ name }) => name === state.activeProfile)
    : -1;

  for (let offset = 1; offset <= state.profiles.length; offset += 1) {
    const profile = state.profiles[(activeIndex + offset + state.profiles.length)
      % state.profiles.length]!;
    if (isProfileSelectable(profile, now, options)) return profile;
  }

  const resetEntries = state.profiles.flatMap((profile) => {
    const resets: Array<{ name: string; resetAt: string }> = [];
    if (profile.quotaResetAt) resets.push({ name: profile.name, resetAt: profile.quotaResetAt });
    for (const scope of effectiveScopes(options)) {
      const resetAt = profile.quotaScopes?.[scope]?.resetAt;
      if (resetAt) resets.push({ name: `${profile.name}:${scope}`, resetAt });
    }
    return resets;
  });
  const earliestReset = resetEntries
    .sort((left, right) => Date.parse(left.resetAt) - Date.parse(right.resetAt))[0];
  const credentialIssues = state.profiles
    .filter((profile) =>
      profile.credentialStatus === "mismatch"
      || profile.credentialStatus === "error"
      || profile.eligibilityStatus === "ineligible"
    )
    .map((profile) =>
      profile.eligibilityStatus === "ineligible"
        ? `${profile.name}:ineligible`
        : `${profile.name}:${profile.credentialStatus}`
    )
    .join(", ");
  const resetText = earliestReset
    ? ` Earliest reset: ${earliestReset.name} at ${earliestReset.resetAt}.`
    : "";
  const credentialText = credentialIssues
    ? ` Credential issues: ${credentialIssues}.`
    : "";
  throw new Error(`No selectable profiles.${credentialText}${resetText}`);
}
