#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { reconcileStartup } from "./recovery.js";
import { runForegroundLoop, type RunSummary } from "./run.js";

export { readConfig } from "./config.js";

export async function main(args: string[]): Promise<RunSummary> {
  const [command, ...unexpectedArgs] = args;

  if (command !== "run" || unexpectedArgs.length > 0) {
    throw new Error("usage: gis run");
  }

  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  await reconcileStartup({ cwd, baseBranch: config.base });
  return runForegroundLoop({ cwd, config });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`gis: ${message}`);
  process.exitCode = 1;
});
