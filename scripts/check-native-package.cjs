#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const expected = {
  "darwin:arm64": "agyx-supervisor-darwin-arm64",
  "linux:arm64": "agyx-supervisor-linux-arm64",
};

const launcher = path.join(__dirname, "..", "bin", "agyx-supervisor");
const required = process.env.AGYX_REQUIRE_ALL_NATIVE === "1"
  ? Object.values(expected)
  : [expected[`${process.platform}:${process.arch}`]].filter(Boolean);

try {
  fs.accessSync(launcher, fs.constants.X_OK);
  for (const name of required) {
    fs.accessSync(path.join(__dirname, "..", "bin", name), fs.constants.X_OK);
  }
} catch {
  console.error(
    [
      "Native supervisor launcher or binary is missing or not executable.",
      `Expected launcher: ${launcher}`,
      `Expected binaries: ${required.map((name) => path.join(__dirname, "..", "bin", name)).join(", ")}`,
      "Build it before packing/publishing:",
      "  npm run build:native",
      "For release CI with every supported binary:",
      "  AGYX_REQUIRE_ALL_NATIVE=1 npm run check:native-package",
    ].join("\n"),
  );
  process.exit(1);
}
