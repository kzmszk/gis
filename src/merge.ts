import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import type { Bead, BeadHandoffLocations } from './beads.js';
import { parseDurationMs } from './config.js';
import type { GitAdapterOptions } from './recovery.js';
import { GitCommandError } from './recovery.js';
import {
  runVerifyCommand,
  type VerifyCommandResult,
  type VerifyCommandRunner,
} from './verify.js';
import type { BeadWorktree } from './worktree.js';

const execFileAsync = promisify(execFile);

export interface MergeGitSource {
  /** Rebase the bead branch in its own worktree onto the configured base. */
  rebase(worktreePath: string, baseBranch: string): Promise<void>;
  /** Return true only when the bead branch contains a commit ahead of base. */
  hasCommits(worktreePath: string, baseBranch: string): Promise<boolean>;
  /** List paths changed by bead commits relative to base. */
  changedPaths?(
    worktreePath: string,
    baseBranch: string,
  ): Promise<readonly string[]>;
  /** Fast-forward the checked-out base worktree with the rebased bead branch. */
  merge(repositoryPath: string, branch: string): Promise<void>;
  /** Remove the integrated bead branch after its worktree has been removed. */
  deleteBranch(repositoryPath: string, branch: string): Promise<void>;
}

export interface MergeBeadsSource {
  markMerged(issueId: string, reason?: string): Promise<Bead>;
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
}

export interface MergeQueueItem {
  readonly bead: Pick<Bead, 'id'>;
  readonly worktree: Pick<BeadWorktree, 'path' | 'runPath' | 'remove'>;
  /** The runner transcript path used in the blocked-bead handoff. */
  readonly transcriptPath: string;
}

export interface MergeQueueOptions {
  /** Repository worktree with the base branch checked out. */
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly verifyCommand: string;
  readonly verifyTimeout: string;
  readonly beads: MergeBeadsSource;
  readonly git?: MergeGitSource;
  readonly runVerify?: VerifyCommandRunner;
}

export type MergeFailurePhase = 'rebase' | 'commit' | 'verify' | 'merge';

export interface MergeBlockedResult {
  readonly status: 'blocked';
  readonly phase: MergeFailurePhase;
  readonly bead: Bead;
  readonly handoff: BeadHandoffLocations;
  readonly verification?: VerifyCommandResult;
  readonly error?: unknown;
}

export interface MergeMergedResult {
  readonly status: 'merged';
  readonly bead: Pick<Bead, 'id'>;
  /** Main contains the commit, but closing the Beads issue failed. */
  readonly stateError?: unknown;
  /** Main and bd are committed, but cleanup needs human/retry attention. */
  readonly cleanupError?: unknown;
}

export type MergeResult = MergeMergedResult | MergeBlockedResult;

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function verifyFailure(result: VerifyCommandResult): string {
  const output = [result.stdout?.trim(), result.stderr?.trim()]
    .filter((part): part is string => Boolean(part))
    .join('\n');
  const status =
    result.exitCode === undefined
      ? result.signal === undefined
        ? 'unknown status'
        : `signal ${result.signal}`
      : `exit code ${result.exitCode}`;
  return [
    `verification failed (${status})`,
    output || '(the command produced no output)',
  ].join('\n');
}

function handoffFor(item: MergeQueueItem): BeadHandoffLocations {
  return {
    worktreePath: item.worktree.path,
    roundLogPath: item.worktree.runPath,
    transcriptPath: item.transcriptPath,
  };
}

function defaultGit(): MergeGitSource {
  return new GitMergeAdapter();
}

/**
 * Execute git's rebase and fast-forward merge operations without a shell.
 *
 * The repository path is expected to be the checked-out base worktree. The
 * bead worktree is rebased first, so `--ff-only` makes an accidental merge
 * commit impossible at the queue boundary.
 */
export class GitMergeAdapter implements MergeGitSource {
  readonly command: string;

  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly maxBufferBytes: number;

  constructor(options: GitAdapterOptions = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    if (
      options.maxBufferBytes !== undefined &&
      (!Number.isInteger(options.maxBufferBytes) || options.maxBufferBytes <= 0)
    ) {
      throw new RangeError('maxBufferBytes must be a positive integer');
    }

    this.command = options.command ?? 'git';
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs;
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
  }

  rebase(worktreePath: string, baseBranch: string): Promise<void> {
    requireNonEmpty(worktreePath, 'worktreePath');
    requireNonEmpty(baseBranch, 'baseBranch');
    return this.run(['-C', worktreePath, 'rebase', baseBranch]).then(
      () => undefined,
    );
  }

  async hasCommits(worktreePath: string, baseBranch: string): Promise<boolean> {
    requireNonEmpty(worktreePath, 'worktreePath');
    requireNonEmpty(baseBranch, 'baseBranch');
    const stdout = await this.run([
      '-C',
      worktreePath,
      'rev-list',
      '--count',
      `${baseBranch}..HEAD`,
    ]);
    const count = Number(stdout.trim());
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `git rev-list returned an invalid count: ${stdout.trim()}`,
      );
    }
    return count > 0;
  }

  async changedPaths(
    worktreePath: string,
    baseBranch: string,
  ): Promise<readonly string[]> {
    const stdout = await this.run([
      '-C',
      worktreePath,
      'diff',
      '--name-only',
      `${baseBranch}..HEAD`,
    ]);
    return stdout
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean);
  }

  merge(repositoryPath: string, branch: string): Promise<void> {
    requireNonEmpty(repositoryPath, 'repositoryPath');
    requireNonEmpty(branch, 'branch');
    return this.run(['-C', repositoryPath, 'merge', '--ff-only', branch]).then(
      () => undefined,
    );
  }

  deleteBranch(repositoryPath: string, branch: string): Promise<void> {
    requireNonEmpty(repositoryPath, 'repositoryPath');
    requireNonEmpty(branch, 'branch');
    return this.run(['-C', repositoryPath, 'branch', '-d', branch]).then(
      () => undefined,
    );
  }

  private async run(args: readonly string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.command, [...args], {
        cwd: this.cwd,
        env: this.env,
        timeout: this.timeoutMs,
        maxBuffer: this.maxBufferBytes,
        encoding: 'utf8',
      });
      return result.stdout;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new GitCommandError(
          args,
          error as ExecFileException & { stderr?: string | Buffer },
        );
      }
      throw new Error(
        `git command failed (${args.join(' ')}): ${String(error)}`,
      );
    }
  }
}

/**
 * A single serial merge queue. The queue keeps its chain alive after a
 * blocked item so a later item can still be processed in the same run.
 */
export class SerialMergeQueue {
  private readonly options: MergeQueueOptions;
  private readonly git: MergeGitSource;
  private readonly runVerify: VerifyCommandRunner;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MergeQueueOptions) {
    requireNonEmpty(options.repositoryPath, 'repositoryPath');
    requireNonEmpty(options.baseBranch, 'baseBranch');
    requireNonEmpty(options.verifyCommand, 'verifyCommand');
    requireNonEmpty(options.verifyTimeout, 'verifyTimeout');
    this.options = options;
    this.git = options.git ?? defaultGit();
    this.runVerify = options.runVerify ?? runVerifyCommand;
  }

  /** Enqueue one item; its full merge lifecycle is mutually exclusive. */
  enqueue(item: MergeQueueItem): Promise<MergeResult> {
    const operation = this.tail.then(() => this.process(item));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Enqueue a batch in input order and wait for every item. */
  async run(items: readonly MergeQueueItem[]): Promise<readonly MergeResult[]> {
    const results: MergeResult[] = [];
    for (const item of items) {
      results.push(await this.enqueue(item));
    }
    return results;
  }

  /** Rebase the bead worktree onto base, or block on the first failure. */
  private async rebaseOrBlock(
    item: MergeQueueItem,
    handoff: BeadHandoffLocations,
  ): Promise<MergeBlockedResult | undefined> {
    try {
      await this.git.rebase(item.worktree.path, this.options.baseBranch);
      return undefined;
    } catch (error: unknown) {
      return this.blocked(item, handoff, 'rebase', error);
    }
  }

  /** Require a real commit ahead of base, and reject GIS runtime artifacts. */
  private async guardCommitOrBlock(
    item: MergeQueueItem,
    handoff: BeadHandoffLocations,
  ): Promise<MergeBlockedResult | undefined> {
    try {
      if (
        !(await this.git.hasCommits(
          item.worktree.path,
          this.options.baseBranch,
        ))
      ) {
        return this.blocked(
          item,
          handoff,
          'commit',
          new Error('bead branch has no commit ahead of base'),
        );
      }
      const changedPaths = await this.git.changedPaths?.(
        item.worktree.path,
        this.options.baseBranch,
      );
      const runtimeArtifacts = changedPaths?.filter((path) =>
        path.startsWith('.gis/run/'),
      );
      if (runtimeArtifacts !== undefined && runtimeArtifacts.length > 0) {
        return this.blocked(
          item,
          handoff,
          'commit',
          new Error(
            `bead commits contain GIS runtime artifacts: ${runtimeArtifacts.join(', ')}`,
          ),
        );
      }
      return undefined;
    } catch (error: unknown) {
      return this.blocked(item, handoff, 'commit', error);
    }
  }

  /** Run verification, blocking on a runner failure or a failed result. */
  private async runVerificationOrBlock(
    item: MergeQueueItem,
    handoff: BeadHandoffLocations,
  ): Promise<
    | { readonly blocked: MergeBlockedResult }
    | { readonly verification: VerifyCommandResult }
  > {
    let verification: VerifyCommandResult;
    try {
      verification = await this.runVerify(
        this.options.verifyCommand,
        item.worktree.path,
        parseDurationMs(this.options.verifyTimeout, 'verify_timeout'),
      );
    } catch (error: unknown) {
      return { blocked: await this.blocked(item, handoff, 'verify', error) };
    }
    if (!verification.passed) {
      return {
        blocked: await this.blocked(
          item,
          handoff,
          'verify',
          new Error(verifyFailure(verification)),
          verification,
        ),
      };
    }
    return { verification };
  }

  /** Fast-forward merge the bead branch into the base worktree, or block. */
  private async mergeOrBlock(
    item: MergeQueueItem,
    handoff: BeadHandoffLocations,
    verification: VerifyCommandResult,
  ): Promise<MergeBlockedResult | undefined> {
    try {
      await this.git.merge(this.options.repositoryPath, item.bead.id);
      return undefined;
    } catch (error: unknown) {
      return this.blocked(item, handoff, 'merge', error, verification);
    }
  }

  private async process(item: MergeQueueItem): Promise<MergeResult> {
    requireNonEmpty(item.bead.id, 'bead.id');
    requireNonEmpty(item.worktree.path, 'worktree.path');
    requireNonEmpty(item.worktree.runPath, 'worktree.runPath');
    requireNonEmpty(item.transcriptPath, 'transcriptPath');

    const handoff = handoffFor(item);

    const rebaseBlocked = await this.rebaseOrBlock(item, handoff);
    if (rebaseBlocked !== undefined) return rebaseBlocked;

    const commitBlocked = await this.guardCommitOrBlock(item, handoff);
    if (commitBlocked !== undefined) return commitBlocked;

    const verificationOrBlock = await this.runVerificationOrBlock(
      item,
      handoff,
    );
    if ('blocked' in verificationOrBlock) return verificationOrBlock.blocked;
    const { verification } = verificationOrBlock;

    const mergeBlocked = await this.mergeOrBlock(item, handoff, verification);
    if (mergeBlocked !== undefined) return mergeBlocked;

    // These are intentionally after merge and never occur on a pre-merge
    // failure. Worktree removal is the final side effect of a successful bead.
    let bead: Pick<Bead, 'id'>;
    try {
      bead = await this.options.beads.markMerged(
        item.bead.id,
        'merged after rebase and verify',
      );
    } catch (stateError: unknown) {
      // Git integration already succeeded. Retain the worktree and report the
      // Beads write failure without ever moving the issue back to blocked.
      return { status: 'merged', bead: item.bead, stateError };
    }

    const cleanup = async (): Promise<void> => {
      await item.worktree.remove();
      await this.git.deleteBranch(this.options.repositoryPath, item.bead.id);
    };
    try {
      await cleanup();
      return { status: 'merged', bead };
    } catch (firstError: unknown) {
      // A cleanup call can fail after git and bd have already committed the
      // bead. Retrying is safe because worktree removal is idempotent; most
      // importantly, never turn an already-closed bead back into blocked.
      try {
        await cleanup();
        return { status: 'merged', bead };
      } catch (secondError: unknown) {
        return {
          status: 'merged',
          bead,
          cleanupError: secondError ?? firstError,
        };
      }
    }
  }

  private blocked(
    item: MergeQueueItem,
    handoff: BeadHandoffLocations,
    phase: MergeFailurePhase,
    error: unknown,
    verification?: VerifyCommandResult,
  ): Promise<MergeBlockedResult> {
    const detailedHandoff = {
      ...handoff,
      failurePhase: phase,
      failureDetail: error instanceof Error ? error.message : String(error),
    };
    return this.options.beads
      .markBlocked(item.bead.id, detailedHandoff)
      .then((bead) => ({
        status: 'blocked',
        phase,
        bead,
        handoff: detailedHandoff,
        verification,
        error,
      }));
  }
}

/** Run merge candidates in their supplied order through one serial queue. */
export async function runMergeQueue(
  items: readonly MergeQueueItem[],
  options: MergeQueueOptions,
): Promise<readonly MergeResult[]> {
  return new SerialMergeQueue(options).run(items);
}

export const mergeQueue = runMergeQueue;
