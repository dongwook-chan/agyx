"use strict";

const supportedNativeSupervisors = {
  "darwin:arm64": "agyx-supervisor-darwin-arm64",
  "linux:arm64": "agyx-supervisor-linux-arm64",
};

function hostKey(platform = process.platform, arch = process.arch) {
  return `${platform}:${arch}`;
}

function supportedHostText() {
  return Object.keys(supportedNativeSupervisors)
    .map((key) => key.replace(":", "/"))
    .join(", ");
}

module.exports = {
  supportedNativeSupervisors,
  hostKey,
  supportedHostText,
};
