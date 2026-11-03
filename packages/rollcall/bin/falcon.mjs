#!/usr/bin/env node
// falcon - open a supervisor in this terminal tab, the way `claude` opens a session (src/falcon.mjs).
import { main } from "../src/falcon.mjs";

process.exitCode = await main(process.argv.slice(2));
