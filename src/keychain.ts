import { findRealAgy, run } from "./processes.js";

const security = "/usr/bin/security";
const activeService = "gemini";
const activeAccount = "antigravity";
const vaultService = "agyx";

async function read(service: string, account: string): Promise<Buffer> {
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
}

async function remove(service: string, account: string): Promise<void> {
  await run(
    security,
    ["delete-generic-password", "-s", service, "-a", account],
    { allowFailure: true },
  );
}

async function write(
  service: string,
  account: string,
  credential: Buffer,
  trustedApplications: string[],
): Promise<void> {
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
}

export const keychain = {
  readActive: () => read(activeService, activeAccount),
  async writeActive(credential: Buffer): Promise<void> {
    await write(
      activeService,
      activeAccount,
      credential,
      [await findRealAgy(), security],
    );
  },
  deleteActive: () => remove(activeService, activeAccount),
  readProfile: (name: string) => read(vaultService, name),
  writeProfile: (name: string, credential: Buffer) =>
    write(vaultService, name, credential, [security]),
  deleteProfile: (name: string) => remove(vaultService, name),
};
