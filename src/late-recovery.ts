import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBeadsAdapter, type Bead } from './beads.js';
import type { GisConfig } from './config.js';
import {
  createHerdrAdapter,
  type SessionSnapshot,
  type SessionSnapshotResult,
  type WorktreeRemoveOptions,
  type WorktreeRemovedResult,
} from './herdr.js';
import {
  GitMergeAdapter,
  SerialMergeQueue,
  type MergeBeadsSource,
  type MergeGitSource,
} from './merge.js';
import { createGitAdapter, type GitWorktree } from './recovery.js';
import { readWorkerResult, type WorkerResult } from './result.js';
import type { VerifyCommandRunner } from './verify.js';
import { herdrAgentName } from './worker.js';
import {
  containedRecoveryPath,
  readRecoveryMetadata,
  type RecoveryMetadata,
} from './recovery-manifest.js';

interface LateRecoveryBeadsSource extends MergeBeadsSource {
  listBlocked(): Promise<readonly Bead[]>;
}

interface LateRecoveryHerdrSource {
  apiSnapshot(): Promise<SessionSnapshotResult>;
  worktreeRemove(
    workspaceId: string,
    options?: WorktreeRemoveOptions,
  ): Promise<WorktreeRemovedResult>;
}

interface LateRecoveryGitSource {
  listWorktrees(): Promise<readonly GitWorktree[]>;
}

export interface LateRecoveryOptions {
  readonly cwd: string;
  readonly config: GisConfig;
  readonly report?: (message: string) => void;
  readonly beads?: LateRecoveryBeadsSource;
  readonly herdr?: LateRecoveryHerdrSource;
  readonly worktreeGit?: LateRecoveryGitSource;
  readonly mergeGit?: MergeGitSource;
  readonly runVerify?: VerifyCommandRunner;
  /** Deterministic seam for validating one metadata snapshot per candidate. */
  readonly readMetadata?: (
    worktreePath: string,
  ) => Promise<RecoveryMetadata | undefined>;
}

function hasLegacyLateCommitNotes(bead: Bead): boolean {
  const notes = typeof bead.notes === 'string' ? bead.notes : '';
  return (
    notes.includes('failure phase: commit') &&
    notes.includes('no commit ahead of base')
  );
}

/**
 * Structured recovery metadata is the primary candidate protocol. Existing
 * blocked beads still use the old notes marker as an explicit compatibility
 * fallback; prompt text is never consulted here.
 */
async function isLateCommitCandidate(
  bead: Bead,
  worktreePath: string | undefined,
  metadata: RecoveryMetadata | undefined,
): Promise<boolean> {
  if (bead.status !== 'blocked') return false;
  if (worktreePath === undefined || metadata === undefined) {
    return hasLegacyLateCommitNotes(bead);
  }
  try {
    validateMetadataForBead(metadata, bead.id);
    return (
      metadata.failureCode === 'commit' ||
      metadata.failureCode === 'ready_to_merge'
    );
  } catch {
    // Invalid metadata is diagnosed by recoverBead and never guessed into a
    // recoverable candidate, but must still reach it for a diagnostic.
    return true;
  }
}

function validateMetadataForBead(
  metadata: RecoveryMetadata,
  beadId: string,
): void {
  if (metadata.beadId !== beadId) {
    throw new Error(
      `recovery metadata beadId ${metadata.beadId} does not match ${beadId}`,
    );
  }
  if (metadata.role !== 'implement') {
    throw new Error('recovery metadata role must be implement');
  }
  if (metadata.agentName !== herdrAgentName(beadId)) {
    throw new Error(
      `recovery metadata agentName ${metadata.agentName} does not match ${herdrAgentName(beadId)}`,
    );
  }
}

function workspaceIdFor(
  snapshot: SessionSnapshot,
  worktreePath: string,
): string | undefined {
  return snapshot.workspaces.find(
    (workspace) =>
      workspace.worktree?.checkout_path !== undefined &&
      resolve(workspace.worktree.checkout_path) === worktreePath,
  )?.workspace_id;
}

async function currentResult(
  worktreePath: string,
  expectedBeadId: string | undefined,
  metadata: RecoveryMetadata | undefined,
) {
  if (metadata !== undefined) {
    if (expectedBeadId !== undefined)
      validateMetadataForBead(metadata, expectedBeadId);
    const resultPath = containedRecoveryPath(worktreePath, metadata.resultPath);
    const result = await readWorkerResult(resultPath, metadata.runId);
    if (result.kind === 'stale') {
      throw new Error(
        `recovery result run ID mismatch for ${result.path}: expected ${result.expectedRunId}`,
      );
    }
    if (result.kind === 'invalid_json' || result.kind === 'invalid_schema') {
      throw new Error(`recovery result is invalid at ${result.path}`);
    }
    if (
      result.kind === 'missing' ||
      result.kind === 'failure' ||
      result.kind === 'needs_human'
    ) {
      throw new Error(
        `recoverable metadata ${metadata.failureCode} has non-success result ${result.kind} at ${result.kind === 'missing' ? result.path : metadata.resultPath}`,
      );
    }
    return result.result;
  }
  const promptPath = resolve(
    worktreePath,
    '.gis',
    'run',
    'implement-prompt.md',
  );
  const prompt = await readFile(promptPath, 'utf8');
  const resultRelative = /write a JSON result to `([^`]+)`/.exec(prompt)?.[1];
  if (resultRelative === undefined) return undefined;
  const resultPath = resolve(worktreePath, resultRelative);
  const runId = /Run ID: `([^`]+)`/.exec(prompt)?.[1];
  if (runId === undefined) {
    const [promptInfo, resultInfo] = await Promise.all([
      stat(promptPath),
      stat(resultPath),
    ]);
    if (resultInfo.mtimeMs < promptInfo.mtimeMs) return undefined;
  }
  const result = await readWorkerResult(resultPath, runId);
  return result.kind === 'success' ? result.result : undefined;
}

/** The transcript recorded on the bead itself, or the default unresolved path. */
function transcriptPathFor(bead: Bead, worktreePath: string): string {
  const fallback = resolve(
    worktreePath,
    '.gis',
    'run',
    'transcript.unresolved',
  );
  if (typeof bead.notes !== 'string') return fallback;
  return /^transcript: (.+)$/m.exec(bead.notes)?.[1] ?? fallback;
}

interface BeadRecoveryContext {
  readonly cwd: string;
  readonly baseBranch: string;
  readonly worktrees: readonly GitWorktree[];
  readonly snapshot: SessionSnapshot;
  readonly mergeGit: MergeGitSource;
  readonly herdr: LateRecoveryHerdrSource;
  readonly queue: SerialMergeQueue;
  readonly report: (message: string) => void;
}

/**
 * Resume one late-committed bead if its worktree is still retained, has a
 * live workspace, and holds a commit and a successful result to enqueue.
 * Any failure along the way is reported and treated as "not recovered" —
 * the bead stays blocked for the next reconciliation pass to retry.
 */
async function recoverBead(
  bead: Bead,
  context: BeadRecoveryContext,
  metadata: RecoveryMetadata | undefined,
): Promise<boolean> {
  const retained = context.worktrees.find(
    (worktree) => worktree.branch === bead.id,
  );
  if (retained === undefined) return false;
  const worktreePath = resolve(context.cwd, retained.path);
  let structuredResult: WorkerResult | undefined;
  try {
    if (metadata !== undefined) {
      validateMetadataForBead(metadata, bead.id);
      // Validate containment and run identity before workspace/commit gates so
      // contradictions are diagnosed and retained rather than silently
      // skipped by an earlier no-workspace/no-commit return.
      structuredResult = await currentResult(worktreePath, bead.id, metadata);
    }
  } catch (error: unknown) {
    context.report(
      `gis: late completion recovery failed for ${bead.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const workspaceId = workspaceIdFor(context.snapshot, worktreePath);
  if (workspaceId === undefined) return false;

  try {
    if (
      !(await context.mergeGit.hasCommits(worktreePath, context.baseBranch))
    ) {
      return false;
    }
    if (
      (metadata === undefined
        ? await currentResult(worktreePath, bead.id, metadata)
        : structuredResult) === undefined
    )
      return false;
    context.report(`gis: resuming late completion for ${bead.id}`);
    const result = await context.queue.enqueue({
      bead,
      worktree: {
        path: worktreePath,
        runPath: resolve(worktreePath, '.gis', 'run'),
        remove: () =>
          context.herdr.worktreeRemove(workspaceId, { force: true }),
      },
      transcriptPath: transcriptPathFor(bead, worktreePath),
    });
    return result.status === 'merged';
  } catch (error: unknown) {
    context.report(
      `gis: late completion recovery failed for ${bead.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Resume a branch that committed after GIS had already classified it blocked. */
export async function recoverLateCompletions(
  options: LateRecoveryOptions,
): Promise<number> {
  const report = options.report ?? ((message: string) => console.warn(message));
  const beads = options.beads ?? createBeadsAdapter({ cwd: options.cwd });
  const herdr = options.herdr ?? createHerdrAdapter();
  const worktreeGit =
    options.worktreeGit ?? createGitAdapter({ cwd: options.cwd });
  const mergeGit = options.mergeGit ?? new GitMergeAdapter();
  const readMetadata = options.readMetadata ?? readRecoveryMetadata;
  const [blocked, snapshotResult, worktrees] = await Promise.all([
    beads.listBlocked(),
    herdr.apiSnapshot(),
    worktreeGit.listWorktrees(),
  ]);
  const queue = new SerialMergeQueue({
    repositoryPath: options.cwd,
    baseBranch: options.config.base,
    verifyCommand: options.config.verify,
    verifyTimeout: options.config.verify_timeout,
    beads,
    git: mergeGit,
    runVerify: options.runVerify,
  });
  const context: BeadRecoveryContext = {
    cwd: options.cwd,
    baseBranch: options.config.base,
    worktrees,
    snapshot: snapshotResult.snapshot,
    mergeGit,
    herdr,
    queue,
    report,
  };

  let merged = 0;
  for (const bead of blocked) {
    const retained = worktrees.find((worktree) => worktree.branch === bead.id);
    const retainedPath =
      retained === undefined ? undefined : resolve(options.cwd, retained.path);
    let metadata: RecoveryMetadata | undefined;
    if (retainedPath !== undefined) {
      try {
        metadata = await readMetadata(retainedPath);
      } catch (error: unknown) {
        report(
          `gis: late completion recovery failed for ${bead.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    if (!(await isLateCommitCandidate(bead, retainedPath, metadata))) continue;
    if (await recoverBead(bead, context, metadata)) merged += 1;
  }
  return merged;
}
