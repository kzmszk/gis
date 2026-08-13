import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import type { Bead, BeadHandoffLocations } from './beads.js';
import { createBeadsAdapter } from './beads.js';
import type { SessionSnapshot, SessionSnapshotResult } from './herdr.js';
import { createHerdrAdapter } from './herdr.js';

const execFileAsync = promisify(execFile);

export interface GitWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isPrunable: boolean;
}

export interface GitAdapterOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitCommandError extends GitError {
  readonly args: readonly string[];
  readonly code: string | number | undefined;
  readonly signal: string | undefined;
  readonly stderr: string;

  constructor(
    args: readonly string[],
    error: ExecFileException & { stderr?: string | Buffer },
  ) {
    const details = error.message || 'git command failed';
    super(`git command failed (${args.join(' ')}): ${details}`);
    this.name = 'GitCommandError';
    this.args = [...args];
    this.code =
      typeof error.code === 'string' || typeof error.code === 'number'
        ? error.code
        : undefined;
    this.signal = typeof error.signal === 'string' ? error.signal : undefined;
    const stderr = (error as { stderr?: unknown }).stderr;
    this.stderr =
      typeof stderr === 'string'
        ? stderr
        : stderr instanceof Buffer
          ? stderr.toString('utf8')
          : '';
  }
}

export class GitProtocolError extends GitError {
  constructor(message: string) {
    super(`invalid git worktree list: ${message}`);
    this.name = 'GitProtocolError';
  }
}

function normalizeOptions(
  options: GitAdapterOptions | string | undefined,
): GitAdapterOptions {
  return typeof options === 'string' ? { command: options } : (options ?? {});
}

function parseWorktreeRecord(record: string, index: number): GitWorktree {
  let path: string | undefined;
  let branch: string | null = null;
  let isBare = false;
  let isDetached = false;
  let isPrunable = false;

  for (const line of record.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref;
    } else if (line === 'bare') {
      isBare = true;
    } else if (line === 'detached') {
      isDetached = true;
    } else if (line.startsWith('prunable')) {
      isPrunable = true;
    }
  }

  if (path === undefined || path.length === 0) {
    throw new GitProtocolError(
      `record ${index} did not contain a worktree path`,
    );
  }

  return { path, branch, isBare, isDetached, isPrunable };
}

export function parseGitWorktreeList(stdout: string): GitWorktree[] {
  const text = stdout.trim();
  if (text.length === 0) {
    return [];
  }

  return text
    .split(/\n\s*\n/)
    .map((record, index) => parseWorktreeRecord(record, index));
}

export class GitAdapter {
  readonly command: string;

  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly maxBufferBytes: number;

  constructor(options?: GitAdapterOptions | string) {
    const normalized = normalizeOptions(options);
    if (
      normalized.timeoutMs !== undefined &&
      (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0)
    ) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    if (
      normalized.maxBufferBytes !== undefined &&
      (!Number.isInteger(normalized.maxBufferBytes) ||
        normalized.maxBufferBytes <= 0)
    ) {
      throw new RangeError('maxBufferBytes must be a positive integer');
    }

    this.command = normalized.command ?? 'git';
    this.cwd = normalized.cwd;
    this.env = normalized.env;
    this.timeoutMs = normalized.timeoutMs;
    this.maxBufferBytes = normalized.maxBufferBytes ?? 1024 * 1024;
  }

  async listWorktrees(): Promise<GitWorktree[]> {
    const args = ['worktree', 'list', '--porcelain'];
    try {
      const result = (await execFileAsync(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        timeout: this.timeoutMs,
        maxBuffer: this.maxBufferBytes,
        encoding: 'utf8',
      })) as { stdout: string };
      return parseGitWorktreeList(result.stdout);
    } catch (error: unknown) {
      if (error instanceof GitProtocolError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new GitCommandError(
          args,
          error as ExecFileException & { stderr?: string | Buffer },
        );
      }
      throw new GitError(
        `git command failed (${args.join(' ')}): ${String(error)}`,
      );
    }
  }
}

export function createGitAdapter(
  options?: GitAdapterOptions | string,
): GitAdapter {
  return new GitAdapter(options);
}

interface BeadsRecoverySource {
  listInProgress(): Promise<readonly Bead[]>;
  update(issueId: string, update: { readonly status: 'open' }): Promise<Bead>;
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
}

interface HerdrRecoverySource {
  apiSnapshot(): Promise<SessionSnapshotResult>;
}

interface GitRecoverySource {
  listWorktrees(): Promise<readonly GitWorktree[]>;
}

export interface OrphanedWorktree {
  readonly path: string;
  readonly branch: string;
}

export interface StartupReconciliationReport {
  readonly reopenedIssueIds: readonly string[];
  readonly blockedIssueIds: readonly string[];
  readonly orphanedWorktrees: readonly OrphanedWorktree[];
}

export interface StartupReconciliationOptions {
  readonly cwd?: string;
  readonly baseBranch?: string;
  readonly beads?: BeadsRecoverySource;
  readonly herdr?: HerdrRecoverySource;
  readonly git?: GitRecoverySource;
  readonly report?: (message: string) => void;
}

function pathFrom(value: unknown, cwd: string): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? resolve(cwd, value)
    : undefined;
}

function liveWorktreePaths(
  snapshot: SessionSnapshot,
  cwd: string,
): Set<string> {
  const paneWorkspaceIds = new Set(
    snapshot.panes.map((pane) => pane.workspace_id),
  );
  const paths = new Set<string>();

  for (const workspace of snapshot.workspaces) {
    if (!paneWorkspaceIds.has(workspace.workspace_id)) {
      continue;
    }
    const checkoutPath = workspace.worktree?.checkout_path;
    const normalized = pathFrom(checkoutPath, cwd);
    if (normalized !== undefined) {
      paths.add(normalized);
    }
  }

  for (const pane of snapshot.panes) {
    for (const candidate of [pane.cwd, pane.foreground_cwd]) {
      const normalized = pathFrom(candidate, cwd);
      if (normalized !== undefined) {
        paths.add(normalized);
      }
    }
  }

  return paths;
}

function normalizeWorktreePath(worktree: GitWorktree, cwd: string): string {
  return resolve(cwd, worktree.path);
}

function isWorkerWorktree(worktree: GitWorktree, baseBranch: string): boolean {
  return (
    !worktree.isBare &&
    !worktree.isDetached &&
    worktree.branch !== null &&
    worktree.branch !== baseBranch
  );
}

interface NormalizedWorktree {
  readonly worktree: GitWorktree;
  readonly path: string;
}

interface InProgressReconciliationContext {
  readonly normalizedWorktrees: readonly NormalizedWorktree[];
  readonly livePaths: ReadonlySet<string>;
  readonly beads: BeadsRecoverySource;
  readonly report: (message: string) => void;
}

/** What `reconcileInProgressBead` observed and did for one in-progress bead. */
type InProgressReconciliationOutcome = 'live' | 'blocked' | 'reopened';

/**
 * Reconcile one in-progress bead against the live Herdr snapshot: leave it
 * alone if its pane is still live, mark it blocked if its worktree survived
 * without a pane, or reopen it if the worktree is gone entirely. The caller
 * aggregates the returned outcome into its own reopened/blocked id lists.
 */
async function reconcileInProgressBead(
  bead: Bead,
  context: InProgressReconciliationContext,
): Promise<InProgressReconciliationOutcome> {
  const hasLivePane = context.normalizedWorktrees.some(
    ({ worktree, path }) =>
      worktree.branch === bead.id && context.livePaths.has(path),
  );
  if (hasLivePane) {
    return 'live';
  }

  const retained = context.normalizedWorktrees.find(
    ({ worktree }) => worktree.branch === bead.id,
  );
  if (retained !== undefined) {
    const runPath = join(retained.path, '.gis', 'run');
    await context.beads.markBlocked(bead.id, {
      worktreePath: retained.path,
      roundLogPath: runPath,
      transcriptPath: join(runPath, 'transcript-recovery.unresolved'),
      failurePhase: 'startup recovery',
      failureDetail: 'worktree exists but no live herdr pane was found',
    });
    context.report(
      `retained worktree ${retained.path} for ${bead.id} has no live pane; marked blocked`,
    );
    return 'blocked';
  }

  await context.beads.update(bead.id, { status: 'open' });
  return 'reopened';
}

interface OrphanDetectionContext {
  readonly baseBranch: string;
  readonly livePaths: ReadonlySet<string>;
  readonly inProgressIds: ReadonlySet<string>;
  readonly report: (message: string) => void;
}

/** Return a live worker worktree that no in-progress bead still claims. */
function collectOrphanedWorktree(
  worktree: GitWorktree,
  path: string,
  context: OrphanDetectionContext,
): OrphanedWorktree | undefined {
  if (
    !isWorkerWorktree(worktree, context.baseBranch) ||
    !context.livePaths.has(path)
  ) {
    return undefined;
  }
  const branch = worktree.branch!;
  if (context.inProgressIds.has(branch)) {
    return undefined;
  }

  context.report(
    `orphaned live pane for worktree ${path} (branch ${branch}); leaving it in place for human review`,
  );
  return { path, branch };
}

export async function reconcileStartup(
  options: StartupReconciliationOptions = {},
): Promise<StartupReconciliationReport> {
  const cwd = options.cwd ?? process.cwd();
  const beads = options.beads ?? createBeadsAdapter({ cwd });
  const herdr = options.herdr ?? createHerdrAdapter();
  const git = options.git ?? createGitAdapter({ cwd });
  const baseBranch = options.baseBranch ?? 'main';
  const report =
    options.report ?? ((message: string) => console.warn(`gis: ${message}`));

  const [snapshotResult, worktrees, inProgress] = await Promise.all([
    herdr.apiSnapshot(),
    git.listWorktrees(),
    beads.listInProgress(),
  ]);
  const livePaths = liveWorktreePaths(snapshotResult.snapshot, cwd);
  const normalizedWorktrees = worktrees.map((worktree) => ({
    worktree,
    path: normalizeWorktreePath(worktree, cwd),
  }));
  const inProgressIds = new Set(inProgress.map((bead) => bead.id));
  const reopenedIssueIds: string[] = [];
  const blockedIssueIds: string[] = [];
  const inProgressContext: InProgressReconciliationContext = {
    normalizedWorktrees,
    livePaths,
    beads,
    report,
  };

  for (const bead of inProgress) {
    const outcome = await reconcileInProgressBead(bead, inProgressContext);
    if (outcome === 'reopened') {
      reopenedIssueIds.push(bead.id);
    } else if (outcome === 'blocked') {
      blockedIssueIds.push(bead.id);
    }
  }

  const orphanedWorktrees: OrphanedWorktree[] = [];
  const orphanContext: OrphanDetectionContext = {
    baseBranch,
    livePaths,
    inProgressIds,
    report,
  };
  for (const { worktree, path } of normalizedWorktrees) {
    const orphan = collectOrphanedWorktree(worktree, path, orphanContext);
    if (orphan !== undefined) {
      orphanedWorktrees.push(orphan);
    }
  }

  return { reopenedIssueIds, blockedIssueIds, orphanedWorktrees };
}

export const reconcileRecovery = reconcileStartup;
