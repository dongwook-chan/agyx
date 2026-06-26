export interface EligibilityEvent {
  reason: string;
}

export function parseEligibilityEventLine(line: string): EligibilityEvent | undefined {
  if (!/account ineligible|not eligible for antigravity|eligibility check failed/i.test(line)) {
    return undefined;
  }
  const reason = line.match(/Account ineligible:\s*(.+)$/i)?.[1]
    ?? line.match(/Eligibility check failed:\s*(.+)$/i)?.[1]
    ?? "account is not eligible for Antigravity; verify it in the browser or login another account";
  return { reason };
}
