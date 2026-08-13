import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const RECOVERY_METADATA_VERSION = 1 as const;
export const RECOVERY_METADATA_FILE = 'recovery.json';

export type RecoveryFailureCode =
  | 'worker_start'
  | 'worker_wait'
  | 'result_missing'
  | 'result_invalid'
  | 'verification'
  | 'commit'
  | 'ready_to_merge'
  | 'review_blocked'
  | 'human_gate'
  | 'unknown';

export interface RecoveryMetadata {
  readonly version: typeof RECOVERY_METADATA_VERSION;
  readonly beadId: string;
  readonly agentName: string;
  readonly runId: string;
  readonly resultPath: string;
  readonly failureCode: RecoveryFailureCode;
  readonly role: 'implement';
  readonly transcriptPath?: string;
}

export function recoveryMetadataPath(worktreePath: string): string {
  return resolve(worktreePath, '.gis', 'run', RECOVERY_METADATA_FILE);
}

/** Resolve a metadata path while refusing traversal outside the worktree. */
export function containedRecoveryPath(
  worktreePath: string,
  candidate: string,
): string {
  const root = resolve(worktreePath);
  const path = resolve(root, candidate);
  const lexicalRel = relative(root, path);
  if (lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
    throw new Error(`recovery metadata path escapes worktree: ${candidate}`);
  }
  const canonicalRoot = canonicalExistingAncestor(root);
  const canonicalPath = canonicalExistingAncestor(path);
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`recovery metadata path escapes worktree: ${candidate}`);
  }
  return path;
}

/** Resolve existing path components so symlink escapes are rejected. For a
 * not-yet-created result, resolve the nearest existing ancestor instead. */
function canonicalExistingAncestor(path: string): string {
  let current = path;
  while (true) {
    try {
      return realpathSync.native(current);
    } catch (error: unknown) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isFailureCode(value: unknown): value is RecoveryFailureCode {
  return (
    value === 'worker_start' ||
    value === 'worker_wait' ||
    value === 'result_missing' ||
    value === 'result_invalid' ||
    value === 'verification' ||
    value === 'commit' ||
    value === 'ready_to_merge' ||
    value === 'review_blocked' ||
    value === 'human_gate' ||
    value === 'unknown'
  );
}

export function parseRecoveryMetadata(value: unknown): RecoveryMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recovery metadata must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== RECOVERY_METADATA_VERSION) {
    throw new Error(
      `unsupported recovery metadata version: ${String(record.version)}`,
    );
  }
  for (const field of ['beadId', 'agentName', 'runId', 'resultPath']) {
    if (
      typeof record[field] !== 'string' ||
      record[field].trim().length === 0
    ) {
      throw new Error(`recovery metadata ${field} must be a non-empty string`);
    }
  }
  if (!isFailureCode(record.failureCode)) {
    throw new Error('recovery metadata failureCode is invalid');
  }
  if (record.role !== 'implement') {
    throw new Error('recovery metadata role must be implement');
  }
  return record as unknown as RecoveryMetadata;
}

export async function readRecoveryMetadata(
  worktreePath: string,
): Promise<RecoveryMetadata | undefined> {
  try {
    const text = await readFile(recoveryMetadataPath(worktreePath), 'utf8');
    return parseRecoveryMetadata(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function writeRecoveryMetadata(
  worktreePath: string,
  metadata: RecoveryMetadata,
): Promise<void> {
  parseRecoveryMetadata(metadata);
  await mkdir(resolve(worktreePath, '.gis', 'run'), { recursive: true });
  await writeFile(
    recoveryMetadataPath(worktreePath),
    `${JSON.stringify(metadata)}\n`,
    'utf8',
  );
}

/** Best-effort lifecycle update used when a worker hands off a blocked stage. */
export async function updateRecoveryFailure(
  worktreePath: string,
  failureCode: RecoveryFailureCode,
): Promise<void> {
  try {
    const metadata = await readRecoveryMetadata(worktreePath);
    if (metadata === undefined || metadata.failureCode === failureCode) return;
    await writeRecoveryMetadata(worktreePath, { ...metadata, failureCode });
  } catch {
    // Legacy worktrees may not have a manifest; Beads handoff remains the
    // authoritative fallback in that case.
  }
}
