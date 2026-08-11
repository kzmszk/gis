#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { initializeProject, type InitResult } from './init.js';
import { reconcileStartup } from './recovery.js';
import { recoverLateCompletions } from './late-recovery.js';
import { runForegroundLoop, type RunSummary } from './run.js';
import { measureWorktreeSlop } from './slop.js';

export { readConfig } from './config.js';

export async function main(
  args: string[],
): Promise<RunSummary | InitResult | void> {
  const [command, ...unexpectedArgs] = args;

  if (command === 'init') {
    if (
      unexpectedArgs.length > 1 ||
      (unexpectedArgs.length === 1 && unexpectedArgs[0] !== '--defaults')
    ) {
      throw new Error('usage: gis init [--defaults]');
    }
    return initializeProject({ defaults: unexpectedArgs[0] === '--defaults' });
  }

  if (command === 'slop') {
    let base = 'main';
    let maxDelta = 0.02;
    let reportOnly = false;
    for (let index = 0; index < unexpectedArgs.length; index += 1) {
      const argument = unexpectedArgs[index];
      if (argument === '--base' && unexpectedArgs[index + 1] !== undefined) {
        base = unexpectedArgs[++index];
      } else if (
        argument === '--max-delta' &&
        unexpectedArgs[index + 1] !== undefined
      ) {
        maxDelta = Number(unexpectedArgs[++index]);
      } else if (argument === '--report') {
        reportOnly = true;
      } else {
        throw new Error(
          'usage: gis slop [--base <git-ref>] [--max-delta <fraction>] [--report]',
        );
      }
    }
    if (!Number.isFinite(maxDelta) || maxDelta < 0) {
      throw new Error('slop max delta must be a non-negative number');
    }
    const comparison = await measureWorktreeSlop(process.cwd(), base);
    console.log(JSON.stringify(comparison, null, 2));
    if (
      !reportOnly &&
      (comparison.verbosityDelta > maxDelta ||
        comparison.erosionDelta > maxDelta)
    ) {
      throw new Error(`slop score regressed by more than ${maxDelta}`);
    }
    return;
  }

  if (command !== 'run' || unexpectedArgs.length > 0) {
    throw new Error('usage: gis <init [--defaults] | run | slop>');
  }

  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  await reconcileStartup({ cwd, baseBranch: config.base });
  const recovered = await recoverLateCompletions({ cwd, config });
  return runForegroundLoop({ cwd, config, initialMerged: recovered });
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gis: ${message}`);
    process.exitCode = 1;
  });
}
