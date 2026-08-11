import type { Bead, BeadHandoffLocations } from './beads.js';
import type {
  AgentWaitHandlingResult,
  BlockedHandlingOptions,
} from './blocked.js';
import type { GisConfig, ProfileCandidate } from './config.js';
import { parseDurationMs } from './config.js';
import {
  promptReviewer,
  readReviewResult,
  startReviewer,
  type ReviewHerdrSource,
  type ReviewResultState,
  type StartedReviewer,
} from './review.js';
import { promptWorker, type ReviewVerificationCycle } from './worker.js';
import {
  readWorkerResult,
  workerResultProblemDetail,
  type ResultFileState,
  type WorkerResultProblem,
} from './result.js';
import type { BeadWorktree } from './worktree.js';

export type ReviewLoopOutcome = 'approved' | 'blocked' | 'human';

export interface ReviewLoopOptions {
  readonly bead: Bead;
  readonly worktree: BeadWorktree;
  readonly config: GisConfig;
  readonly implementation: {
    readonly agentName: string;
    readonly kind: string;
    readonly candidate?: ProfileCandidate;
  };
  readonly herdr: ReviewHerdrSource;
  readonly beads: {
    markBlocked(
      issueId: string,
      locations: BeadHandoffLocations,
    ): Promise<Bead>;
    createHumanGate(request: {
      issueId: string;
      reason: string;
      locations: BeadHandoffLocations;
    }): Promise<Bead>;
  };
  readonly blocked: {
    wait(options: BlockedHandlingOptions): Promise<AgentWaitHandlingResult>;
  };
  readonly implementationWaitOptions: BlockedHandlingOptions;
  readonly implementationHandoff: () => Promise<BeadHandoffLocations>;
  readonly reviewerTranscriptPath: (
    reviewer: StartedReviewer,
  ) => Promise<string>;
  readonly verifyImplementation: (
    cycle: ReviewVerificationCycle,
  ) => Promise<'verified' | 'blocked'>;
  /** Informational quality metrics from the most recent successful verification. */
  readonly getSlopFeedback?: () => string | undefined;
  readonly onHumanGate: (gate: Bead, locations: BeadHandoffLocations) => void;
  readonly report: (message: string) => void;
}

export type ReviewProblem = Exclude<
  ReviewResultState,
  | { readonly kind: 'success' }
  | { readonly kind: 'changes_requested' }
  | { readonly kind: 'needs_human' }
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`unhandled review result: ${JSON.stringify(value)}`);
}

export function reviewProblemDetail(result: ReviewProblem): string {
  switch (result.kind) {
    case 'failure':
      return result.result.summary;
    case 'invalid_schema':
      return result.issues.join('; ');
    case 'invalid_json':
      return result.message;
    case 'stale':
      return `result file belongs to another run: ${result.path}`;
    case 'missing':
      return `result file is missing: ${result.path}`;
    default:
      return assertNever(result);
  }
}

export function requestedChangesFeedback(
  result: Extract<ReviewResultState, { readonly kind: 'changes_requested' }>,
): string {
  const feedback = result.result.feedback?.trim();
  return feedback === undefined || feedback.length === 0
    ? result.result.summary
    : feedback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForImplementationResult(
  path: string,
  runId: string,
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

async function reviewerHandoff(
  reviewer: StartedReviewer,
  options: ReviewLoopOptions,
): Promise<BeadHandoffLocations> {
  return {
    worktreePath: options.worktree.path,
    roundLogPath: options.worktree.runPath,
    transcriptPath: await options.reviewerTranscriptPath(reviewer),
  };
}

async function block(
  locations: BeadHandoffLocations,
  options: ReviewLoopOptions,
): Promise<void> {
  await options.beads.markBlocked(options.bead.id, locations);
}

async function requestHuman(
  reason: string,
  locations: BeadHandoffLocations,
  options: ReviewLoopOptions,
): Promise<'human' | 'blocked'> {
  await block(locations, options);
  try {
    const gate = await options.beads.createHumanGate({
      issueId: options.bead.id,
      reason,
      locations,
    });
    options.onHumanGate(gate, locations);
    return 'human';
  } catch {
    return 'blocked';
  }
}

async function waitForReviewResult(
  path: string,
  runId: string,
  timeout: string,
): Promise<ReviewResultState> {
  const deadline = Date.now() + parseDurationMs(timeout, 'blocked_timeout');
  while (true) {
    const result = await readReviewResult(path, runId);
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

async function blockReviewProblem(
  result: ReviewProblem,
  reviewer: StartedReviewer,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  const detail = reviewProblemDetail(result);
  options.report(
    `gis: reviewer result ${result.kind} for ${options.bead.id}: ${detail}`,
  );
  await block(await reviewerHandoff(reviewer, options), options);
  return 'blocked';
}

async function blockImplementationProblem(
  result: WorkerResultProblem,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  const detail = workerResultProblemDetail(result);
  options.report(
    `gis: implementation result ${result.kind} for ${options.bead.id}: ${detail}`,
  );
  await block(await options.implementationHandoff(), options);
  return 'blocked';
}

async function handleImplementationResult(
  prompt: { readonly resultPath: string; readonly runId: string },
  options: ReviewLoopOptions,
): Promise<'success' | 'human' | 'blocked'> {
  let result: ResultFileState;
  try {
    result = await waitForImplementationResult(
      prompt.resultPath,
      prompt.runId,
      options.config.blocked_timeout,
    );
  } catch (error: unknown) {
    options.report(
      `gis: implementation result read failed for ${options.bead.id}: ${errorMessage(error)}`,
    );
    await block(await options.implementationHandoff(), options);
    return 'blocked';
  }

  switch (result.kind) {
    case 'success':
      return 'success';
    case 'needs_human':
      return requestHuman(
        result.reason,
        await options.implementationHandoff(),
        options,
      );
    case 'failure':
    case 'invalid_schema':
    case 'invalid_json':
    case 'stale':
    case 'missing':
      return blockImplementationProblem(result, options);
    default:
      return assertNever(result);
  }
}

async function requestReviewLimitDecision(
  feedback: string,
  reviewer: StartedReviewer,
  options: ReviewLoopOptions,
): Promise<'human' | 'blocked'> {
  const locations = await reviewerHandoff(reviewer, options);
  const reason = [
    `review_max=${options.config.review_max} reached after reviewer requested changes`,
    `reviewer feedback: ${feedback}`,
    `inspect the implementation at ${locations.worktreePath}`,
    `review round files are under ${locations.roundLogPath}`,
  ].join('; ');
  return requestHuman(reason, locations, options);
}

/** Run the review state machine after implementation verification succeeds. */
export async function runReviewLoop(
  options: ReviewLoopOptions,
): Promise<ReviewLoopOutcome> {
  if (options.herdr.paneSplit === undefined) {
    options.report(
      `gis: reviewer startup failed for ${options.bead.id}: Herdr pane.split is unavailable`,
    );
    await block(await options.implementationHandoff(), options);
    return 'blocked';
  }

  let reviewer: StartedReviewer;
  try {
    reviewer = await startReviewer({
      bead: options.bead,
      worktreePath: options.worktree.path,
      runPath: options.worktree.runPath,
      implementationPaneId: options.worktree.paneId,
      workspaceId: options.worktree.workspaceId,
      implementationKind: options.implementation.kind,
      implementationCandidate: options.implementation.candidate,
      config: options.config,
      herdr: options.herdr,
      reviewFeedback: options.getSlopFeedback?.(),
    });
  } catch (error: unknown) {
    options.report(
      `gis: reviewer startup failed for ${options.bead.id}: ${errorMessage(error)}`,
    );
    await block(await options.implementationHandoff(), options);
    return 'blocked';
  }

  if (reviewer.selection.candidate.kind === options.implementation.kind) {
    options.report(
      `gis: reviewer kind fallback for ${options.bead.id}: implementation and reviewer both use ${options.implementation.kind}; review continues in the fallback kind`,
    );
  }

  let round = 1;
  let prompt = reviewer.selection.result.prompt;
  let lastSlopFeedback = options.getSlopFeedback?.();

  while (true) {
    let reviewerStatus: 'done' | 'blocked';
    try {
      const resolveTranscriptPath = () =>
        options.reviewerTranscriptPath(reviewer);
      const waitResult = await options.blocked.wait({
        ...options.implementationWaitOptions,
        target: reviewer.agentName,
        transcriptPath: await resolveTranscriptPath(),
        resolveTranscriptPath,
      });
      reviewerStatus = waitResult.status;
    } catch (error: unknown) {
      options.report(
        `gis: reviewer wait failed for ${options.bead.id}: ${errorMessage(error)}`,
      );
      await block(await reviewerHandoff(reviewer, options), options);
      return 'blocked';
    }
    if (reviewerStatus === 'blocked') {
      return 'blocked';
    }

    let result: ReviewResultState;
    try {
      result = await waitForReviewResult(
        prompt.resultPath,
        prompt.runId,
        options.config.blocked_timeout,
      );
    } catch (error: unknown) {
      options.report(
        `gis: reviewer result read failed for ${options.bead.id}: ${errorMessage(error)}`,
      );
      await block(await reviewerHandoff(reviewer, options), options);
      return 'blocked';
    }

    switch (result.kind) {
      case 'success':
        return 'approved';

      case 'needs_human':
        return requestHuman(
          result.reason,
          await reviewerHandoff(reviewer, options),
          options,
        );

      case 'failure':
      case 'invalid_schema':
      case 'invalid_json':
      case 'stale':
      case 'missing':
        return blockReviewProblem(result, reviewer, options);

      case 'changes_requested': {
        const feedback = requestedChangesFeedback(result);
        if (round >= options.config.review_max) {
          return requestReviewLimitDecision(feedback, reviewer, options);
        }

        options.report(
          `gis: reviewer requested changes for ${options.bead.id}; returning to implementation agent ${options.implementation.agentName}`,
        );
        const implementationPrompt = await promptWorker({
          bead: options.bead,
          runPath: options.worktree.runPath,
          verifyCommand: options.config.verify,
          round: round + 1,
          phase: 'review-fix',
          reviewFeedback: feedback,
          target: options.implementation.agentName,
          herdr: options.herdr,
        });
        let implementationWait: AgentWaitHandlingResult;
        try {
          implementationWait = await options.blocked.wait(
            options.implementationWaitOptions,
          );
        } catch (error: unknown) {
          options.report(
            `gis: implementation wait failed for ${options.bead.id}: ${errorMessage(error)}`,
          );
          await block(await options.implementationHandoff(), options);
          return 'blocked';
        }
        if (implementationWait.status === 'blocked') {
          return 'blocked';
        }
        const implementationOutcome = await handleImplementationResult(
          implementationPrompt.prompt,
          options,
        );
        if (implementationOutcome !== 'success') {
          return implementationOutcome;
        }
        if (
          (await options.verifyImplementation({ kind: 'review', round })) ===
          'blocked'
        ) {
          return 'blocked';
        }

        round += 1;
        try {
          const prompted = await promptReviewer({
            bead: options.bead,
            runPath: options.worktree.runPath,
            verifyCommand: options.config.verify,
            target: reviewer.agentName,
            round,
            implementationKind: options.implementation.kind,
            feedback: [
              (() => {
                const current = options.getSlopFeedback?.();
                const changed =
                  current === lastSlopFeedback ? undefined : current;
                lastSlopFeedback = current;
                return changed;
              })(),
              feedback,
            ]
              .filter((value): value is string => value !== undefined)
              .join('\n\n'),
            herdr: options.herdr,
          });
          prompt = prompted.prompt;
        } catch (error: unknown) {
          options.report(
            `gis: reviewer prompt failed for ${options.bead.id}: ${errorMessage(error)}`,
          );
          await block(await reviewerHandoff(reviewer, options), options);
          return 'blocked';
        }
        break;
      }

      default:
        return assertNever(result);
    }
  }
}
