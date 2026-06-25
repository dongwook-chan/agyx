#!/usr/bin/env node
import { supervise } from "./session.js";

supervise(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`agyx: ${(error as Error).message}`);
    process.exitCode = 1;
  });
