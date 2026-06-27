import { findRealAgy, run } from "./processes.js";
import { configDir } from "./config.js";
import { join } from "node:path";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";

const security = "/usr/bin/security";
const activeService = "gemini";
const activeAccount = "antigravity";
const vaultService = "agyx";

const isDarwin = process.platform === "darwin";

async function getCredentialFilePath(service: string, account: string): Promise<string> {
  const credsDir = join(configDir, "credentials");
  await mkdir(credsDir, { recursive: true, mode: 0o700 });
  const safeService = encodeURIComponent(service);
  const safeAccount = encodeURIComponent(account);
  return join(credsDir, `${safeService}_${safeAccount}`);
}

async function read(service: string, account: string): Promise<Buffer> {
  if (isDarwin) {
    const result = await run(
      security,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { allowFailure: true },
    );
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new Error(`Credential not found: ${service}/${account}`);
    }
    let end = result.stdout.length;
    while (end > 0 && [0x0a, 0x0d].includes(result.stdout[end - 1]!)) end -= 1;
    return result.stdout.subarray(0, end);
  } else {
    const filePath = await getCredentialFilePath(service, account);
    try {
      return await readFile(filePath);
    } catch (error) {
      throw new Error(`Credential not found: ${service}/${account}`);
    }
  }
}

async function remove(service: string, account: string): Promise<void> {
  if (isDarwin) {
    await run(
      security,
      ["delete-generic-password", "-s", service, "-a", account],
      { allowFailure: true },
    );
  } else {
    const filePath = await getCredentialFilePath(service, account);
    await rm(filePath, { force: true });
  }
}

async function write(
  service: string,
  account: string,
  credential: Buffer,
  trustedApplications: string[],
): Promise<void> {
  if (isDarwin) {
    await remove(service, account);
    const args = [
      "add-generic-password",
      "-s", service,
      "-a", account,
      "-l", `${service}:${account}`,
    ];
    for (const application of trustedApplications) {
      args.push("-T", application);
    }
    args.push("-X", credential.toString("hex"));
    await run(security, args);
  } else {
    const filePath = await getCredentialFilePath(service, account);
    await writeFile(filePath, credential, { mode: 0o600 });
  }
}

export const keychain = {
  readActive: () => read(activeService, activeAccount),
  async writeActive(credential: Buffer): Promise<void> {
    const trustedApps = isDarwin ? [await findRealAgy(), security] : [await findRealAgy()];
    await write(
      activeService,
      activeAccount,
      credential,
      trustedApps,
    );
  },
  deleteActive: () => remove(activeService, activeAccount),
  readProfile: (name: string) => read(vaultService, name),
  writeProfile: (name: string, credential: Buffer) =>
    write(vaultService, name, credential, isDarwin ? [security] : []),
  deleteProfile: (name: string) => remove(vaultService, name),
};
