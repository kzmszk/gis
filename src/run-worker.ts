import { join, resolve } from 'node:path';
import type { Bead, BeadHandoffLocations, HumanGateRequest } from './beads.js';
import type { GisConfig, ProfileCandidate } from './config.js';
import { ConfigError, parseDurationMs } from './config.js';
import { startWithProfileFallback } from './profiles.js';
import {
  readWorkerResult,
  workerResultProblemDetail,
  type ResultFileState,
} from './result.js';
import type {
  AgentWaitHandlingResult,
  BlockedHerdrSource,
  BlockedHandlingOptions,
} from './blocked.js';
import type {
  BeadWorktree,
  CreateBeadWorktreeOptions,
  WorktreeLifecycleSource,
} from './worktree.js';
import {
  herdrAgentName,
  type StartedWorker,
  type StartWorkerOptions,
  type WorkerPromptSource,
  type WorkerStartupSource,
  type VerificationCycle,
  WorkerStartupError,
} from './worker.js';
import type { ReviewHerdrSource, StartedReviewer } from './review.js';
import { runReviewLoop } from './review-loop.js';
import type { AgentInfo, AgentSessionInfo } from './herdr.js';
import type { MergeQueueItem, MergeResult } from './merge.js';
import {
  slopFeedback,
  slopWorsened,
  type VerifyLoopOptions,
  type VerifyLoopResult,
} from './verify.js';
import { delay, errorMessage } from './internal.js';
import {
  updateRecoveryFailure,
  type RecoveryFailureCode,
} from './recovery-manifest.js';

/** The terminal state recorded by a job in the foreground orchestration loop. */
export type JobOutcome =
  | { readonly status: 'merged' }
  | { readonly status: 'blocked' }
  | { readonly status: 'human' };

export type BeadJobHerdrSource = WorktreeLifecycleSource &
  WorkerStartupSource &
  WorkerPromptSource &
  BlockedHerdrSource & {
    paneSplit?: ReviewHerdrSource['paneSplit'];
  };

export interface BeadJobBeadsSource {
  dispatch(issueId: string, kind: string): Promise<Bead>;
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
  createHumanGate(request: HumanGateRequest): Promise<Bead>;
}

export interface BeadJobWorktreeSource {
  create(options: CreateBeadWorktreeOptions): Promise<BeadWorktree>;
}

export interface BeadJobWorkerSource {
  start(options: StartWorkerOptions): Promise<StartedWorker>;
}

export interface BeadJobBlockedSource {
  wait(options: BlockedHandlingOptions): Promise<AgentWaitHandlingResult>;
}

export interface BeadJobVerifySource {
  verify(options: VerifyLoopOptions): Promise<VerifyLoopResult>;
}

export interface BeadJobMergeSource {
  enqueue(item: MergeQueueItem): Promise<MergeResult>;
}

class AlreadyBlockedError extends Error {
  readonly bead: Bead;

  constructor(bead: Bead) {
    super(`worker for ${bead.id} entered blocked state`);
    this.name = 'AlreadyBlockedError';
    this.bead = bead;
  }
}

export interface BeadJobProcessorOptions {
  readonly cwd: string;
  readonly config: GisConfig;
  readonly beads: BeadJobBeadsSource;
  readonly herdr: BeadJobHerdrSource;
  readonly worktrees: BeadJobWorktreeSource;
  readonly workers: BeadJobWorkerSource;
  readonly blocked: BeadJobBlockedSource;
  readonly verify: BeadJobVerifySource;
  readonly merge: BeadJobMergeSource;
  readonly resolveTranscript: (
    session: AgentSessionInfo,
    worktreePath: string,
  ) => Promise<string | undefined>;
  readonly report: (message: string) => void;
  /** Called when a worker creates a human gate, before the job is released. */
  readonly onHumanGate: (gate: Bead, locations: BeadHandoffLocations) => void;
}

function defaultTranscriptPath(kind: string, worktreePath: string): string {
  return join(worktreePath, '.gis', 'run', `transcript-${kind}.unresolved`);
}

function handoff(
  worktree: Pick<BeadWorktree, 'path' | 'runPath'>,
  transcriptPath: string,
): BeadHandoffLocations {
  return {
    worktreePath: worktree.path,
    roundLogPath: worktree.runPath,
    transcriptPath,
  };
}

/** Best-effort update of the machine-readable handoff state.
 *
 * A missing or malformed manifest must never hide the original blocked
 * transition; the Beads handoff remains authoritative for legacy workers.
 */
async function recordRecoveryFailure(
  worktreePath: string,
  failureCode: RecoveryFailureCode,
): Promise<void> {
  await updateRecoveryFailure(worktreePath, failureCode);
}

async function waitForCurrentResult(
  path: string,
  runId: string | undefined,
  timeout: string,
): Promise<ResultFileState> {
  const deadline = Date.now() + parseDurationMs(timeout, 'blocked_timeout');
  while (true) {
    const result = await readWorkerResult(path, runId);
    if (result.kind !== 'missing' && result.kind !== 'stale') {
      return result;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return result;
    }
    await delay(Math.min(250, remaining));
  }
}

function agentSession(
  agent: AgentInfo | undefined,
): AgentSessionInfo | undefined {
  return agent?.agent_session ?? undefined;
}

async function findWorkerSession(
  started: StartedWorker,
  agentName: string,
  herdr: BeadJobHerdrSource,
): Promise<AgentSessionInfo | undefined> {
  const direct =
    agentSession(started.prompted?.agent) ??
    agentSession(started.started?.agent);
  if (herdr.apiSnapshot === undefined) {
    return direct;
  }

  try {
    const paneId =
      started.prompted?.agent?.pane_id ?? started.started?.agent?.pane_id;
    const agents = (await herdr.apiSnapshot()).snapshot.agents;
    const exactPane =
      paneId === undefined
        ? undefined
        : agents.find((agent) => agent.pane_id === paneId);
    if (exactPane !== undefined) {
      return agentSession(exactPane);
    }
    const named = agents.find((agent) => agent.name === agentName);
    return agentSession(named);
  } catch {
    // A captured start/prompt response is only a fallback when live state
    // cannot be read. A successful snapshot without a session is authoritative.
    return direct;
  }
}

async function resolveWorkerTranscriptPath(
  started: StartedWorker,
  agentName: string,
  kind: string,
  worktreePath: string,
  herdr: BeadJobHerdrSource,
  resolveTranscript: BeadJobProcessorOptions['resolveTranscript'],
): Promise<string> {
  const fallback = defaultTranscriptPath(kind, worktreePath);
  try {
    const session = await findWorkerSession(started, agentName, herdr);
    if (session === undefined) {
      return fallback;
    }
    return (await resolveTranscript(session, worktreePath)) ?? fallback;
  } catch {
    return fallback;
  }
}

type WorktreeStartup =
  | { readonly worktree: BeadWorktree }
  | { readonly outcome: 'blocked' };

/**
 * Create the worktree for one bead, or record the deterministic "intended"
 * handoff and report failure.
 *
 * There is no worktree to retain when creation itself fails, so the failure
 * branch persists a synthesized handoff (the path the worktree would have
 * had) instead of a real one, so the bead cannot vanish from the run with an
 * in-progress status.
 */
async function startBeadWorktree(
  bead: Bead,
  options: BeadJobProcessorOptions,
): Promise<WorktreeStartup> {
  try {
    const worktree = await options.worktrees.create({
      bead,
      config: options.config,
      cwd: options.cwd,
      herdr: options.herdr,
    });
    return { worktree };
  } catch (error: unknown) {
    options.report(
      `gis: worktree creation failed for ${bead.id}: ${errorMessage(error)}`,
    );
    const intendedPath = resolve(options.cwd, '.worktrees', bead.id);
    await options.beads.markBlocked(
      bead.id,
      handoff(
        { path: intendedPath, runPath: join(intendedPath, '.gis', 'run') },
        defaultTranscriptPath('unknown', intendedPath),
      ),
    );
    return { outcome: 'blocked' };
  }
}

type WorkerStartup =
  | {
      readonly startedWorker: StartedWorker;
      readonly implementationKind: string;
      readonly implementationCandidate: ProfileCandidate;
    }
  | { readonly outcome: 'blocked' };

/**
 * Dispatch and start the implementation worker, falling back across profile
 * candidates on a startup failure.
 *
 * No worker session exists yet on failure, so the handoff below resolves the
 * transcript path directly from the last-attempted candidate's kind rather
 * than through `resolveWorkerTranscriptPath` (there is nothing live to ask).
 */
async function startImplementationWorker(
  bead: Bead,
  worktree: BeadWorktree,
  agentName: string,
  options: BeadJobProcessorOptions,
): Promise<WorkerStartup> {
  let workerKind: string | undefined;
  try {
    const selection = await startWithProfileFallback(
      bead,
      options.config,
      async (candidate) => {
        workerKind = candidate.kind;
        await options.beads.dispatch(bead.id, candidate.kind);
        return options.workers.start({
          bead,
          agentName,
          worktreePath: worktree.path,
          runPath: worktree.runPath,
          verifyCommand: options.config.verify,
          paneId: worktree.paneId,
          candidate,
          config: options.config,
          herdr: undefined,
        });
      },
      {
        shouldFallback: (error) =>
          error instanceof WorkerStartupError && error.phase === 'start',
      },
    );
    return {
      startedWorker: selection.result,
      implementationKind: selection.candidate.kind,
      implementationCandidate: selection.candidate,
    };
  } catch (error: unknown) {
    const phase = error instanceof WorkerStartupError ? error.phase : 'startup';
    options.report(
      `gis: worker ${phase} failed for ${bead.id}: ${errorMessage(error)}`,
    );
    await recordRecoveryFailure(worktree.path, 'worker_start');
    const transcriptPath = defaultTranscriptPath(
      workerKind ?? 'unknown',
      worktree.path,
    );
    await options.beads.markBlocked(bead.id, handoff(worktree, transcriptPath));
    return { outcome: 'blocked' };
  }
}

/**
 * The live state a started implementation worker carries through waiting,
 * verification, review, and merge: its worktree/session identity plus the
 * derived handoff helpers every later stage reads from.
 */
interface WorkerSession {
  readonly bead: Bead;
  readonly worktree: BeadWorktree;
  readonly agentName: string;
  readonly startedWorker: StartedWorker;
  readonly implementationKind: string;
  /** Resolve the live transcript path, falling back to the default path. */
  readonly currentTranscriptPath: () => Promise<string>;
  /** Build a handoff from the worktree and the current transcript path. */
  readonly currentHandoff: () => Promise<BeadHandoffLocations>;
  readonly waitOptions: BlockedHandlingOptions;
}

function buildWorkerSession(
  bead: Bead,
  worktree: BeadWorktree,
  agentName: string,
  startedWorker: StartedWorker,
  implementationKind: string,
  options: BeadJobProcessorOptions,
): WorkerSession {
  const currentTranscriptPath = (): Promise<string> =>
    resolveWorkerTranscriptPath(
      startedWorker,
      agentName,
      implementationKind,
      worktree.path,
      options.herdr,
      options.resolveTranscript,
    );
  const currentHandoff = async (): Promise<BeadHandoffLocations> =>
    handoff(worktree, await currentTranscriptPath());
  const waitOptions: BlockedHandlingOptions = {
    beadId: bead.id,
    target: agentName,
    worktreePath: worktree.path,
    roundLogPath: worktree.runPath,
    transcriptPath: defaultTranscriptPath(implementationKind, worktree.path),
    resolveTranscriptPath: currentTranscriptPath,
    blockedTimeout: options.config.blocked_timeout,
    workerTimeout: options.config.worker_timeout,
    herdr: options.herdr,
    beads: options.beads,
  };
  return {
    bead,
    worktree,
    agentName,
    startedWorker,
    implementationKind,
    currentTranscriptPath,
    currentHandoff,
    waitOptions,
  };
}

/**
 * Wait for the implementation worker's round to finish, then read and
 * classify its result.
 *
 * Order matches the original inline pipeline: the agent wait always runs
 * before the result read. Every failure mode along either step, and every
 * non-`success` result kind but `needs_human`, is folded into the same
 * "report, mark blocked, return 'blocked'" shape via the local
 * `blockWithReport` closure — that pattern recurred four times inline here
 * (wait failure, result-read failure, the five result-problem kinds, and the
 * defensive default case) and is now one three-line helper.
 */
async function waitForImplementationOutcome(
  session: WorkerSession,
  options: BeadJobProcessorOptions,
): Promise<'success' | 'human' | 'blocked'> {
  const blockWithReport = async (
    message: string,
    failureCode: RecoveryFailureCode,
  ): Promise<'blocked'> => {
    options.report(message);
    await recordRecoveryFailure(session.worktree.path, failureCode);
    await options.beads.markBlocked(
      session.bead.id,
      await session.currentHandoff(),
    );
    return 'blocked';
  };

  let waitResult: AgentWaitHandlingResult;
  try {
    waitResult = await options.blocked.wait(session.waitOptions);
  } catch (error: unknown) {
    return blockWithReport(
      `gis: worker wait failed for ${session.bead.id}: ${errorMessage(error)}`,
      'worker_wait',
    );
  }
  if (waitResult.status === 'blocked') {
    await recordRecoveryFailure(session.worktree.path, 'worker_wait');
    return 'blocked';
  }

  let result: ResultFileState;
  try {
    result = await waitForCurrentResult(
      session.startedWorker.prompt.resultPath,
      session.startedWorker.prompt.runId,
      options.config.blocked_timeout,
    );
  } catch (error: unknown) {
    return blockWithReport(
      `gis: worker result read failed for ${session.bead.id}: ${errorMessage(error)}`,
      'result_invalid',
    );
  }

  switch (result.kind) {
    case 'needs_human': {
      await recordRecoveryFailure(session.worktree.path, 'human_gate');
      const locations = await session.currentHandoff();
      await options.beads.markBlocked(session.bead.id, locations);
      try {
        const gate = await options.beads.createHumanGate({
          issueId: session.bead.id,
          reason: result.reason,
          locations,
        });
        options.onHumanGate(gate, locations);
        return 'human';
      } catch {
        return 'blocked';
      }
    }
    case 'success':
      return 'success';
    case 'failure':
    case 'invalid_schema':
    case 'invalid_json':
    case 'stale':
    case 'missing': {
      const detail = workerResultProblemDetail(result);
      return blockWithReport(
        `gis: worker result ${result.kind} for ${session.bead.id}: ${detail}`,
        result.kind === 'missing' || result.kind === 'stale'
          ? 'result_missing'
          : 'result_invalid',
      );
    }
    default: {
      // Keep the compile-time exhaustiveness check, but protect a running
      // older JS artifact or malformed adapter value by retaining the bead.
      const unexpected: never = result;
      return blockWithReport(
        `gis: worker result had an unknown kind for ${session.bead.id}: ` +
          JSON.stringify(unexpected),
        'result_invalid',
      );
    }
  }
}

/**
 * Verify, optionally review, and merge a bead whose implementation worker
 * has already produced a `success` result.
 *
 * Order matches the original inline pipeline: initial verification, then
 * (if enabled) the review loop, then merge. An `AlreadyBlockedError` raised
 * by `verifyImplementation`'s `waitForWorker` (via the review loop's
 * re-verification path) means blocked state was already recorded by the
 * agent-wait that threw it, so the catch below must not mark blocked again.
 */
async function finishImplementation(
  session: WorkerSession,
  implementationCandidate: ProfileCandidate,
  options: BeadJobProcessorOptions,
): Promise<JobOutcome> {
  const { bead, worktree, agentName, implementationKind } = session;

  let latestSlopFeedback: string | undefined;
  const verifyImplementation = async (
    verificationCycle: VerificationCycle = { kind: 'initial' },
  ): Promise<'verified' | 'blocked'> => {
    const verification = await options.verify.verify({
      bead,
      worktreePath: worktree.path,
      runPath: worktree.runPath,
      transcriptPath: await session.currentTranscriptPath(),
      resolveTranscriptPath: session.currentTranscriptPath,
      config: options.config,
      beads: options.beads,
      target: agentName,
      herdr: options.herdr,
      waitForWorker: async () => {
        const retry = await options.blocked.wait(session.waitOptions);
        if (retry.status === 'blocked') {
          throw new AlreadyBlockedError(retry.bead ?? bead);
        }
      },
      verificationCycle,
    });
    if (verification.status === 'verified') {
      latestSlopFeedback = slopFeedback(verification.result);
      if (
        latestSlopFeedback !== undefined &&
        slopWorsened(verification.result)
      ) {
        options.report(
          `gis: ${bead.id} ${latestSlopFeedback.replaceAll('\n', ' ')}`,
        );
        try {
          await options.herdr.agentPrompt(
            agentName,
            `The latest verification passed, but the quality metrics worsened. This is informational only; consider it if you are asked to make further changes in this task.\n\n${latestSlopFeedback}`,
          );
        } catch (error: unknown) {
          options.report(
            `gis: could not deliver informational slop report to ${bead.id}: ${errorMessage(error)}`,
          );
        }
      }
    }
    return verification.status;
  };

  try {
    if ((await verifyImplementation({ kind: 'initial' })) === 'blocked') {
      await recordRecoveryFailure(worktree.path, 'verification');
      return { status: 'blocked' };
    }

    if (options.config.review) {
      const reviewerTranscriptPath = (
        reviewer: StartedReviewer,
      ): Promise<string> =>
        resolveWorkerTranscriptPath(
          reviewer.selection.result,
          reviewer.agentName,
          reviewer.selection.candidate.kind,
          worktree.path,
          options.herdr,
          options.resolveTranscript,
        );
      const reviewOutcome = await runReviewLoop({
        bead,
        worktree,
        config: options.config,
        implementation: {
          agentName,
          kind: implementationKind,
          candidate: implementationCandidate,
        },
        herdr: options.herdr as ReviewHerdrSource,
        beads: options.beads,
        blocked: options.blocked,
        implementationWaitOptions: session.waitOptions,
        implementationHandoff: session.currentHandoff,
        reviewerTranscriptPath,
        verifyImplementation,
        getSlopFeedback: () => latestSlopFeedback,
        onHumanGate: options.onHumanGate,
        report: options.report,
      });
      if (reviewOutcome !== 'approved') {
        await recordRecoveryFailure(
          worktree.path,
          reviewOutcome === 'human' ? 'human_gate' : 'review_blocked',
        );
        return { status: reviewOutcome };
      }
    }

    await recordRecoveryFailure(worktree.path, 'ready_to_merge');
    const finalTranscriptPath = await session.currentTranscriptPath();
    const mergeResult = await options.merge.enqueue({
      bead,
      worktree,
      transcriptPath: finalTranscriptPath,
    });
    if (mergeResult.status === 'merged') {
      if (mergeResult.stateError !== undefined) {
        options.report(
          `gis: main contains ${bead.id}, but closing the Beads issue failed; ` +
            'the worktree was retained for manual reconciliation',
        );
      }
      const cleanup = mergeResult.cleanup;
      if (cleanup?.status === 'worktree_failed') {
        options.report(
          `gis: cleanup failed for ${bead.id}; main and bd are merged, ` +
            `worktree removal failed and the worktree was retained at ${worktree.path}; ` +
            'retry worktree removal before deleting the branch',
        );
      } else if (cleanup?.status === 'branch_failed') {
        options.report(
          `gis: cleanup failed for ${bead.id}; main and bd are merged, ` +
            `the worktree was removed but branch deletion failed; retry deleting branch ${bead.id} ` +
            'because no worktree remains',
        );
      } else if (mergeResult.cleanupError !== undefined) {
        // Compatibility for merge sources that still return the pre-gis-zjr
        // result shape. New queue results always use the discriminated
        // cleanup outcome above.
        options.report(
          `gis: cleanup failed for ${bead.id}; main and bd are merged, ` +
            'but the cleanup state could not be determined for manual recovery',
        );
      }
      return { status: 'merged' };
    }
    await recordRecoveryFailure(worktree.path, 'commit');
    return { status: 'blocked' };
  } catch (error: unknown) {
    if (error instanceof AlreadyBlockedError) {
      await recordRecoveryFailure(worktree.path, 'worker_wait');
      return { status: 'blocked' };
    }
    await recordRecoveryFailure(worktree.path, 'verification');
    await options.beads.markBlocked(bead.id, await session.currentHandoff());
    return { status: 'blocked' };
  }
}

/**
 * Build the lifecycle service for one foreground run.
 *
 * The returned function owns worktree creation, worker startup/waiting, result
 * classification, verification, review, and merge. The caller only schedules
 * jobs and aggregates their terminal outcomes.
 */
export function createBeadJobProcessor(
  options: BeadJobProcessorOptions,
): (bead: Bead) => Promise<JobOutcome> {
  if (options.config.review && options.herdr.paneSplit === undefined) {
    throw new ConfigError(
      'review is enabled but the herdr adapter does not support pane.split; ' +
        'set review = false, or use a herdr adapter/version that implements pane.split',
    );
  }

  const processBead = async (bead: Bead): Promise<JobOutcome> => {
    const agentName = herdrAgentName(bead.id);

    const worktreeStartup = await startBeadWorktree(bead, options);
    if ('outcome' in worktreeStartup) {
      return { status: worktreeStartup.outcome };
    }
    const { worktree } = worktreeStartup;

    const workerStartup = await startImplementationWorker(
      bead,
      worktree,
      agentName,
      options,
    );
    if ('outcome' in workerStartup) {
      return { status: workerStartup.outcome };
    }
    const { startedWorker, implementationKind, implementationCandidate } =
      workerStartup;

    const session = buildWorkerSession(
      bead,
      worktree,
      agentName,
      startedWorker,
      implementationKind,
      options,
    );

    const outcome = await waitForImplementationOutcome(session, options);
    if (outcome !== 'success') {
      return { status: outcome };
    }

    return finishImplementation(session, implementationCandidate, options);
  };

  return async (bead: Bead): Promise<JobOutcome> => {
    try {
      return await processBead(bead);
    } catch (error: unknown) {
      options.report(
        `gis: job ${bead.id} failed while recording recovery state: ` +
          errorMessage(error),
      );
      return { status: 'blocked' };
    }
  };
}
