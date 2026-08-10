import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BeadStatus = "open" | "in_progress" | "blocked" | "closed";

export interface BeadDependency {
  readonly id?: string;
  readonly issue_id?: string;
  readonly depends_on_id?: string;
  readonly type?: string;
  readonly dependency_type?: string;
  readonly [key: string]: unknown;
}

export interface Bead {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: BeadStatus;
  readonly priority: number;
  readonly issue_type: string;
  readonly acceptance_criteria?: string;
  readonly assignee?: string;
  readonly labels?: readonly string[];
  readonly dependencies?: readonly BeadDependency[];
  readonly [key: string]: unknown;
}

export interface BeadsAdapterOptions {
  /** Path to the bd executable. Defaults to bd on PATH. */
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

/** Locations a human needs to resume an escalated bead. */
export interface BeadHandoffLocations {
  readonly worktreePath: string;
  readonly roundLogPath: string;
  readonly transcriptPath: string;
}

/** The context gis records on a gate created from a worker escalation. */
export interface HumanGateRequest {
  readonly issueId: string;
  readonly reason: string;
  readonly locations?: BeadHandoffLocations;
}

function normalizeOptions(
  options: BeadsAdapterOptions | string | undefined,
): BeadsAdapterOptions {
  return typeof options === "string" ? { command: options } : (options ?? {});
}

export type BeadUpdate =
  | {
      readonly status: "open";
    }
  | {
      readonly status: "in_progress";
      readonly assignee: string;
    }
  | {
      readonly status: "blocked";
      readonly notes: string;
    };

export type BeadTransition = BeadUpdate | {
  readonly status: "closed";
  readonly reason?: string;
};

export class BeadsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeadsError";
  }
}

export class BeadsCommandError extends BeadsError {
  readonly args: readonly string[];
  readonly code: string | number | undefined;
  readonly signal: string | undefined;
  readonly stderr: string;

  constructor(
    args: readonly string[],
    error: ExecFileException & { stderr?: string | Buffer },
  ) {
    const details = error.message || "bd command failed";
    super(`bd command failed (${args.join(" ")}): ${details}`);
    this.name = "BeadsCommandError";
    this.args = [...args];
    this.code = typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : undefined;
    this.signal = typeof error.signal === "string" ? error.signal : undefined;
    this.stderr = toText(error.stderr);
  }
}

export class BeadsProtocolError extends BeadsError {
  constructor(message: string) {
    super(`invalid bd JSON response: ${message}`);
    this.name = "BeadsProtocolError";
  }
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : value instanceof Buffer ? value.toString("utf8") : "";
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

/**
 * Keep the blocked-bead handoff contract readable in `bd show` output.
 *
 * The labels are deliberately stable: they are the only index a human needs
 * after gis leaves a worktree in place for escalation.
 */
export function formatBlockedNotes(locations: BeadHandoffLocations): string {
  requireNonEmpty(locations.worktreePath, "worktreePath");
  requireNonEmpty(locations.roundLogPath, "roundLogPath");
  requireNonEmpty(locations.transcriptPath, "transcriptPath");

  return [
    `worktree: ${locations.worktreePath}`,
    `rounds: ${locations.roundLogPath}`,
    `transcript: ${locations.transcriptPath}`,
  ].join("\n");
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BeadsProtocolError(`${context} was not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string") {
    throw new BeadsProtocolError(`${context}.${field} was not a string`);
  }
  return value;
}

function asStatus(value: unknown, context: string): BeadStatus {
  if (value === "open" || value === "in_progress" || value === "blocked" || value === "closed") {
    return value;
  }
  throw new BeadsProtocolError(`${context}.status was not a supported bead status`);
}

function asBead(value: unknown, context: string): Bead {
  const record = asRecord(value, context);
  const priority = record.priority;
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    throw new BeadsProtocolError(`${context}.priority was not a finite number`);
  }

  return {
    ...record,
    id: asString(record.id, "id", context),
    title: asString(record.title, "title", context),
    description: asString(record.description, "description", context),
    status: asStatus(record.status, context),
    priority,
    issue_type: asString(record.issue_type, "issue_type", context),
  };
}

function parseJson(stdout: string, operation: string): unknown {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new BeadsProtocolError(`${operation} returned no JSON`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BeadsProtocolError(
      `${operation} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseBeadList(stdout: string, operation: string): Bead[] {
  const value = parseJson(stdout, operation);
  if (!Array.isArray(value)) {
    throw new BeadsProtocolError(`${operation} response was not an array`);
  }
  return value.map((item, index) => asBead(item, `${operation}[${index}]`));
}

function parseDependencyList(stdout: string, operation: string): BeadDependency[] {
  const value = parseJson(stdout, operation);
  if (!Array.isArray(value)) {
    throw new BeadsProtocolError(`${operation} response was not an array`);
  }

  return value.map((item, index) => {
    const record = asRecord(item, `${operation}[${index}]`);
    for (const field of ["id", "issue_id", "depends_on_id", "type", "dependency_type"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new BeadsProtocolError(`${operation}[${index}].${field} was not a string`);
      }
    }
    return record as BeadDependency;
  });
}

function parseSingleBead(stdout: string, operation: string): Bead {
  const value = parseJson(stdout, operation);
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BeadsProtocolError(`${operation} response contained ${value.length} issues, expected one`);
    }
    return asBead(value[0], `${operation}[0]`);
  }
  return asBead(value, operation);
}

export class BeadsAdapter {
  readonly command: string;

  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly maxBufferBytes: number;

  constructor(options?: BeadsAdapterOptions | string) {
    const normalized = normalizeOptions(options);
    if (normalized.timeoutMs !== undefined &&
        (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }
    if (normalized.maxBufferBytes !== undefined &&
        (!Number.isInteger(normalized.maxBufferBytes) || normalized.maxBufferBytes <= 0)) {
      throw new RangeError("maxBufferBytes must be a positive integer");
    }

    this.command = normalized.command ?? "bd";
    this.cwd = normalized.cwd;
    this.env = normalized.env;
    this.timeoutMs = normalized.timeoutMs;
    this.maxBufferBytes = normalized.maxBufferBytes ?? 1024 * 1024;
  }

  ready(): Promise<Bead[]> {
    return this.runJson(["ready", "--exclude-label", "human", "--json"])
      .then((stdout) => parseBeadList(stdout, "bd ready"));
  }

  listInProgress(): Promise<Bead[]> {
    return this.runJson(["list", "--status=in_progress", "--json"])
      .then((stdout) => parseBeadList(stdout, "bd list --status=in_progress"));
  }

  /** List open human-gated issues for the run completion summary. */
  listHuman(): Promise<Bead[]> {
    return this.runJson(["list", "--label=human", "--status=open", "--json"])
      .then((stdout) => parseBeadList(stdout, "bd list --label=human --status=open"));
  }

  /** List issues that are blocked by this issue. */
  listDependents(issueId: string): Promise<readonly BeadDependency[]> {
    requireNonEmpty(issueId, "issueId");
    return this.runJson(["dep", "list", issueId, "--direction=up", "--json"])
      .then((stdout) => parseDependencyList(stdout, "bd dep list --direction=up"));
  }

  inProgress(): Promise<Bead[]> {
    return this.listInProgress();
  }

  show(issueId: string): Promise<Bead> {
    requireNonEmpty(issueId, "issueId");
    return this.runJson(["show", issueId, "--json"])
      .then((stdout) => parseSingleBead(stdout, "bd show"));
  }

  update(issueId: string, update: BeadUpdate): Promise<Bead> {
    requireNonEmpty(issueId, "issueId");
    const args = ["update", issueId, `--status=${update.status}`];
    if (update.status === "in_progress") {
      requireNonEmpty(update.assignee, "assignee");
      args.push(`--assignee=${update.assignee}`);
    } else if (update.status === "blocked") {
      requireNonEmpty(update.notes, "notes");
      args.push(`--notes=${update.notes}`);
    }
    args.push("--json");
    return this.runJson(args).then((stdout) => parseSingleBead(stdout, "bd update"));
  }

  claim(issueId: string): Promise<Bead> {
    requireNonEmpty(issueId, "issueId");
    return this.runJson(["update", issueId, "--claim", "--json"])
      .then((stdout) => parseSingleBead(stdout, "bd update --claim"));
  }

  /** Persist the dispatch decision, including the selected worker kind. */
  dispatch(issueId: string, kind: string): Promise<Bead> {
    requireNonEmpty(kind, "kind");
    return this.update(issueId, { status: "in_progress", assignee: kind });
  }

  /** Persist a successful merge as the terminal closed state. */
  markMerged(issueId: string, reason?: string): Promise<Bead> {
    return this.close(issueId, reason);
  }

  /** Persist an escalation and the complete human handoff index. */
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead> {
    return this.update(issueId, {
      status: "blocked",
      notes: formatBlockedNotes(locations),
    });
  }

  /**
   * Create a human-labelled checkpoint and replace the source's blocking edges.
   *
   * A source that requests human input is already marked `blocked`. Making the
   * gate depend on that source would make the gate impossible to close without
   * `bd close --force`, so `bd human respond` could not release the graph. The
   * gate is therefore independent and becomes the replacement blocker for each
   * existing `blocks` dependent of the source. The source remains blocked and
   * its worktree remains available for the human handoff.
   */
  async createHumanGate(request: HumanGateRequest): Promise<Bead> {
    requireNonEmpty(request.issueId, "issueId");
    requireNonEmpty(request.reason, "reason");

    const dependents = await this.listDependents(request.issueId);
    const blockingDependentIds = [...new Set(
      dependents
        .filter((dependency) =>
          (dependency.dependency_type ?? dependency.type ?? "blocks") === "blocks")
        .map((dependency) => dependency.issue_id ?? dependency.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )].filter((id) => id !== request.issueId);

    const description = [
      `Human confirmation is required for ${request.issueId}.`,
      "",
      `Reason: ${request.reason}`,
      ...(request.locations === undefined
        ? []
        : ["", formatBlockedNotes(request.locations)]),
    ].join("\n");
    const gate = await this.runJson([
      "create",
      "--title",
      `Human confirmation required for ${request.issueId}`,
      "--description",
      description,
      "--labels",
      "human",
      "--json",
    ]).then((stdout) => parseSingleBead(stdout, "bd create"));

    // Add the replacement edge before removing the old one. If the second
    // command fails, the dependent remains blocked by the source and cannot
    // accidentally run without human approval.
    for (const dependentId of blockingDependentIds) {
      await this.run(["dep", "add", dependentId, gate.id, "--json"]);
      await this.run(["dep", "remove", dependentId, request.issueId, "--json"]);
    }
    return gate;
  }

  close(issueId: string, reason?: string): Promise<Bead> {
    requireNonEmpty(issueId, "issueId");
    const args = ["close", issueId];
    if (reason !== undefined) {
      requireNonEmpty(reason, "reason");
      args.push(`--reason=${reason}`);
    }
    args.push("--json");
    return this.runJson(args).then((stdout) => parseSingleBead(stdout, "bd close"));
  }

  transition(issueId: string, transition: BeadTransition): Promise<Bead> {
    if (transition.status === "closed") {
      return this.close(issueId, transition.reason);
    }
    return this.update(issueId, transition);
  }

  private async runJson(args: readonly string[]): Promise<string> {
    return this.run(args);
  }

  private async run(args: readonly string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.command, [...args], {
        cwd: this.cwd,
        env: this.env,
        timeout: this.timeoutMs,
        maxBuffer: this.maxBufferBytes,
        encoding: "utf8",
      }) as { stdout: string };
      return result.stdout;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new BeadsCommandError(
          args,
          error as ExecFileException & { stderr?: string | Buffer },
        );
      }
      throw new BeadsError(`bd command failed (${args.join(" ")}): ${String(error)}`);
    }
  }
}

export function createBeadsAdapter(options?: BeadsAdapterOptions | string): BeadsAdapter {
  return new BeadsAdapter(options);
}
