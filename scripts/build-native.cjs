#!/usr/bin/env node
"use strict";

const { copyFileSync, mkdirSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  supportedNativeSupervisors,
  hostKey,
  supportedHostText,
} = require("./native-targets.cjs");

const key = hostKey();
const binaryName = supportedNativeSupervisors[key];
if (!binaryName) {
  console.error(`Unsupported native build host: ${key}`);
  console.error(`Supported native build hosts: ${supportedHostText()}`);
  process.exit(1);
}

const crateDir = join(__dirname, "..", "native", "agyx-supervisor");
const result = spawnSync("cargo", ["build", "--release"], {
  cwd: crateDir,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const binDir = join(__dirname, "..", "bin");
mkdirSync(binDir, { recursive: true });
const extension = process.platform === "win32" ? ".exe" : "";
copyFileSync(
  join(crateDir, "target", "release", `agyx-supervisor${extension}`),
  join(binDir, binaryName),
);
chmodSync(join(binDir, binaryName), 0o755);
if (process.platform === "darwin") {
  const codesignResult = spawnSync("codesign", ["-f", "-s", "-", join(binDir, binaryName)], {
    stdio: "inherit",
  });
  if (codesignResult.status !== 0) {
    console.warn(`Warning: codesign failed with status ${codesignResult.status}`);
  } else {
    console.log(`Signed bin/${binaryName}`);
  }
}
chmodSync(join(binDir, "agyx-supervisor"), 0o755);
console.log(`Built bin/${binaryName}`);
