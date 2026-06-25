import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function runCLI(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve("dist/src/cli.js"), ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

test("supervisor pauses and resumes in place with conversation UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "agyx-integration-"));
  const fakeAgy = join(root, "agy");
  const launches = join(root, "launches.txt");
  const conversation = "11111111-1111-1111-1111-111111111111";
  await writeFile(fakeAgy, `#!/bin/sh
log=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--log-file" ]; then log="$arg"; fi
  case "$arg" in --log-file=*) log="\${arg#--log-file=}" ;; esac
  previous="$arg"
done
printf '%s\\n' "$*" >> "$AGYX_TEST_LAUNCHES"
if [ -n "$log" ]; then printf 'Created conversation ${conversation}\\n' >> "$log"; fi
trap 'exit 0' INT TERM
while :; do sleep 1; done
`);
  await chmod(fakeAgy, 0o755);

  const environment = {
    ...process.env,
    AGYX_CONFIG_DIR: join(root, "config"),
    AGYX_REAL_AGY: fakeAgy,
    AGYX_TEST_LAUNCHES: launches,
  };
  const supervisor = spawn(
    process.execPath,
    [resolve("dist/src/cli.js"), "session", "--", "--model", "test"],
    { env: environment, stdio: "ignore" },
  );

  try {
    await waitFor(async () => {
      try { return (await readFile(launches, "utf8")).trim().split("\n").length === 1; }
      catch { return false; }
    });
    const paused = await runCLI(["pause"], environment);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /Paused 1 supervised session/);

    const runtime = join(root, "config", "run");
    const recordName = (await readdir(runtime)).find((name) => name.endsWith(".json"));
    assert.ok(recordName);
    const record = JSON.parse(await readFile(join(runtime, recordName), "utf8"));
    assert.equal(record.paused, true);
    assert.equal(record.conversationId, conversation);

    const resumed = await runCLI(["resume"], environment);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitFor(async () => {
      const lines = (await readFile(launches, "utf8")).trim().split("\n");
      return lines.length >= 2;
    });
    const lines = (await readFile(launches, "utf8")).trim().split("\n");
    assert.match(lines[1]!, /--model test/);
    assert.match(lines[1]!, new RegExp(`--conversation ${conversation}`));
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await new Promise<void>((resolvePromise) =>
        supervisor.once("exit", () => resolvePromise())
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});
