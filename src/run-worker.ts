import { join, resolve } from 'node:path';
import type { Bead, BeadHandoffLocations, HumanGateRequest } from './beads.js';
import type { GisConfig, ProfileCandidate } from './config.js';
import { parseDurationMs } from './config.js';
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
  type VerifyLoopOptions,
  type VerifyLoopResult,
} from './verify.js';
import { delay, errorMessage } from './internal.js';

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
  const processBead = async (bead: Bead): Promise<JobOutcome> => {
    const agentName = herdrAgentName(bead.id);
    let worktree: BeadWorktree;
    try {
      worktree = await options.worktrees.create({
        bead,
        config: options.config,
        cwd: options.cwd,
        herdr: options.herdr,
      });
    } catch (error: unknown) {
      options.report(
        `gis: worktree creation failed for ${bead.id}: ${errorMessage(error)}`,
      );
      // There is no worktree to retain when creation itself fails. Still
      // persist a deterministic intended handoff so the bead cannot vanish
      // from the run with an in-progress status.
      const intendedPath = resolve(options.cwd, '.worktrees', bead.id);
      await options.beads.markBlocked(
        bead.id,
        handoff(
          { path: intendedPath, runPath: join(intendedPath, '.gis', 'run') },
          defaultTranscriptPath('unknown', intendedPath),
        ),
      );
      return { status: 'blocked' };
    }

    let started: StartedWorker | undefined;
    let workerKind: string | undefined;
    let implementationCandidate: ProfileCandidate | undefined;
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
      started = selection.result;
      workerKind = selection.candidate.kind;
      implementationCandidate = selection.candidate;
    } catch (error: unknown) {
      const phase =
        error instanceof WorkerStartupError ? error.phase : 'startup';
      options.report(
        `gis: worker ${phase} failed for ${bead.id}: ${errorMessage(error)}`,
      );
      const transcriptPath = defaultTranscriptPath(
        workerKind ?? 'unknown',
        worktree.path,
      );
      await options.beads.markBlocked(
        bead.id,
        handoff(worktree, transcriptPath),
      );
      return { status: 'blocked' };
    }

    if (started === undefined || workerKind === undefined) {
      options.report(`gis: worker startup returned no worker for ${bead.id}`);
      await options.beads.markBlocked(
        bead.id,
        handoff(
          worktree,
          defaultTranscriptPath(workerKind ?? 'unknown', worktree.path),
        ),
      );
      return { status: 'blocked' };
    }
    const startedWorker = started;
    const implementationKind = workerKind;

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
    const waitOptions = {
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

    let waitResult: AgentWaitHandlingResult;
    try {
      waitResult = await options.blocked.wait(waitOptions);
    } catch (error: unknown) {
      options.report(
        `gis: worker wait failed for ${bead.id}: ${errorMessage(error)}`,
      );
      await options.beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }
    if (waitResult.status === 'blocked') {
      return { status: 'blocked' };
    }

    let result: ResultFileState;
    try {
      result = await waitForCurrentResult(
        startedWorker.prompt.resultPath,
        startedWorker.prompt.runId,
        options.config.blocked_timeout,
      );
    } catch (error: unknown) {
      options.report(
        `gis: worker result read failed for ${bead.id}: ${errorMessage(error)}`,
      );
      await options.beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }

    switch (result.kind) {
      case 'needs_human': {
        const locations = await currentHandoff();
        await options.beads.markBlocked(bead.id, locations);
        try {
          const gate = await options.beads.createHumanGate({
            issueId: bead.id,
            reason: result.reason,
            locations,
          });
          options.onHumanGate(gate, locations);
          return { status: 'human' };
        } catch {
          return { status: 'blocked' };
        }
      }
      case 'success':
        break;
      case 'failure':
      case 'invalid_schema':
      case 'invalid_json':
      case 'stale':
      case 'missing': {
        const detail = workerResultProblemDetail(result);
        options.report(
          `gis: worker result ${result.kind} for ${bead.id}: ${detail}`,
        );
        await options.beads.markBlocked(bead.id, await currentHandoff());
        return { status: 'blocked' };
      }
      default: {
        // Keep the compile-time exhaustiveness check, but protect a running
        // older JS artifact or malformed adapter value by retaining the bead.
        const unexpected: never = result;
        options.report(
          `gis: worker result had an unknown kind for ${bead.id}: ` +
            JSON.stringify(unexpected),
        );
        await options.beads.markBlocked(bead.id, await currentHandoff());
        return { status: 'blocked' };
      }
    }

    let latestSlopFeedback: string | undefined;
    const verifyImplementation = async (
      verificationCycle: VerificationCycle = { kind: 'initial' },
    ): Promise<'verified' | 'blocked'> => {
      const verification = await options.verify.verify({
        bead,
        worktreePath: worktree.path,
        runPath: worktree.runPath,
        transcriptPath: await currentTranscriptPath(),
        resolveTranscriptPath: currentTranscriptPath,
        config: options.config,
        beads: options.beads,
        target: agentName,
        herdr: options.herdr,
        waitForWorker: async () => {
          const retry = await options.blocked.wait(waitOptions);
          if (retry.status === 'blocked') {
            throw new AlreadyBlockedError(retry.bead ?? bead);
          }
        },
        verificationCycle,
      });
      if (verification.status === 'verified') {
        latestSlopFeedback = slopFeedback(verification.result);
        if (latestSlopFeedback !== undefined) {
          options.report(
            `gis: ${bead.id} ${latestSlopFeedback.replaceAll('\n', ' ')}`,
          );
          try {
            await options.herdr.agentPrompt(
              agentName,
              `${latestSlopFeedback}\n\nKeep this in mind for subsequent changes.`,
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
        return { status: 'blocked' };
      }

      if (options.config.review) {
        if (options.herdr.paneSplit === undefined) {
          options.report(
            `gis: review cannot start for ${bead.id}: herdr pane.split is unavailable`,
          );
          await options.beads.markBlocked(bead.id, await currentHandoff());
          return { status: 'blocked' };
        }
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
          implementationWaitOptions: waitOptions,
          implementationHandoff: currentHandoff,
          reviewerTranscriptPath,
          verifyImplementation,
          getSlopFeedback: () => latestSlopFeedback,
          onHumanGate: options.onHumanGate,
          report: options.report,
        });
        if (reviewOutcome !== 'approved') {
          return { status: reviewOutcome };
        }
      }

      const finalTranscriptPath = await currentTranscriptPath();
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
        if (mergeResult.cleanupError !== undefined) {
          options.report(
            `gis: cleanup failed for ${bead.id}; main and bd are merged, ` +
              'but the worktree was retained for manual recovery',
          );
        }
        return { status: 'merged' };
      }
      return { status: 'blocked' };
    } catch (error: unknown) {
      if (error instanceof AlreadyBlockedError) {
        return { status: 'blocked' };
      }
      await options.beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }
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
