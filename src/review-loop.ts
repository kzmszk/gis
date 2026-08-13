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
import {
  promptWorker,
  type ReviewVerificationCycle,
  type WorkerPrompt,
} from './worker.js';
import {
  readWorkerResult,
  workerResultProblemDetail,
  type ResultFileState,
  type WorkerResultProblem,
} from './result.js';
import type { BeadWorktree } from './worktree.js';
import { delay, errorMessage } from './internal.js';
import {
  updateRecoveryFailure,
  type RecoveryFailureCode,
} from './recovery-manifest.js';

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

async function recordReviewFailure(
  options: ReviewLoopOptions,
  failureCode: RecoveryFailureCode,
): Promise<void> {
  await updateRecoveryFailure(options.worktree.path, failureCode);
}

async function settleReviewOutcome(
  options: ReviewLoopOptions,
  outcome: ReviewLoopOutcome,
): Promise<ReviewLoopOutcome> {
  if (outcome === 'human') {
    await recordReviewFailure(options, 'human_gate');
  } else if (outcome === 'blocked') {
    await recordReviewFailure(options, 'review_blocked');
  }
  return outcome;
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

/**
 * Poll `read` until it reports a state other than "not written yet"
 * (missing/stale), or until `timeout` elapses. On timeout the last
 * missing/stale state is returned as-is so callers can report it.
 *
 * @internal Exported only for deterministic timer testing. Production code
 * outside this module must use the role-specific wait functions below.
 */
export async function pollUntilTerminal<T extends { readonly kind: string }>(
  read: () => Promise<T>,
  timeout: string,
): Promise<T> {
  const deadline = Date.now() + parseDurationMs(timeout, 'blocked_timeout');
  while (true) {
    const result = await read();
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

function waitForImplementationResult(
  path: string,
  runId: string,
  timeout: string,
): Promise<ResultFileState> {
  return pollUntilTerminal(() => readWorkerResult(path, runId), timeout);
}

function waitForReviewResult(
  path: string,
  runId: string,
  timeout: string,
): Promise<ReviewResultState> {
  return pollUntilTerminal(() => readReviewResult(path, runId), timeout);
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

/**
 * Report `message`, mark the bead blocked using the implementation agent's
 * worktree/transcript handoff, and settle the loop as 'blocked'.
 *
 * This is the implementation-side half of the "report, hand off, block"
 * protocol that recurs whenever something goes wrong before or while the
 * implementation agent is the one holding context (startup, its own result,
 * or a review-fix round). The reviewer-side half is
 * `blockWithReviewerHandoff`; they stay separate functions because each
 * builds a different handoff and merging them behind a flag would just move
 * the branch into the caller.
 */
async function blockWithImplementationHandoff(
  message: string,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  options.report(message);
  await block(await options.implementationHandoff(), options);
  return 'blocked';
}

/** The reviewer-side counterpart of `blockWithImplementationHandoff`. */
async function blockWithReviewerHandoff(
  message: string,
  reviewer: StartedReviewer,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  options.report(message);
  await block(await reviewerHandoff(reviewer, options), options);
  return 'blocked';
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

async function blockReviewProblem(
  result: ReviewProblem,
  reviewer: StartedReviewer,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  const detail = reviewProblemDetail(result);
  return blockWithReviewerHandoff(
    `gis: reviewer result ${result.kind} for ${options.bead.id}: ${detail}`,
    reviewer,
    options,
  );
}

async function blockImplementationProblem(
  result: WorkerResultProblem,
  options: ReviewLoopOptions,
): Promise<'blocked'> {
  const detail = workerResultProblemDetail(result);
  return blockWithImplementationHandoff(
    `gis: implementation result ${result.kind} for ${options.bead.id}: ${detail}`,
    options,
  );
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
    return blockWithImplementationHandoff(
      `gis: implementation result read failed for ${options.bead.id}: ${errorMessage(error)}`,
      options,
    );
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

type ReviewSession =
  | { readonly reviewer: StartedReviewer }
  | { readonly outcome: 'blocked' };

/**
 * Start the reviewer in a sibling pane.
 *
 * Invariants/order: the Herdr pane.split guard runs before anything else
 * (see the comment on that guard below); reviewer startup failures and a
 * same-kind fallback report are both handled here so the caller only ever
 * sees a ready `StartedReviewer` or a terminal 'blocked' outcome.
 */
async function startReviewSession(
  options: ReviewLoopOptions,
): Promise<ReviewSession> {
  // Defense for callers that invoke runReviewLoop directly. On the normal
  // path, createBeadJobProcessor (run-worker.ts) already rejects a
  // config.review=true + herdr without pane.split combination at
  // construction time, before any bead is dispatched, so this branch is not
  // reachable when running through that processor.
  if (options.herdr.paneSplit === undefined) {
    const outcome = await blockWithImplementationHandoff(
      `gis: reviewer startup failed for ${options.bead.id}: Herdr pane.split is unavailable`,
      options,
    );
    return { outcome };
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
    const outcome = await blockWithImplementationHandoff(
      `gis: reviewer startup failed for ${options.bead.id}: ${errorMessage(error)}`,
      options,
    );
    return { outcome };
  }

  if (reviewer.selection.candidate.kind === options.implementation.kind) {
    options.report(
      `gis: reviewer kind fallback for ${options.bead.id}: implementation and reviewer both use ${options.implementation.kind}; review continues in the fallback kind`,
    );
  }

  return { reviewer };
}

type ReviewVerdict = ReviewResultState | { readonly outcome: 'blocked' };

/**
 * Wait for the reviewer agent to finish its round, then read its verdict.
 *
 * Order: the agent wait always happens before the result read, matching the
 * original inline loop. Any failure along either step (an agent-wait error,
 * an agent-wait 'blocked' status, or an unexpected result-read error) is
 * folded into an `{ outcome: 'blocked' }` so the caller has one shape to
 * check before switching on the verdict kind.
 */
async function awaitReviewVerdict(
  reviewer: StartedReviewer,
  prompt: WorkerPrompt,
  options: ReviewLoopOptions,
): Promise<ReviewVerdict> {
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
    const outcome = await blockWithReviewerHandoff(
      `gis: reviewer wait failed for ${options.bead.id}: ${errorMessage(error)}`,
      reviewer,
      options,
    );
    return { outcome };
  }
  if (reviewerStatus === 'blocked') {
    return { outcome: 'blocked' };
  }

  try {
    return await waitForReviewResult(
      prompt.resultPath,
      prompt.runId,
      options.config.blocked_timeout,
    );
  } catch (error: unknown) {
    const outcome = await blockWithReviewerHandoff(
      `gis: reviewer result read failed for ${options.bead.id}: ${errorMessage(error)}`,
      reviewer,
      options,
    );
    return { outcome };
  }
}

type ReviewFixCycleResult =
  | { readonly kind: 'terminal'; readonly outcome: ReviewLoopOutcome }
  | {
      readonly kind: 'continue';
      readonly round: number;
      readonly prompt: WorkerPrompt;
      readonly lastSlopFeedback: string | undefined;
    };

/**
 * Run one "reviewer requested changes" cycle: decide whether the review
 * round limit has been reached, or else send the feedback back to the
 * implementation agent, re-verify its fix, and prompt the reviewer for the
 * next round.
 *
 * Order: review-limit check, implementation prompt, implementation wait,
 * implementation result, re-verification, reviewer re-prompt — matching the
 * original inline branch exactly. Returns either a terminal
 * `ReviewLoopOutcome` or the state (`round`, `prompt`, `lastSlopFeedback`)
 * the caller's loop should continue with.
 */
async function runReviewFixCycle(
  reviewer: StartedReviewer,
  round: number,
  feedback: string,
  lastSlopFeedback: string | undefined,
  options: ReviewLoopOptions,
): Promise<ReviewFixCycleResult> {
  if (round >= options.config.review_max) {
    const outcome = await requestReviewLimitDecision(
      feedback,
      reviewer,
      options,
    );
    return { kind: 'terminal', outcome };
  }

  options.report(
    `gis: reviewer requested changes for ${options.bead.id}; returning to implementation agent ${options.implementation.agentName}`,
  );
  const implementationPrompt = await promptWorker({
    bead: options.bead,
    worktreePath: options.worktree.path,
    agentName: options.implementation.agentName,
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
    const outcome = await blockWithImplementationHandoff(
      `gis: implementation wait failed for ${options.bead.id}: ${errorMessage(error)}`,
      options,
    );
    return { kind: 'terminal', outcome };
  }
  if (implementationWait.status === 'blocked') {
    return { kind: 'terminal', outcome: 'blocked' };
  }

  const implementationOutcome = await handleImplementationResult(
    implementationPrompt.prompt,
    options,
  );
  if (implementationOutcome !== 'success') {
    return { kind: 'terminal', outcome: implementationOutcome };
  }
  if (
    (await options.verifyImplementation({ kind: 'review', round })) ===
    'blocked'
  ) {
    return { kind: 'terminal', outcome: 'blocked' };
  }

  const nextRound = round + 1;
  try {
    const currentSlop = options.getSlopFeedback?.();
    const slopUpdate =
      currentSlop === lastSlopFeedback ? undefined : currentSlop;
    const prompted = await promptReviewer({
      bead: options.bead,
      runPath: options.worktree.runPath,
      verifyCommand: options.config.verify,
      target: reviewer.agentName,
      round: nextRound,
      implementationKind: options.implementation.kind,
      feedback: [slopUpdate, feedback]
        .filter((value): value is string => value !== undefined)
        .join('\n\n'),
      herdr: options.herdr,
    });
    return {
      kind: 'continue',
      round: nextRound,
      prompt: prompted.prompt,
      lastSlopFeedback: currentSlop,
    };
  } catch (error: unknown) {
    const outcome = await blockWithReviewerHandoff(
      `gis: reviewer prompt failed for ${options.bead.id}: ${errorMessage(error)}`,
      reviewer,
      options,
    );
    return { kind: 'terminal', outcome };
  }
}

/** Run the review state machine after implementation verification succeeds. */
export async function runReviewLoop(
  options: ReviewLoopOptions,
): Promise<ReviewLoopOutcome> {
  const session = await startReviewSession(options);
  if ('outcome' in session) {
    return settleReviewOutcome(options, session.outcome);
  }
  const { reviewer } = session;

  let round = 1;
  let prompt = reviewer.selection.result.prompt;
  let lastSlopFeedback = options.getSlopFeedback?.();

  while (true) {
    const verdict = await awaitReviewVerdict(reviewer, prompt, options);
    if ('outcome' in verdict) {
      return settleReviewOutcome(options, verdict.outcome);
    }

    switch (verdict.kind) {
      case 'success':
        return 'approved';

      case 'needs_human':
        return settleReviewOutcome(
          options,
          await requestHuman(
            verdict.reason,
            await reviewerHandoff(reviewer, options),
            options,
          ),
        );

      case 'failure':
      case 'invalid_schema':
      case 'invalid_json':
      case 'stale':
      case 'missing':
        return settleReviewOutcome(
          options,
          await blockReviewProblem(verdict, reviewer, options),
        );

      case 'changes_requested': {
        const feedback = requestedChangesFeedback(verdict);
        const cycle = await runReviewFixCycle(
          reviewer,
          round,
          feedback,
          lastSlopFeedback,
          options,
        );
        if (cycle.kind === 'terminal') {
          return settleReviewOutcome(options, cycle.outcome);
        }
        round = cycle.round;
        prompt = cycle.prompt;
        lastSlopFeedback = cycle.lastSlopFeedback;
        break;
      }

      default:
        return assertNever(verdict);
    }
  }
}
