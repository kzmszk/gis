import { createBeadsAdapter } from './beads.js';
import type { Bead } from './beads.js';
import type { GisConfig } from './config.js';
import { loadConfig } from './config.js';
import { createHerdrAdapter } from './herdr.js';
import type { AgentSessionInfo } from './herdr.js';
import { SerialMergeQueue } from './merge.js';
import { resolveAgentSessionTranscript } from './transcripts.js';
import { waitForAgentWithBlockedHandling } from './blocked.js';
import { runVerificationLoop } from './verify.js';
import { createBeadWorktree } from './worktree.js';
import type { CreateBeadWorktreeOptions } from './worktree.js';
import { startWorker } from './worker.js';
import {
  createBeadJobProcessor,
  type BeadJobBeadsSource,
  type BeadJobBlockedSource,
  type BeadJobHerdrSource,
  type BeadJobMergeSource,
  type BeadJobVerifySource,
  type BeadJobWorkerSource,
  type BeadJobWorktreeSource,
  type JobOutcome,
} from './run-worker.js';
import { assertNever, delay } from './internal.js';
import { HumanGateTracker } from './run-human-gate.js';

export interface RunBeadsSource extends BeadJobBeadsSource {
  ready(): Promise<readonly Bead[]>;
  markMerged(issueId: string, reason?: string): Promise<Bead>;
  listHuman?(): Promise<readonly Bead[]>;
}

export type RunHerdrSource = BeadJobHerdrSource;

export type RunWorktreeSource = BeadJobWorktreeSource;

export type RunWorkerSource = BeadJobWorkerSource;

export type RunBlockedSource = BeadJobBlockedSource;

export type RunVerifySource = BeadJobVerifySource;

export type RunMergeSource = BeadJobMergeSource;

export interface RunOptions {
  readonly cwd?: string;
  readonly config?: GisConfig;
  readonly beads?: RunBeadsSource;
  readonly herdr?: RunHerdrSource;
  readonly worktrees?: RunWorktreeSource;
  readonly workers?: RunWorkerSource;
  readonly blocked?: RunBlockedSource;
  readonly verify?: RunVerifySource;
  readonly merge?: RunMergeSource;
  readonly resolveTranscript?: (
    session: AgentSessionInfo,
    worktreePath: string,
  ) => Promise<string | undefined>;
  readonly report?: (message: string) => void;
  /** Successful merges completed by startup recovery before this loop. */
  readonly initialMerged?: number;
  /** Test seam for polling externally-resolved human checkpoints. */
  readonly humanPollIntervalMs?: number;
}

export interface RunSummary {
  readonly merged: number;
  readonly blocked: number;
  readonly humanWaiting: number;
  readonly text: string;
}

export { formatHumanGateNotification } from './run-human-gate.js';

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function dispatchableReady(beads: readonly Bead[]): Bead[] {
  return beads
    .filter(
      (bead) =>
        bead.status === 'open' &&
        bead.issue_type !== 'epic' &&
        !bead.labels?.includes('human'),
    )
    .sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id),
    );
}

function summaryText(
  merged: number,
  blocked: number,
  humanWaiting: number,
): string {
  return `${merged}件マージ / ${blocked}件 blocked / ${humanWaiting}件が人間の確認待ち`;
}

export function formatRunSummary(summary: Omit<RunSummary, 'text'>): string {
  return summaryText(summary.merged, summary.blocked, summary.humanWaiting);
}

function defaultWorkers(herdr: RunHerdrSource): RunWorkerSource {
  return {
    start: (options) =>
      startWorker({
        ...options,
        herdr,
      }),
  };
}

/** Every collaborator `runForegroundLoop` needs, with defaults applied. */
interface ResolvedRunDependencies {
  readonly beads: RunBeadsSource;
  readonly herdr: RunHerdrSource;
  readonly worktrees: RunWorktreeSource;
  readonly workers: RunWorkerSource;
  readonly blocked: RunBlockedSource;
  readonly verify: RunVerifySource;
  readonly merge: RunMergeSource;
  readonly resolveTranscript: NonNullable<RunOptions['resolveTranscript']>;
  readonly report: (message: string) => void;
}

/**
 * Resolve every optional `RunOptions` collaborator to a concrete adapter,
 * constructing the production implementation for anything the caller did
 * not supply.
 *
 * Interface: pass the raw `options`, the already-resolved `cwd`, and the
 * already-resolved `config` (both must be resolved first since several
 * defaults, e.g. the merge queue and the beads adapter, are built from
 * them). No I/O beyond constructing in-memory adapter objects; the beads
 * adapter itself is the only default that touches the filesystem
 * indirectly (via `createBeadsAdapter`'s own lazy behavior). Order is
 * significant: `herdr` must resolve before `worktrees`/`workers` (both
 * default to wrapping it), and `beads` must resolve before `merge`
 * (its default embeds it).
 */
function resolveRunDependencies(
  options: RunOptions,
  cwd: string,
  config: GisConfig,
): ResolvedRunDependencies {
  const beads = options.beads ?? createBeadsAdapter({ cwd });
  const herdr = options.herdr ?? createHerdrAdapter();
  const worktrees =
    options.worktrees ??
    ({
      create: (createOptions: CreateBeadWorktreeOptions) =>
        createBeadWorktree({
          ...createOptions,
          herdr,
        }),
    } satisfies RunWorktreeSource);
  const workers = options.workers ?? defaultWorkers(herdr);
  const blocked =
    options.blocked ??
    ({
      wait: (
        waitOptions: Parameters<typeof waitForAgentWithBlockedHandling>[0],
      ) => waitForAgentWithBlockedHandling(waitOptions),
    } satisfies RunBlockedSource);
  const verify =
    options.verify ??
    ({
      verify: (verifyOptions: Parameters<typeof runVerificationLoop>[0]) =>
        runVerificationLoop(verifyOptions),
    } satisfies RunVerifySource);
  const merge =
    options.merge ??
    new SerialMergeQueue({
      repositoryPath: cwd,
      baseBranch: config.base,
      verifyCommand: config.verify,
      verifyTimeout: config.verify_timeout,
      beads,
    });
  const resolveTranscript =
    options.resolveTranscript ?? resolveAgentSessionTranscript;
  const report = options.report ?? ((message: string) => console.log(message));
  return {
    beads,
    herdr,
    worktrees,
    workers,
    blocked,
    verify,
    merge,
    resolveTranscript,
    report,
  };
}

function resolveInitialMerged(options: RunOptions): number {
  const merged = options.initialMerged ?? 0;
  if (!Number.isSafeInteger(merged) || merged < 0) {
    throw new RangeError('initialMerged must be a non-negative integer');
  }
  return merged;
}

function resolveHumanPollIntervalMs(options: RunOptions): number {
  const humanPollIntervalMs = options.humanPollIntervalMs ?? 1_000;
  requirePositiveInteger(humanPollIntervalMs, 'humanPollIntervalMs');
  return humanPollIntervalMs;
}

/** Running totals of terminal job outcomes for the loop's summary. */
interface JobOutcomeCounts {
  merged: number;
  blocked: number;
}

/**
 * Race the active jobs to their first completion and fold its outcome into
 * `counts` in place. `active` loses the completed entry as a side effect
 * (delegated to `raceActiveJob`).
 */
async function advanceActiveJobs(
  active: Map<string, Promise<JobOutcome>>,
  counts: JobOutcomeCounts,
): Promise<void> {
  const outcome = await raceActiveJob(active);
  switch (outcome.status) {
    case 'merged':
      counts.merged += 1;
      break;
    case 'blocked':
      counts.blocked += 1;
      break;
    case 'human':
      break;
    default:
      assertNever(outcome, 'unhandled job outcome');
  }
}

/** Fill `active` up to `concurrency` with newly-dispatched ready beads. */
function fillActiveSlots(
  ready: readonly Bead[],
  active: Map<string, Promise<JobOutcome>>,
  concurrency: number,
  processBead: (bead: Bead) => Promise<JobOutcome>,
): void {
  for (const bead of ready) {
    if (active.size >= concurrency) {
      break;
    }
    if (active.has(bead.id)) {
      continue;
    }
    active.set(bead.id, processBead(bead));
  }
}

/** Await whichever active job finishes first and remove it from `active`. */
async function raceActiveJob(
  active: Map<string, Promise<JobOutcome>>,
): Promise<JobOutcome> {
  const completed = await Promise.race(
    [...active.entries()].map(async ([id, job]) => ({
      id,
      outcome: await job,
    })),
  );
  active.delete(completed.id);
  return completed.outcome;
}

/**
 * Run the stage-1 foreground orchestration loop.
 *
 * The loop only keeps jobs created by this invocation in memory. Every
 * completion causes a fresh `bd ready`, so closing a bead immediately exposes
 * any newly-unblocked dependents to the next dispatch pass.
 */
export async function runForegroundLoop(
  options: RunOptions = {},
): Promise<RunSummary> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? (await loadConfig(cwd));
  requirePositiveInteger(config.concurrency, 'concurrency');

  const deps = resolveRunDependencies(options, cwd, config);
  const { beads, report } = deps;

  const active = new Map<string, Promise<JobOutcome>>();
  const humanGate = new HumanGateTracker(report);
  const humanPollIntervalMs = resolveHumanPollIntervalMs(options);
  const counts: JobOutcomeCounts = {
    merged: resolveInitialMerged(options),
    blocked: 0,
  };

  const processBead = createBeadJobProcessor({
    cwd,
    config,
    ...deps,
    onHumanGate: (gate, locations) => {
      humanGate.recordFromWorker(gate, locations.worktreePath);
    },
  });

  while (true) {
    fillActiveSlots(
      dispatchableReady(await beads.ready()),
      active,
      config.concurrency,
      processBead,
    );

    if (active.size === 0) {
      const humanBeads = await humanGate.refreshAndNotify(beads, cwd);
      const idleAction = humanGate.evaluateIdle(humanBeads);
      if (idleAction === 'stop') break;
      if (idleAction === 'retry') continue;
      await delay(humanPollIntervalMs);
      continue;
    }

    await advanceActiveJobs(active, counts);
  }

  const remainingHumanBeads = await humanGate.refreshAndNotify(beads, cwd);
  const summary = {
    merged: counts.merged,
    blocked: counts.blocked,
    humanWaiting: remainingHumanBeads.size,
  };
  const result = { ...summary, text: formatRunSummary(summary) };
  report(result.text);
  return result;
}

export const runOrchestration = runForegroundLoop;
export const runLoop = runForegroundLoop;
