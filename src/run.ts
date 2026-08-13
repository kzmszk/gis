import { createBeadsAdapter } from './beads.js';
import type { Bead, BeadHandoffLocations } from './beads.js';
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
import { assertNever, delay, requirePositiveInteger } from './internal.js';
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

/** Resolve the reporting sink, independent of every other collaborator. */
function resolveReport(options: RunOptions): (message: string) => void {
  return options.report ?? ((message: string) => console.log(message));
}

/** Called when a worker itself raises a human gate, before its job is released. */
type OnHumanGate = (gate: Bead, locations: BeadHandoffLocations) => void;

/** What `runForegroundLoop` needs to dispatch and process ready beads. */
interface Dispatcher {
  /** Runs one bead to a terminal `JobOutcome`, retaining state for recovery on failure. */
  readonly processBead: (bead: Bead) => Promise<JobOutcome>;
  readonly beads: RunBeadsSource;
}

/**
 * Build the dispatcher `runForegroundLoop` schedules ready beads against.
 *
 * Resolves every optional `RunOptions` collaborator to a concrete adapter
 * (constructing the production implementation for anything the caller did
 * not supply) and wires them into a single `processBead` function via
 * `createBeadJobProcessor`. Interface: pass the raw `options`, the
 * already-resolved `cwd` and `config` (both required first since several
 * defaults, e.g. the merge queue and the beads adapter, are built from
 * them), the already-resolved `report` sink, and `onHumanGate`, invoked
 * when a worker raises a human checkpoint mid-job. Both `report` and
 * `onHumanGate` are taken as parameters rather than resolved here because
 * the caller typically needs `report` before it can build `onHumanGate`
 * (e.g. to feed a `HumanGateTracker`); resolving `report` via
 * `resolveReport` is independent of every other collaborator, so the
 * caller can do that once, share the single result with both `humanGate`
 * and this function, and never create a resolution cycle. No I/O beyond
 * constructing in-memory adapter objects; the beads adapter is the only
 * default that touches the filesystem indirectly (via `createBeadsAdapter`'s
 * own lazy behavior). Throws `ConfigError` if `config.review` is enabled
 * but the resolved `herdr` adapter does not support `pane.split`
 * (delegated to `createBeadJobProcessor`).
 *
 * Deletion test: removing this function pushes the resolution of the eight
 * remaining `RunOptions` collaborators (`beads`, `herdr`, `worktrees`,
 * `workers`, `blocked`, `verify`, `merge`, `resolveTranscript`), their
 * relative ordering (`herdr` before `worktrees`/`workers`, `beads` before
 * `merge`), and the `createBeadJobProcessor` wiring back into
 * `runForegroundLoop`, its sole caller.
 */
function createDispatcher(
  options: RunOptions,
  cwd: string,
  config: GisConfig,
  report: (message: string) => void,
  onHumanGate: OnHumanGate,
): Dispatcher {
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

  const processBead = createBeadJobProcessor({
    cwd,
    config,
    beads,
    herdr,
    worktrees,
    workers,
    blocked,
    verify,
    merge,
    resolveTranscript,
    report,
    onHumanGate,
  });

  return { processBead, beads };
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

  // Both option validations run before createDispatcher so that a caller
  // passing several invalid options still sees the RangeError first, as it
  // did when createBeadJobProcessor (which can throw ConfigError) was wired
  // up here rather than inside the dispatcher.
  const humanPollIntervalMs = resolveHumanPollIntervalMs(options);
  const counts: JobOutcomeCounts = {
    merged: resolveInitialMerged(options),
    blocked: 0,
  };

  const report = resolveReport(options);
  const humanGate = new HumanGateTracker(report);
  const { processBead, beads } = createDispatcher(
    options,
    cwd,
    config,
    report,
    (gate, locations) => {
      humanGate.recordFromWorker(gate, locations.worktreePath);
    },
  );

  const active = new Map<string, Promise<JobOutcome>>();

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
