import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const nativeSupervisorBinaryByHost = {
  "darwin:arm64": "agyx-supervisor-darwin-arm64",
  "linux:arm64": "agyx-supervisor-linux-arm64",
} as const;

export type NativeSupervisorHost = keyof typeof nativeSupervisorBinaryByHost;

export interface NativeHostStatus {
  supported: boolean;
  platform: string;
  arch: string;
  expected: "darwin/arm64 or linux/arm64";
  binaryName?: string;
  message?: string;
}

export function nativeSupervisorBinaryName(
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  return nativeSupervisorBinaryByHost[
    `${platform}:${arch}` as NativeSupervisorHost
  ];
}

export function nativeSupervisorHostStatus(
  platform = process.platform,
  arch = process.arch,
): NativeHostStatus {
  const binaryName = nativeSupervisorBinaryName(platform, arch);
  const supported = Boolean(binaryName);
  return {
    supported,
    platform,
    arch,
    expected: "darwin/arm64 or linux/arm64",
    binaryName,
    message: supported
      ? undefined
      : `agyx native supervisor supports darwin/arm64 and linux/arm64 only; current host is ${platform}/${arch}.`,
  };
}

export function nativeSupervisorPath(): string {
  const binaryName = nativeSupervisorBinaryName();
  if (!binaryName) {
    throw new Error(nativeSupervisorHostStatus().message);
  }
  return fileURLToPath(new URL(`../../bin/${binaryName}`, import.meta.url));
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runNativeSupervisor(args: string[]): Promise<number | undefined> {
  const host = nativeSupervisorHostStatus();
  if (!host.supported) {
    throw new Error(host.message);
  }

  const binary = nativeSupervisorPath();
  if (!await executable(binary)) {
    if (process.env.AGYX_REQUIRE_NATIVE_SUPERVISOR === "1") {
      throw new Error(
        `Native supervisor binary not found: ${binary}. Run 'npm run build:native'.`,
      );
    }
    console.error(
      `agyx: native supervisor binary not found; using Node supervisor fallback. (${binary})`,
    );
    return undefined;
  }

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        AGYX_CLI_PATH: fileURLToPath(new URL("./cli.js", import.meta.url)),
        AGYX_NODE_PATH: process.execPath,
      },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });
}
