import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

export type TranscriptKind = "claude" | "codex";

export interface TranscriptResolverOptions {
  /** Override the home directory when resolving the standard tool paths. */
  readonly homeDir?: string;
  /** Override `~/.claude/projects`. */
  readonly claudeProjectsDir?: string;
  /** Override `~/.codex/sessions`. */
  readonly codexSessionsDir?: string;
  /** Number of JSONL records to inspect for Codex session metadata. */
  readonly maxCodexMetadataLines?: number;
}

export interface TranscriptIndex {
  /** Absolute worktree cwd used for the lookup. */
  readonly cwd: string;
  /** The newest Claude transcript for this cwd, when one exists. */
  readonly claude: string | undefined;
  /** The newest Codex transcript whose session metadata has this cwd. */
  readonly codex: string | undefined;
}

export interface BeadTranscriptIndex {
  readonly beadId: string;
  readonly worktreePath: string;
  readonly kind: TranscriptKind;
  readonly transcriptPath: string;
}

const DEFAULT_METADATA_LINES = 8;

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function absoluteCwd(cwd: string): string {
  requireNonEmpty(cwd, "cwd");
  return resolve(cwd);
}

function absoluteDirectory(value: string, name: string): string {
  requireNonEmpty(value, name);
  return resolve(value);
}

function homeDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(options.homeDir ?? homedir(), "homeDir");
}

function claudeProjectsDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(
    options.claudeProjectsDir ?? join(homeDirectory(options), ".claude", "projects"),
    "claudeProjectsDir",
  );
}

function codexSessionsDirectory(options: TranscriptResolverOptions): string {
  return absoluteDirectory(
    options.codexSessionsDir ?? join(homeDirectory(options), ".codex", "sessions"),
    "codexSessionsDir",
  );
}

function metadataLineLimit(options: TranscriptResolverOptions): number {
  const value = options.maxCodexMetadataLines ?? DEFAULT_METADATA_LINES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxCodexMetadataLines must be a positive integer");
  }
  return value;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

/**
 * Claude Code replaces path separators with `-` for its project directory.
 * Resolve first so callers can pass the relative cwd used by a worktree.
 */
export function claudeProjectSlug(cwd: string): string {
  return absoluteCwd(cwd).replace(/[\\/]/g, "-");
}

export function claudeProjectDirectory(
  cwd: string,
  options: TranscriptResolverOptions = {},
): string {
  return join(claudeProjectsDirectory(options), claudeProjectSlug(cwd));
}

async function jsonlFiles(directory: string, recursive: boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && extname(entry.name) === ".jsonl") {
      files.push(path);
    } else if (recursive && entry.isDirectory()) {
      files.push(...await jsonlFiles(path, true));
    }
  }
  return files;
}

interface TimestampedPath {
  readonly path: string;
  readonly mtimeMs: number;
}

async function timestampedFiles(paths: readonly string[]): Promise<TimestampedPath[]> {
  const files: TimestampedPath[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) {
        files.push({ path, mtimeMs: info.mtimeMs });
      }
    } catch (error: unknown) {
      // A live runner may rotate or remove a transcript while it is indexed.
      if (!isMissingPath(error)) {
        throw error;
      }
    }
  }
  return files;
}

function newestFirst(files: readonly TimestampedPath[]): string[] {
  return [...files]
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map(({ path }) => path);
}

/** List Claude JSONL transcripts for a cwd, newest first. */
export async function listClaudeTranscripts(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string[]> {
  const directory = claudeProjectDirectory(cwd, options);
  return newestFirst(await timestampedFiles(await jsonlFiles(directory, false)));
}

/** Resolve the newest Claude JSONL transcript for a cwd. */
export async function resolveClaudeTranscript(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  return (await listClaudeTranscripts(cwd, options))[0];
}

function sessionCwdFromRecord(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const cwd = (payload as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

async function readSessionCwd(path: string, maxLines: number): Promise<string | undefined> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineCount = 0;

  try {
    for await (const line of lines) {
      lineCount += 1;
      try {
        const cwd = sessionCwdFromRecord(JSON.parse(line) as unknown);
        if (cwd !== undefined) {
          return cwd;
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

async function matchingCodexFiles(
  cwd: string,
  options: TranscriptResolverOptions,
): Promise<string[]> {
  const expectedCwd = absoluteCwd(cwd);
  const maxLines = metadataLineLimit(options);
  const candidates = await jsonlFiles(codexSessionsDirectory(options), true);
  const matches: string[] = [];

  for (const candidate of candidates) {
    let sessionCwd: string | undefined;
    try {
      sessionCwd = await readSessionCwd(candidate, maxLines);
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw error;
      }
      continue;
    }
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
  return newestFirst(await timestampedFiles(await matchingCodexFiles(cwd, options)));
}

/** Resolve the newest Codex JSONL session for a worktree cwd. */
export async function resolveCodexTranscript(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<string | undefined> {
  return (await listCodexTranscripts(cwd, options))[0];
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
  const isKind = first === "claude" || first === "codex";
  const kind = (isKind ? first : second) as TranscriptKind;
  const cwd = isKind ? second : first;

  if (kind === "claude") {
    return resolveClaudeTranscript(cwd, options);
  }
  if (kind === "codex") {
    return resolveCodexTranscript(cwd, options);
  }
  throw new TypeError(`unsupported transcript kind: ${kind}`);
}

/** Resolve the two official transcript locations without copying or creating logs. */
export async function resolveTranscriptIndex(
  cwd: string,
  options: TranscriptResolverOptions = {},
): Promise<TranscriptIndex> {
  const absolute = absoluteCwd(cwd);
  const [claude, codex] = await Promise.all([
    resolveClaudeTranscript(absolute, options),
    resolveCodexTranscript(absolute, options),
  ]);
  return { cwd: absolute, claude, codex };
}

/** Add the bead/worktree identity to one resolved path for bd notes or other indexes. */
export async function resolveBeadTranscriptIndex(
  beadId: string,
  worktreePath: string,
  kind: TranscriptKind,
  options: TranscriptResolverOptions = {},
): Promise<BeadTranscriptIndex | undefined> {
  requireNonEmpty(beadId, "beadId");
  const transcriptPath = await resolveTranscriptPath(kind, worktreePath, options);
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
