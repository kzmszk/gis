import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bead } from './beads.js';
import type { GisConfig, ProfileCandidate } from './config.js';
import {
  startWithProfileFallback,
  type ProfileStartResult,
} from './profiles.js';
import {
  requireNonEmpty,
  validateResultSchema,
  type SharedResultField,
} from './internal.js';
import { type PaneSplitOptions, type PaneSplitResult } from './herdr.js';
import {
  startWorker,
  promptWorker,
  type StartedWorker,
  type WorkerPrompt,
  type WorkerPromptSource,
  type WorkerStartupSource,
  WorkerStartupError,
  herdrAgentName,
} from './worker.js';

export type ReviewVerdict = 'approved' | 'changes_requested';

export interface ReviewResult {
  readonly status: 'done' | 'failed';
  readonly summary: string;
  readonly verdict: ReviewVerdict;
  readonly feedback?: string;
  readonly needs_human?: string;
  readonly run_id?: string;
  readonly [key: string]: unknown;
}

export type ReviewResultState =
  | { readonly kind: 'success'; readonly result: ReviewResult }
  | { readonly kind: 'changes_requested'; readonly result: ReviewResult }
  | {
      readonly kind: 'needs_human';
      readonly result: ReviewResult;
      readonly reason: string;
    }
  | { readonly kind: 'failure'; readonly result: ReviewResult }
  | { readonly kind: 'missing'; readonly path: string }
  | {
      readonly kind: 'stale';
      readonly path: string;
      readonly expectedRunId: string;
      readonly actualRunId?: string;
    }
  | {
      readonly kind: 'invalid_json';
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: 'invalid_schema';
      readonly path: string;
      readonly issues: readonly string[];
    };

export interface PaneSplitSource {
  paneSplit(options?: PaneSplitOptions): Promise<PaneSplitResult>;
}

export interface ReviewHerdrSource
  extends PaneSplitSource, WorkerStartupSource {}

export interface ReviewerStartOptions {
  readonly bead: Pick<
    Bead,
    'id' | 'description' | 'acceptance_criteria' | 'issue_type' | 'labels'
  >;
  readonly worktreePath: string;
  readonly runPath: string;
  readonly implementationPaneId: string;
  readonly workspaceId: string;
  readonly implementationKind: string;
  readonly implementationCandidate?: ProfileCandidate;
  readonly config: Pick<
    GisConfig,
    | 'profiles'
    | 'kinds'
    | 'claude_permission_mode'
    | 'verify'
    | 'worker_timeout'
  >;
  readonly herdr: ReviewHerdrSource;
  readonly round?: number;
  readonly reviewFeedback?: string;
  readonly paneSplit?: (options: PaneSplitOptions) => Promise<PaneSplitResult>;
}

export interface StartedReviewer {
  readonly paneId: string;
  readonly agentName: string;
  readonly selection: ProfileStartResult<StartedWorker>;
}

function reviewAgentName(beadId: string): string {
  // The suffix is part of the stable identity and herdrAgentName supplies the
  // same bounded, collision-resistant normalization used by implementation
  // panes.
  return herdrAgentName(`${beadId}-review`);
}

export { reviewAgentName };

function paneIdFromSplit(result: PaneSplitResult): string | undefined {
  const candidates: unknown[] = [
    result.pane_id,
    result.pane?.pane_id,
    result.new_pane?.pane_id,
    (result as { created_pane?: { pane_id?: unknown } }).created_pane?.pane_id,
  ];
  return candidates.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/** Split beside the implementation pane using Herdr's pane.split API. */
export async function splitReviewerPane(
  options: ReviewerStartOptions,
): Promise<string> {
  const split = options.paneSplit ?? options.herdr.paneSplit;
  const result = await split.call(options.herdr, {
    targetPaneId: options.implementationPaneId,
    workspaceId: options.workspaceId,
    direction: 'right',
    ratio: 0.5,
    cwd: options.worktreePath,
    focus: false,
  });
  const paneId = paneIdFromSplit(result);
  if (paneId === undefined) {
    throw new Error('herdr pane.split did not return the reviewer pane id');
  }
  return paneId;
}

function orderedCandidates(
  config: Pick<GisConfig, 'profiles' | 'kinds'>,
  implementationKind: string,
  implementationCandidate?: ProfileCandidate,
): ProfileCandidate[] {
  const candidates = config.profiles.review.filter((candidate) =>
    config.kinds.includes(candidate.kind),
  );
  const different = candidates.filter(
    (candidate) => candidate.kind !== implementationKind,
  );
  const same = candidates.filter(
    (candidate) => candidate.kind === implementationKind,
  );
  // A review profile normally includes both configured vendors. If a project
  // only configures the opposite vendor, retaining the implementation
  // candidate still guarantees that review is attempted instead of skipped.
  if (same.length === 0 && implementationCandidate !== undefined) {
    same.push(implementationCandidate);
  }
  return [...different, ...same];
}

/** Start a reviewer in a sibling pane and retain its identity across rounds. */
export async function startReviewer(
  options: ReviewerStartOptions,
): Promise<StartedReviewer> {
  requireNonEmpty(options.implementationKind, 'implementationKind');
  const paneId = await splitReviewerPane(options);
  const agentName = reviewAgentName(options.bead.id);
  const candidates = orderedCandidates(
    options.config,
    options.implementationKind,
    options.implementationCandidate,
  );
  if (candidates.length === 0) {
    throw new Error(
      `no review candidate is configured for bead ${options.bead.id}`,
    );
  }

  const selection = await startWithProfileFallback(
    options.bead,
    options.config,
    async (candidate) =>
      startWorker({
        bead: options.bead,
        agentName,
        paneId,
        runPath: options.runPath,
        verifyCommand: options.config.verify,
        round: options.round ?? 1,
        role: 'review',
        implementationKind: options.implementationKind,
        reviewFeedback: options.reviewFeedback,
        candidate,
        config: options.config,
        herdr: options.herdr,
      }),
    {
      profile: 'review',
      candidateOrder: candidates,
      shouldFallback: (error) =>
        error instanceof WorkerStartupError &&
        (error.phase === 'start' || error.phase === 'readiness'),
    },
  );
  return { paneId, agentName, selection };
}

export interface ReviewerPromptOptions {
  readonly bead: ReviewerStartOptions['bead'];
  readonly runPath: string;
  readonly verifyCommand: string;
  readonly target: string;
  readonly round: number;
  readonly implementationKind: string;
  readonly feedback?: string;
  readonly herdr: WorkerPromptSource;
}

/** Prompt the same reviewer pane for a subsequent review round. */
export async function promptReviewer(
  options: ReviewerPromptOptions,
): Promise<{ readonly prompt: WorkerPrompt }> {
  const prompted = await promptWorker({
    bead: options.bead,
    runPath: options.runPath,
    verifyCommand: options.verifyCommand,
    target: options.target,
    round: options.round,
    role: 'review',
    implementationKind: options.implementationKind,
    reviewFeedback: options.feedback,
    herdr: options.herdr,
  });
  return { prompt: prompted.prompt };
}

function schemaIssues(value: unknown): string[] {
  const validation = validateResultSchema(value, 'review result');
  if (validation.kind === 'not_object') return [validation.issue];
  const { record } = validation;
  const sharedIssues = {
    status: validation.issues.status,
    summary: validation.issues.summary,
    needs_human: validation.issues.needs_human,
  } satisfies Readonly<Record<SharedResultField, string | undefined>>;
  const issues: string[] = [];
  if (typeof record.run_id !== 'string' || record.run_id.trim().length === 0) {
    issues.push('run_id must be a non-empty string');
  }
  if (sharedIssues.status !== undefined) {
    issues.push(sharedIssues.status);
  }
  if (sharedIssues.summary !== undefined) {
    issues.push(sharedIssues.summary);
  }
  if (record.verdict !== 'approved' && record.verdict !== 'changes_requested') {
    issues.push('verdict must be "approved" or "changes_requested"');
  }
  if (
    record.feedback !== undefined &&
    (typeof record.feedback !== 'string' || record.feedback.trim().length === 0)
  ) {
    issues.push('feedback must be a non-empty string when present');
  }
  if (sharedIssues.needs_human !== undefined) {
    issues.push(sharedIssues.needs_human);
  }
  return issues;
}

export function parseReviewResult(
  contents: string,
  path = '<review-result>',
  expectedRunId?: string,
): ReviewResultState {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    return {
      kind: 'invalid_json',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const issues = schemaIssues(value);
  if (issues.length > 0) return { kind: 'invalid_schema', path, issues };
  const result = value as ReviewResult;
  if (expectedRunId !== undefined && result.run_id !== expectedRunId) {
    return {
      kind: 'stale',
      path,
      expectedRunId,
      actualRunId: result.run_id,
    };
  }
  if (result.needs_human !== undefined) {
    return { kind: 'needs_human', result, reason: result.needs_human };
  }
  if (result.status === 'failed') return { kind: 'failure', result };
  return result.verdict === 'approved'
    ? { kind: 'success', result }
    : { kind: 'changes_requested', result };
}

export async function readReviewResult(
  path: string,
  expectedRunId?: string,
): Promise<ReviewResultState> {
  try {
    return parseReviewResult(await readFile(path, 'utf8'), path, expectedRunId);
  } catch (error: unknown) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') return { kind: 'missing', path };
    throw error;
  }
}

export function reviewResultPath(runPath: string, round: number): string {
  if (!Number.isSafeInteger(round) || round <= 0) {
    throw new RangeError('review round must be a positive integer');
  }
  return join(runPath, `round-${round}-review.json`);
}
