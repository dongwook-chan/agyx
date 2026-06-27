export interface QuotaEvent {
  reason: string;
  resetAt?: string;
  scope?: QuotaScope;
  modelLabel?: string;
}

export type QuotaScope = "claude" | "gemini" | "gpt-oss" | "unknown";

export interface ModelEvent {
  label: string;
  scope: QuotaScope;
}

export function isRequestEventLine(line: string): boolean {
  return /Sending user message to conversation [0-9a-f-]{36}/i.test(line);
}

export function classifyModelScope(label: string | undefined): QuotaScope {
  if (!label) return "unknown";
  const lower = label.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("gpt-oss") || lower.includes("gpt oss")) return "gpt-oss";
  return "unknown";
}

export function parseModelEventLine(line: string): ModelEvent | undefined {
  const propagated = line.match(
    /Propagating selected model override to backend:\s+label="([^"]+)"/i,
  )?.[1];
  if (propagated) return { label: propagated, scope: classifyModelScope(propagated) };

  const resolving = line.match(/Resolving model\s+(.+)$/i)?.[1]?.trim();
  if (resolving) return { label: resolving, scope: classifyModelScope(resolving) };

  return undefined;
}

function parseDurationMs(value: string): number | undefined {
  const pattern =
    /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit.startsWith("d")) total += amount * 24 * 60 * 60 * 1000;
    else if (unit.startsWith("h")) total += amount * 60 * 60 * 1000;
    else if (unit.startsWith("m")) total += amount * 60 * 1000;
    else total += amount * 1000;
  }
  return matched ? Math.round(total) : undefined;
}

function parseResetAt(line: string, now: Date): string | undefined {
  const resetIn = line.match(/resets?\s+in\s+([0-9a-zA-Z.\s]+)/i)?.[1];
  const resetMs = resetIn ? parseDurationMs(resetIn) : undefined;
  if (resetMs !== undefined) return new Date(now.getTime() + resetMs).toISOString();

  const retryAfter = line.match(/retry-after["'\s:=]+(\d+)/i)?.[1];
  if (retryAfter) {
    return new Date(now.getTime() + Number(retryAfter) * 1000).toISOString();
  }

  return undefined;
}

export function parseQuotaEventLine(
  line: string,
  now = new Date(),
): QuotaEvent | undefined {
  const lower = line.toLowerCase();
  const looksLikeQuota =
    lower.includes("resource_exhausted")
    || lower.includes("individual quota reached")
    || /\bcode\s*[:=]?\s*429\b/i.test(line)
    || /\b429\b/.test(line) && /(quota|rate|limit|exhausted)/i.test(line)
    || /(quota|rate limit).*(exceeded|exhausted|reached)/i.test(line);
  if (!looksLikeQuota) return undefined;

  let reason = "quota exhausted";
  if (lower.includes("individual quota reached")) reason = "individual quota reached";
  else if (lower.includes("resource_exhausted")) reason = "RESOURCE_EXHAUSTED";
  else if (/\b429\b/.test(line)) reason = "HTTP 429";

  return {
    reason,
    resetAt: parseResetAt(line, now),
  };
}
