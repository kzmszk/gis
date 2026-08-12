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
import { readWorkerResult } from './result.js';
import type { VerifyCommandRunner } from './verify.js';

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
}

function isLateCommitCandidate(bead: Bead): boolean {
  const notes = typeof bead.notes === 'string' ? bead.notes : '';
  return (
    bead.status === 'blocked' &&
    notes.includes('failure phase: commit') &&
    notes.includes('no commit ahead of base')
  );
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

async function currentResult(worktreePath: string) {
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
  return result.kind === 'success' ? result : undefined;
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
  let merged = 0;

  for (const bead of blocked.filter(isLateCommitCandidate)) {
    const retained = worktrees.find(
      (worktree: GitWorktree) => worktree.branch === bead.id,
    );
    if (retained === undefined) continue;
    const worktreePath = resolve(options.cwd, retained.path);
    const workspaceId = workspaceIdFor(snapshotResult.snapshot, worktreePath);
    if (workspaceId === undefined) continue;
    try {
      if (!(await mergeGit.hasCommits(worktreePath, options.config.base))) {
        continue;
      }
      if ((await currentResult(worktreePath)) === undefined) continue;
      report(`gis: resuming late completion for ${bead.id}`);
      const result = await queue.enqueue({
        bead,
        worktree: {
          path: worktreePath,
          runPath: resolve(worktreePath, '.gis', 'run'),
          remove: () => herdr.worktreeRemove(workspaceId, { force: true }),
        },
        transcriptPath:
          typeof bead.notes === 'string'
            ? (/^transcript: (.+)$/m.exec(bead.notes)?.[1] ??
              resolve(worktreePath, '.gis', 'run', 'transcript.unresolved'))
            : resolve(worktreePath, '.gis', 'run', 'transcript.unresolved'),
      });
      if (result.status === 'merged') merged += 1;
    } catch (error: unknown) {
      report(
        `gis: late completion recovery failed for ${bead.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return merged;
}
