#!/usr/bin/env node
"use strict";

const {
  supportedNativeSupervisors,
  hostKey,
  supportedHostText,
} = require("./native-targets.cjs");

if (supportedNativeSupervisors[hostKey()]) {
  process.exit(0);
}

console.error(
  [
    "agyx installation aborted.",
    `Native supervisor package supports ${supportedHostText()} only.`,
    `Current host is ${process.platform}/${process.arch}.`,
  ].join("\n"),
);
process.exit(1);
