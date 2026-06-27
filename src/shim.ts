#!/usr/bin/env node
import { runNativeSupervisor } from "./native.js";
import { supervise } from "./session.js";

const args = process.argv.slice(2);

runNativeSupervisor(args)
  .then(async (code) => {
    process.exitCode = code ?? await supervise(args);
  })
  .catch((error) => {
    console.error(`agyx: ${(error as Error).message}`);
    process.exitCode = 1;
  });
