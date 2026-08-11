import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Bead } from './beads.js';
import type { GisConfig } from './config.js';
import {
  createHerdrAdapter,
  type HerdrClient,
  type WorktreeCreatedResult,
  type WorktreeRemoveOptions,
  type WorktreeRemovedResult,
} from './herdr.js';

export interface WorktreeLifecycleSource {
  worktreeCreate(options: {
    readonly branch: string;
    readonly base: string;
    readonly cwd: string;
    readonly path: string;
  }): Promise<WorktreeCreatedResult>;
  worktreeRemove(
    workspaceId: string,
    options?: WorktreeRemoveOptions,
  ): Promise<WorktreeRemovedResult>;
}
export interface BeadWorktree {
  readonly beadId: string;
  readonly path: string;
  readonly runPath: string;
  readonly workspaceId: string;
  readonly paneId: string;
  readonly created: WorktreeCreatedResult;
  /** Remove the worktree and its herdr pane after the bead has succeeded. */
  readonly remove: () => Promise<WorktreeRemovedResult>;
}

export interface CreateBeadWorktreeOptions {
  readonly bead: Pick<Bead, 'id'>;
  readonly config: Pick<GisConfig, 'base'>;
  readonly cwd?: string;
  readonly herdr?: WorktreeLifecycleSource;
}

export type BeadWorktreeOperation<T> = (
  worktree: BeadWorktree,
) => Promise<T> | T;

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function defaultHerdr(): WorktreeLifecycleSource {
  return createHerdrAdapter() as HerdrClient;
}

/**
 * Create the isolated worktree for one bead and prepare its runtime directory.
 *
 * The worktree is deliberately not removed here. Callers must remove it only
 * after the complete bead operation, including its merge, has succeeded.
 */
export async function createBeadWorktree(
  options: CreateBeadWorktreeOptions,
): Promise<BeadWorktree> {
  requireNonEmpty(options.bead.id, 'bead.id');
  requireNonEmpty(options.config.base, 'config.base');

  const herdr = options.herdr ?? defaultHerdr();
  const cwd = resolve(options.cwd ?? process.cwd());
  const requestedPath = resolve(cwd, '.worktrees', options.bead.id);
  const created = await herdr.worktreeCreate({
    branch: options.bead.id,
    base: options.config.base,
    cwd,
    path: requestedPath,
  });
  const path = resolve(cwd, created.worktree.path);
  const runPath = join(path, '.gis', 'run');

  // If preparation fails, the created worktree remains available for
  // inspection and manual recovery; there is intentionally no cleanup here.
  await mkdir(runPath, { recursive: true });

  let removed = false;
  const remove = async (): Promise<WorktreeRemovedResult> => {
    if (removed) {
      return {
        type: 'worktree_removed',
        workspace_id: created.workspace.workspace_id,
        path,
        forced: true,
      };
    }

    const result = await herdr.worktreeRemove(created.workspace.workspace_id, {
      force: true,
    });
    removed = true;
    return result;
  };

  return {
    beadId: options.bead.id,
    path,
    runPath,
    workspaceId: created.workspace.workspace_id,
    paneId: created.root_pane.pane_id,
    created,
    remove,
  };
}

/** Remove a successfully completed bead worktree and its herdr pane. */
export function removeBeadWorktree(
  worktree: BeadWorktree,
): Promise<WorktreeRemovedResult> {
  return worktree.remove();
}

/**
 * Run a complete bead operation in its isolated worktree.
 *
 * A rejected operation never calls herdr worktree.remove, so failed worktrees
 * and panes remain available for diagnosis or human continuation. The
 * operation should include the merge; successful completion is the only path
 * that invokes removal.
 */
export async function withBeadWorktree<T>(
  options: CreateBeadWorktreeOptions,
  operation: BeadWorktreeOperation<T>,
): Promise<T> {
  const worktree = await createBeadWorktree(options);
  const result = await operation(worktree);
  await worktree.remove();
  return result;
}
