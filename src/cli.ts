#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { initializeProject, type InitResult } from './init.js';
import { reconcileStartup } from './recovery.js';
import { recoverLateCompletions } from './late-recovery.js';
import { runForegroundLoop, type RunSummary } from './run.js';
import { measureWorktreeSlop, serializeSlopReport } from './slop.js';

export { readConfig } from './config.js';

export interface SlopCliOptions {
  readonly base?: string;
  readonly maxDelta: number;
  readonly reportOnly: boolean;
}

export function parseSlopOptions(args: readonly string[]): SlopCliOptions {
  let base: string | undefined;
  let maxDelta = 0.02;
  let reportOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--base' && args[index + 1] !== undefined) {
      base = args[++index];
    } else if (argument === '--max-delta' && args[index + 1] !== undefined) {
      maxDelta = Number(args[++index]);
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
  return { base, maxDelta, reportOnly };
}

async function configuredSlopBase(cwd: string): Promise<string> {
  try {
    return (await loadConfig(cwd)).base;
  } catch {
    return 'main';
  }
}

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
    const options = parseSlopOptions(unexpectedArgs);
    const comparison = await measureWorktreeSlop(
      process.cwd(),
      options.base ?? (await configuredSlopBase(process.cwd())),
    );
    console.log(serializeSlopReport(comparison));
    if (
      !options.reportOnly &&
      (comparison.verbosityDelta > options.maxDelta ||
        comparison.erosionDelta > options.maxDelta)
    ) {
      throw new Error(`slop score regressed by more than ${options.maxDelta}`);
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
