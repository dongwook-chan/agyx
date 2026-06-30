import { effectiveYoloMode, State } from "./config.js";
import { withConversation } from "./processes.js";

export const agyTargetCapabilities = {
  yoloFlag: "--dangerously-skip-permissions",
  foreignYoloFlags: ["--dangerously-bypass-approvals-and-sandbox"],
} as const;

export interface AgyLaunchOptions {
  conversationId?: string;
  logPath: string;
  state: Pick<State, "settings">;
}

export function buildAgyLaunchArgs(
  args: string[],
  options: AgyLaunchOptions,
): string[] {
  for (const flag of agyTargetCapabilities.foreignYoloFlags) {
    if (args.includes(flag)) {
      throw new Error(
        `${flag} is a Codex option. For agy use ${agyTargetCapabilities.yoloFlag}.`,
      );
    }
  }

  const launchArgs = withConversation(args, options.conversationId);
  if (!launchArgs.some((argument) =>
    argument === "--log-file" || argument.startsWith("--log-file=")
  )) {
    launchArgs.push("--log-file", options.logPath);
  }
  if (
    effectiveYoloMode(options.state)
    && !launchArgs.includes(agyTargetCapabilities.yoloFlag)
  ) {
    launchArgs.unshift(agyTargetCapabilities.yoloFlag);
  }
  return launchArgs;
}
