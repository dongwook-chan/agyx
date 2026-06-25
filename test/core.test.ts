import assert from "node:assert/strict";
import test from "node:test";
import { detectEmail } from "../src/coordinator.js";
import { validateProfileName } from "../src/config.js";
import {
  isRestartable,
  parsePS,
  withConversation,
} from "../src/processes.js";
import { detectConversation } from "../src/session.js";

test("validates profile names", () => {
  assert.equal(validateProfileName("work-1.test"), "work-1.test");
  assert.throws(() => validateProfileName("../escape"));
  assert.throws(() => validateProfileName("has space"));
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
