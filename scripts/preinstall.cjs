#!/usr/bin/env node
"use strict";

const expectedArch = "arm64";
const supportedPlatforms = new Set(["darwin", "linux"]);

if (supportedPlatforms.has(process.platform) && process.arch === expectedArch) {
  process.exit(0);
}

console.error(
  [
    "agyx installation aborted.",
    "Native supervisor package supports darwin/arm64 and linux/arm64 only.",
    `Current host is ${process.platform}/${process.arch}.`,
  ].join("\n"),
);
process.exit(1);
