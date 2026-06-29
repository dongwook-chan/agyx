import assert from "node:assert/strict";
import test from "node:test";
import { detectEmail } from "../src/coordinator.js";
import {
  effectiveAllowIneligibleActivation,
  effectiveAutoSwitchMode,
  markProfileActivated,
  markProfileCredentialMismatch,
  markProfileIneligible,
  markProfileQuotaExhausted,
  markProfileRequest,
  profileNameFromEmail,
  uniqueProfileName,
  validateProfileName,
} from "../src/config.js";
import type { State } from "../src/config.js";
import { parseEligibilityEventLine } from "../src/eligibility.js";
import { shellInit } from "../src/install.js";
import { buildProfileViews } from "../src/profile_view.js";
import {
  parseModelEventLine,
  isRequestEventLine,
  parseQuotaEventLine,
} from "../src/quota.js";
import {
  effectiveProfileStatus,
  selectAutoSwitchProfile,
  selectNextProfile,
  shouldAutoSwitchAfterQuota,
} from "../src/selection.js";
import {
  nativeSupervisorBinaryName,
  nativeSupervisorHostStatus,
} from "../src/native.js";
import {
  isRestartable,
  parsePS,
  withConversation,
} from "../src/processes.js";
import { detectConversation } from "../src/session.js";

test("activation keeps exhausted quota until reset time", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state = {
    version: 1 as const,
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "exhausted" as const,
        quotaResetAt: "2026-06-27T00:00:00.000Z",
      },
    ],
  };

  markProfileActivated(state, "a", now, false);
  assert.equal(state.profiles[0]!.quotaStatus, "exhausted");
  assert.equal(state.profiles[0]!.quotaResetAt, "2026-06-27T00:00:00.000Z");
});

test("shell integration uses the lightweight agy shim", () => {
  assert.match(shellInit(), /command agyx-supervisor "\$@"/);
  assert.match(shellInit(), /command agyx-agy "\$@"/);
});

test("native supervisor is scoped to supported arm64 Unix hosts", () => {
  assert.equal(nativeSupervisorBinaryName("darwin", "arm64"), "agyx-supervisor-darwin-arm64");
  assert.equal(nativeSupervisorBinaryName("linux", "arm64"), "agyx-supervisor-linux-arm64");
  assert.equal(nativeSupervisorHostStatus("darwin", "arm64").supported, true);
  assert.equal(nativeSupervisorHostStatus("linux", "arm64").supported, true);
  assert.equal(nativeSupervisorHostStatus("darwin", "x64").supported, false);
  assert.equal(nativeSupervisorHostStatus("linux", "x64").supported, false);
});

test("default autoswitch mode is all-providers", () => {
  assert.equal(effectiveAutoSwitchMode({}), "all-providers");
  assert.equal(
    effectiveAutoSwitchMode({ settings: { autoSwitchMode: "provider-first" } }),
    "provider-first",
  );
});

test("default ineligible activation mode is allow", () => {
  assert.equal(effectiveAllowIneligibleActivation({}), true);
  assert.equal(
    effectiveAllowIneligibleActivation({
      settings: { allowIneligibleActivation: false },
    }),
    false,
  );
});

test("parses and marks ineligible Antigravity accounts", () => {
  const event = parseEligibilityEventLine(
    "W server_oauth.go:99] Account ineligible: Your current account is not eligible for Antigravity. Verify your account to continue.",
  );
  assert.deepEqual(event, {
    reason: "Your current account is not eligible for Antigravity. Verify your account to continue.",
  });

  const now = new Date("2026-06-26T00:00:00.000Z");
  const state = {
    version: 1 as const,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "available" as const,
      },
    ],
  };
  markProfileIneligible(state, "a", event!, now);
  const views = buildProfileViews(state, now);
  assert.equal(state.activeProfile, "a");
  assert.equal(views[0]!.marker, "*");
  assert.equal(views[0]!.status, "ineligible");
  assert.equal(views[0]!.selectable, true);
});

test("credential mismatch reconciles active profile by actual credential identity", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state = {
    version: 1 as const,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        email: "a@example.com",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        name: "b",
        email: "b@example.com",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };

  markProfileCredentialMismatch(state, "a", "b@example.com", "a@example.com", now);

  assert.equal(state.activeProfile, "b");
  const views = buildProfileViews(state, now);
  assert.equal(views[0]!.status, "mismatch");
  assert.equal(views[0]!.marker, "");
  assert.equal(views[1]!.marker, "*");
});

test("validates profile names", () => {
  assert.equal(validateProfileName("work-1.test"), "work-1.test");
  assert.throws(() => validateProfileName("../escape"));
  assert.throws(() => validateProfileName("has space"));
});

test("derives safe unique profile names from email", () => {
  assert.equal(profileNameFromEmail("Dong.Work+test@gmail.com"), "dong.work-test");
  assert.equal(
    uniqueProfileName("dong", {
      version: 1,
      profiles: [
        {
          name: "dong",
          createdAt: "2026-06-26T00:00:00.000Z",
          updatedAt: "2026-06-26T00:00:00.000Z",
        },
        {
          name: "dong-2",
          previousNames: ["dong-3"],
          createdAt: "2026-06-26T00:00:00.000Z",
          updatedAt: "2026-06-26T00:00:00.000Z",
        },
      ],
    }),
    "dong-4",
  );
});

test("request events can target renamed profile aliases", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1 as const,
    activeProfile: "work",
    profiles: [
      {
        name: "work",
        previousNames: ["dong"],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };

  markProfileRequest(state, "dong", now);

  assert.equal(state.profiles[0]!.lastRequestAt, now.toISOString());
  assert.equal(state.profiles[0]!.lastSuccessfulRequestAt, now.toISOString());
});

test("parses only agy executables", () => {
  assert.deepEqual(
    parsePS(`
      101 /opt/homebrew/bin/agy --model test
      102 /bin/zsh -c agy
      103 agyx session
      104 agy --conversation abc
    `),
    [
      { pid: 101, command: "/opt/homebrew/bin/agy --model test" },
      { pid: 104, command: "agy --conversation abc" },
    ],
  );
});

test("preserves options while replacing resume selectors", () => {
  assert.deepEqual(
    withConversation(
      ["--continue", "--model", "gemini", "--conversation=old"],
      "11111111-1111-1111-1111-111111111111",
    ),
    [
      "--model",
      "gemini",
      "--conversation",
      "11111111-1111-1111-1111-111111111111",
    ],
  );
});

test("does not restart print mode", () => {
  assert.equal(isRestartable(["--model", "x"]), true);
  assert.equal(isRestartable(["-p", "hello"]), false);
  assert.equal(isRestartable(["--print", "hello"]), false);
});

test("detects latest email and conversation", () => {
  assert.equal(
    detectEmail(`
      authenticated successfully as old@example.com
      authenticated successfully as new@example.com
    `),
    "new@example.com",
  );
  assert.equal(
    detectConversation(`
      Created conversation 11111111-1111-1111-1111-111111111111
      GetConversationDetail: found conversation 22222222-2222-2222-2222-222222222222
    `),
    "22222222-2222-2222-2222-222222222222",
  );
});

test("selects the next non-exhausted profile in round-robin order", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  assert.equal(
    selectNextProfile({
      version: 1,
      activeProfile: "a",
      profiles: [
        {
          name: "a",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "available",
        },
        {
          name: "b",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "exhausted",
          quotaResetAt: "2026-06-27T00:00:00.000Z",
        },
        {
          name: "c",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "available",
        },
      ],
    }, now).name,
    "c",
  );
});

test("skips credential mismatch profiles when selecting next", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  assert.equal(
    selectNextProfile({
      version: 1,
      activeProfile: "a",
      profiles: [
        {
          name: "a",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "available",
        },
        {
          name: "b",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "available",
          credentialStatus: "mismatch",
          email: "b@example.com",
          verifiedEmail: "wrong@example.com",
        },
        {
          name: "c",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          quotaStatus: "available",
        },
      ],
    }, now).name,
    "c",
  );
});

test("ineligible profiles are selectable unless blocked by settings", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "available",
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "available",
        eligibilityStatus: "ineligible",
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "available",
      },
    ],
  };

  assert.equal(selectNextProfile(state, now).name, "b");
  assert.equal(buildProfileViews(state, now)[1]!.selectable, true);

  state.settings = { allowIneligibleActivation: false };

  assert.equal(selectNextProfile(state, now).name, "c");
  assert.equal(buildProfileViews(state, now)[1]!.selectable, false);
});

test("auto switch follows ineligible activation setting", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          claude: { status: "exhausted" },
          gemini: { status: "exhausted" },
        },
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        eligibilityStatus: "ineligible",
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };

  assert.equal(selectAutoSwitchProfile(state, "all-providers", "claude", now).name, "b");

  state.settings = { allowIneligibleActivation: false };

  assert.equal(selectAutoSwitchProfile(state, "all-providers", "claude", now).name, "c");
});

test("builds one shared profile view for list and picker", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const views = buildProfileViews({
    activeProfile: "b",
    profiles: [
      {
        name: "b",
        email: "b@example.com",
        verifiedEmail: "wrong@example.com",
        credentialStatus: "mismatch",
        credentialMismatchAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  }, now);

  assert.deepEqual(
    {
      marker: views[0]!.marker,
      name: views[0]!.name,
      expectedEmail: views[0]!.expectedEmail,
      actualEmail: views[0]!.actualEmail,
      status: views[0]!.status,
      selectable: views[0]!.selectable,
    },
    {
      marker: "*",
      name: "b",
      expectedEmail: "b@example.com",
      actualEmail: "wrong@example.com",
      status: "mismatch",
      selectable: false,
    },
  );
});

test("parses quota reset hints from agy logs", () => {
  const event = parseQuotaEventLine(
    "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 1h30m10s",
    new Date("2026-06-26T00:00:00.000Z"),
  );
  assert.deepEqual(event, {
    reason: "individual quota reached",
    resetAt: "2026-06-26T01:30:10.000Z",
  });
  assert.equal(parseQuotaEventLine("normal log line"), undefined);
});

test("tracks provider-scoped quota only from model log context", () => {
  const modelEvent = parseModelEventLine(
    'I model_config_manager.go:157] Propagating selected model override to backend: label="Claude Sonnet 4.6 (Thinking)"',
  );
  assert.deepEqual(modelEvent, {
    label: "Claude Sonnet 4.6 (Thinking)",
    scope: "claude",
  });

  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };

  markProfileQuotaExhausted(state, "b", {
    reason: "individual quota reached",
    resetAt: "2026-06-27T00:00:00.000Z",
    scope: "claude",
    modelLabel: "Claude Sonnet 4.6 (Thinking)",
  }, now);

  assert.equal(state.profiles[1]!.quotaStatus, undefined);
  assert.equal(state.profiles[1]!.quotaScopes?.claude?.modelLabel, "Claude Sonnet 4.6 (Thinking)");
  assert.equal(
    effectiveProfileStatus(state.profiles[1]!, now, { quotaScopes: ["gemini"] }),
    "ready",
  );
  assert.equal(
    effectiveProfileStatus(state.profiles[1]!, now, { quotaScopes: ["claude"] }),
    "exhausted",
  );
  assert.equal(selectNextProfile(state, now, { quotaScopes: ["gemini"] }).name, "b");
  assert.equal(selectNextProfile(state, now, { quotaScopes: ["claude"] }).name, "a");
});

test("auto switch provider-first skips only current provider quota", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          claude: {
            status: "exhausted",
            resetAt: "2026-06-27T00:00:00.000Z",
          },
        },
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          gemini: {
            status: "exhausted",
            resetAt: "2026-06-27T00:00:00.000Z",
          },
        },
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          claude: {
            status: "exhausted",
            resetAt: "2026-06-27T00:00:00.000Z",
          },
        },
      },
    ],
  };

  assert.equal(
    shouldAutoSwitchAfterQuota(state.profiles[0], "provider-first", "claude", now),
    true,
  );
  assert.equal(selectAutoSwitchProfile(state, "provider-first", "claude", now).name, "b");
});

test("auto switch all-providers waits until both Claude and Gemini are exhausted", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          claude: {
            status: "exhausted",
            resetAt: "2026-06-27T00:00:00.000Z",
          },
        },
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          gemini: {
            status: "exhausted",
            resetAt: "2026-06-27T00:00:00.000Z",
          },
        },
      },
    ],
  };

  assert.equal(
    shouldAutoSwitchAfterQuota(state.profiles[0], "all-providers", "claude", now),
    false,
  );

  state.profiles[0]!.quotaScopes!.gemini = {
    status: "exhausted",
    resetAt: "2026-06-27T00:00:00.000Z",
  };

  assert.equal(
    shouldAutoSwitchAfterQuota(state.profiles[0], "all-providers", "gemini", now),
    true,
  );
  assert.equal(selectAutoSwitchProfile(state, "all-providers", "gemini", now).name, "b");
});

test("auto switch treats unknown profile-wide quota as both provider quotas", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "exhausted",
        quotaResetAt: "2026-06-27T00:00:00.000Z",
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaStatus: "exhausted",
        quotaResetAt: "2026-06-27T00:00:00.000Z",
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };

  assert.equal(
    shouldAutoSwitchAfterQuota(state.profiles[0], "all-providers", "unknown", now),
    true,
  );
  assert.equal(selectAutoSwitchProfile(state, "provider-first", "unknown", now).name, "c");
});

test("auto switch orders fallback candidates by earliest quota reset", () => {
  const now = new Date("2026-06-26T00:00:00.000Z");
  const state: State = {
    version: 1,
    activeProfile: "a",
    profiles: [
      {
        name: "a",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          claude: { status: "exhausted", resetAt: "2026-06-27T00:00:00.000Z" },
          gemini: { status: "exhausted", resetAt: "2026-06-27T00:00:00.000Z" },
        },
      },
      {
        name: "b",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          gemini: { status: "exhausted", resetAt: "2026-06-29T00:00:00.000Z" },
        },
      },
      {
        name: "c",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        quotaScopes: {
          gemini: { status: "exhausted", resetAt: "2026-06-28T00:00:00.000Z" },
        },
      },
    ],
  };

  assert.equal(selectAutoSwitchProfile(state, "all-providers", "claude", now).name, "c");
});

test("detects request event lines from agy logs", () => {
  assert.equal(
    isRequestEventLine(
      "I0625 server.go:1104] Sending user message to conversation 8497ed4e-6e49-41cc-b867-604932549901 (items=1, media=0)",
    ),
    true,
  );
  assert.equal(isRequestEventLine("Forwarding user message to conversation x"), false);
});
