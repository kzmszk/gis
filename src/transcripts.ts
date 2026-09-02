import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { AgentSessionInfo } from './herdr.js';
import { requireNonEmpty } from './internal.js';

export type TranscriptKind = 'claude' | 'codex' | 'agy';

export interface TranscriptResolverOptions {
  /** Override the home directory when resolving the standard tool paths. */
  readonly homeDir?: string;
  /** Override `~/.claude/projects`. */
  readonly claudeProjectsDir?: string;
  /** Override `~/.codex/sessions`. */
  readonly codexSessionsDir?: string;
  /** Override `~/.gemini/antigravity-cli/conversations`. */
  readonly agyConversationsDir?: string;
  /** Override `~/.gemini/antigravity-cli/cache/last_conversations.json`. */
  readonly agyLastConversationsPath?: string;
  /** Number of JSONL records to inspect for Codex session metadata. */
  readonly maxCodexMetadataLines?: number;
  /** Ignore transcripts last modified before this worker started. */
  readonly modifiedAfterMs?: number;
}

export interface TranscriptIndex {
  /** Absolute worktree cwd used for the lookup. */
  readonly cwd: string;
  /** The newest Claude transcript for this cwd, when one exists. */
  readonly claude: string | undefined;
  /** The newest Codex transcript whose session metadata has this cwd. */
  readonly codex: string | undefined;
  /** The latest Antigravity conversation database associated with this cwd. */
  readonly agy: string | undefined;
}

export interface BeadTranscriptIndex {
  readonly beadId: string;
  readonly worktreePath: string;
  readonly kind: TranscriptKind;
  readonly transcriptPath: string;
}

const DEFAULT_METADATA_LINES = 8;

function absoluteCwd(cwd: string): string {
  requireNonEmpty(cwd, 'cwd');
  return resolve(cwd);
}

function absoluteDirectory(value: string, name: string): string {
  requireNonEmpty(value, name);
  return resolve(value);
}

function homeDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(options.homeDir ?? homedir(), 'homeDir');
}

function claudeProjectsDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(
    options.claudeProjectsDir ??
      join(homeDirectory(options), '.claude', 'projects'),
    'claudeProjectsDir',
  );
}

function codexSessionsDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(
    options.codexSessionsDir ??
      join(homeDirectory(options), '.codex', 'sessions'),
    'codexSessionsDir',
  );
}

function agyDataDirectory(options: TranscriptResolverOptions): string {
  return join(homeDirectory(options), '.gemini', 'antigravity-cli');
}

function agyConversationsDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(
    options.agyConversationsDir ??
      join(agyDataDirectory(options), 'conversations'),
    'agyConversationsDir',
  );
}

function agyLastConversationsFile(options: TranscriptResolverOptions): string {
  return resolve(
    options.agyLastConversationsPath ??
      join(agyDataDirectory(options), 'cache', 'last_conversations.json'),
  );
}

function metadataLineLimit(options: TranscriptResolverOptions): number {
  const value = options.maxCodexMetadataLines ?? DEFAULT_METADATA_LINES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxCodexMetadataLines must be a positive integer');
  }
  return value;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

/**
 * Run an fs operation, treating a missing path as `fallback` instead of an
 * error. A live runner may rotate or remove a transcript while it is
 * indexed, so callers across this module tolerate that race the same way.
 */
async function withMissingPathFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return fallback;
    }
    throw error;
  }
}

async function existingFile(path: string): Promise<string | undefined> {
  return withMissingPathFallback(
    async () => ((await stat(path)).isFile() ? path : undefined),
    undefined,
  );
}

/**
 * Claude Code replaces path separators with `-` for its project directory.
 * Resolve first so callers can pass the relative cwd used by a worktree.
 */
export function claudeProjectSlug(cwd: string): string {
  return absoluteCwd(cwd).replace(/[\\/]/g, '-');
}

export function claudeProjectDirectory(
  cwd: string,
  options: TranscriptResolverOptions = {},
): string {
  return join(claudeProjectsDirectory(options), claudeProjectSlug(cwd));
}

async function jsonlFiles(
  directory: string,
  recursive: boolean,
): Promise<string[]> {
  const entries = await withMissingPathFallback(
    () => readdir(directory, { withFileTypes: true }),
    [],
  );

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && extname(entry.name) === '.jsonl') {
      files.push(path);
    } else if (recursive && entry.isDirectory()) {
      files.push(...(await jsonlFiles(path, true)));
    }
  }
  return files;
}

interface TimestampedPath {
  readonly path: string;
  readonly mtimeMs: number;
}

async function timestampedFiles(
  paths: readonly string[],
): Promise<TimestampedPath[]> {
  const files: TimestampedPath[] = [];
  for (const path of paths) {
    const info = await withMissingPathFallback(() => stat(path), undefined);
    if (info?.isFile()) {
      files.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  return files;
}

function afterCutoff(
  files: readonly TimestampedPath[],
  options: TranscriptResolverOptions,
): TimestampedPath[] {
  const cutoff = options.modifiedAfterMs;
  if (cutoff === undefined) {
    return [...files];
  }
  if (!Number.isFinite(cutoff) || cutoff < 0) {
    throw new RangeError(
      'modifiedAfterMs must be a non-negative finite number',
    );
  }
  return files.filter(({ mtimeMs }) => mtimeMs >= cutoff);
}

function newestFirst(files: readonly TimestampedPath[]): string[] {
  return [...files]
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
    )
    .map(({ path }) => path);
}

/** List Claude JSONL transcripts for a cwd, newest first. */
export async function listClaudeTranscripts(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string[]> {
  const directory = claudeProjectDirectory(cwd, options);
  return newestFirst(
    afterCutoff(
      await timestampedFiles(await jsonlFiles(directory, false)),
      options,
    ),
  );
}

/** Resolve the newest Claude JSONL transcript for a cwd. */
export async function resolveClaudeTranscript(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  return (await listClaudeTranscripts(cwd, options))[0];
}

/** Narrow a JSONL record value to a plain, non-array object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionCwdFromRecord(value: unknown): string | undefined {
  const payload = asRecord(asRecord(value)?.payload);
  return nonEmptyString(payload?.cwd);
}

interface CodexSessionMetadata {
  readonly id: string | undefined;
  readonly cwd: string | undefined;
}

function codexMetadataFromRecord(
  value: unknown,
): CodexSessionMetadata | undefined {
  const record = asRecord(value);
  if (record === undefined || record.type !== 'session_meta') {
    return undefined;
  }
  const payload = asRecord(record.payload);
  if (payload === undefined) {
    return undefined;
  }
  return {
    id: nonEmptyString(payload.id),
    cwd: nonEmptyString(payload.cwd),
  };
}

/**
 * Read up to `maxLines` JSONL records from `path`, returning the first
 * value `extract` resolves to a defined result for. A malformed line does
 * not make the rest of the session unusable, so it is skipped rather than
 * treated as a failure.
 */
async function firstMatchingRecord<T>(
  path: string,
  maxLines: number,
  extract: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineCount = 0;

  try {
    for await (const line of lines) {
      lineCount += 1;
      try {
        const match = extract(JSON.parse(line) as unknown);
        if (match !== undefined) {
          return match;
        }
      } catch {
        // A malformed record does not make the rest of the session unusable.
      }
      if (lineCount >= maxLines) {
        break;
      }
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

function sessionPath(
  value: string,
  cwd: string,
  options: TranscriptResolverOptions,
): string {
  if (value === '~') {
    return homeDirectory(options);
  }
  if (value.startsWith('~/')) {
    return join(homeDirectory(options), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function filenameHasSessionId(path: string, sessionId: string): boolean {
  const name = basename(path, '.jsonl');
  return name === sessionId || name.endsWith(`-${sessionId}`);
}

async function resolveClaudeSessionId(
  sessionId: string,
  cwd: string,
  options: TranscriptResolverOptions,
): Promise<string | undefined> {
  return existingFile(
    join(claudeProjectDirectory(cwd, options), `${sessionId}.jsonl`),
  );
}

async function resolveCodexSessionId(
  sessionId: string,
  cwd: string,
  options: TranscriptResolverOptions,
): Promise<string | undefined> {
  const expectedCwd = absoluteCwd(cwd);
  const candidates = (
    await jsonlFiles(codexSessionsDirectory(options), true)
  ).filter((path) => filenameHasSessionId(path, sessionId));

  const matches: string[] = [];
  for (const candidate of candidates) {
    const metadata = await withMissingPathFallback(
      () =>
        firstMatchingRecord(
          candidate,
          metadataLineLimit(options),
          codexMetadataFromRecord,
        ),
      undefined,
    );
    if (
      metadata?.id === sessionId &&
      metadata.cwd !== undefined &&
      absoluteCwd(metadata.cwd) === expectedCwd
    ) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function resolveAgySessionId(
  sessionId: string,
  options: TranscriptResolverOptions,
): Promise<string | undefined> {
  return existingFile(
    join(agyConversationsDirectory(options), `${sessionId}.db`),
  );
}

/** Resolve the exact transcript reference reported by herdr for one agent session. */
export async function resolveAgentSessionTranscript(
  session: AgentSessionInfo,
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  requireNonEmpty(session.value, 'session.value');
  if (session.kind === 'path') {
    return existingFile(sessionPath(session.value, cwd, options));
  }
  if (session.kind !== 'id') {
    throw new TypeError(
      `unsupported agent session reference kind: ${String(session.kind)}`,
    );
  }
  if (session.agent === 'claude') {
    return resolveClaudeSessionId(session.value, cwd, options);
  }
  if (session.agent === 'codex') {
    return resolveCodexSessionId(session.value, cwd, options);
  }
  if (session.agent === 'agy') {
    return resolveAgySessionId(session.value, options);
  }
  return undefined;
}

async function matchingCodexFiles(
  cwd: string,
  options: TranscriptResolverOptions,
): Promise<string[]> {
  const expectedCwd = absoluteCwd(cwd);
  const maxLines = metadataLineLimit(options);
  const candidates = newestFirst(
    afterCutoff(
      await timestampedFiles(
        await jsonlFiles(codexSessionsDirectory(options), true),
      ),
      options,
    ),
  );
  const matches: string[] = [];

  for (const candidate of candidates) {
    const sessionCwd = await withMissingPathFallback(
      () => firstMatchingRecord(candidate, maxLines, sessionCwdFromRecord),
      undefined,
    );
    if (sessionCwd !== undefined && absoluteCwd(sessionCwd) === expectedCwd) {
      matches.push(candidate);
    }
  }
  return matches;
}

/** List Codex JSONL sessions whose session metadata cwd equals the worktree cwd. */
export async function listCodexTranscripts(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string[]> {
  return newestFirst(
    await timestampedFiles(await matchingCodexFiles(cwd, options)),
  );
}

/** Resolve the newest Codex JSONL session for a worktree cwd. */
export async function resolveCodexTranscript(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  return (await listCodexTranscripts(cwd, options))[0];
}

async function agyLastConversations(
  options: TranscriptResolverOptions,
): Promise<Record<string, unknown>> {
  const contents = await withMissingPathFallback(
    () => readFile(agyLastConversationsFile(options), 'utf8'),
    undefined,
  );
  if (contents === undefined) {
    return {};
  }
  try {
    return asRecord(JSON.parse(contents) as unknown) ?? {};
  } catch {
    return {};
  }
}

/** Resolve Antigravity's latest conversation database for a cwd. */
export async function resolveAgyTranscript(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  const sessionId = nonEmptyString(
    (await agyLastConversations(options))[absoluteCwd(cwd)],
  );
  return sessionId === undefined
    ? undefined
    : resolveAgySessionId(sessionId, options);
}

/** Resolve one runner's transcript. Both `(kind, cwd)` and `(cwd, kind)` are accepted. */
export async function resolveTranscriptPath(
  kind: TranscriptKind,
  cwd: string,
  options?: TranscriptResolverOptions,
): Promise<string | undefined>;
export async function resolveTranscriptPath(
  cwd: string,
  kind: TranscriptKind,
  options?: TranscriptResolverOptions,
): Promise<string | undefined>;
export async function resolveTranscriptPath(
  first: string,
  second: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  const isKind = first === 'claude' || first === 'codex' || first === 'agy';
  const kind = (isKind ? first : second) as TranscriptKind;
  const cwd = isKind ? second : first;

  if (kind === 'claude') {
    return resolveClaudeTranscript(cwd, options);
  }
  if (kind === 'codex') {
    return resolveCodexTranscript(cwd, options);
  }
  if (kind === 'agy') {
    return resolveAgyTranscript(cwd, options);
  }
  throw new TypeError(`unsupported transcript kind: ${kind}`);
}

/** Resolve official transcript locations without copying or creating logs. */
export async function resolveTranscriptIndex(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<TranscriptIndex> {
  const absolute = absoluteCwd(cwd);
  const [claude, codex, agy] = await Promise.all([
    resolveClaudeTranscript(absolute, options),
    resolveCodexTranscript(absolute, options),
    resolveAgyTranscript(absolute, options),
  ]);
  return { cwd: absolute, claude, codex, agy };
}

/** Add the bead/worktree identity to one resolved path for bd notes or other indexes. */
export async function resolveBeadTranscriptIndex(
  beadId: string,
  worktreePath: string,
  kind: TranscriptKind,
  options: TranscriptResolverOptions = {},
): Promise<BeadTranscriptIndex | undefined> {
  requireNonEmpty(beadId, 'beadId');
  const transcriptPath = await resolveTranscriptPath(
    kind,
    worktreePath,
    options,
  );
  if (transcriptPath === undefined) {
    return undefined;
  }
  return {
    beadId,
    worktreePath: absoluteCwd(worktreePath),
    kind,
    transcriptPath,
  };
}
