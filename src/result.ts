import { readFile } from "node:fs/promises";

export type WorkerResultStatus = "done" | "failed";

/** The JSON object a worker writes before it exits. */
export interface WorkerResult {
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly needs_human?: string;
  readonly [key: string]: unknown;
}

export type ResultFileState =
  | {
      readonly kind: "success";
      readonly result: WorkerResult;
    }
  | {
      readonly kind: "failure";
      readonly result: WorkerResult;
    }
  | {
      readonly kind: "needs_human";
      readonly result: WorkerResult;
      readonly reason: string;
    }
  | {
      readonly kind: "missing";
      readonly path: string;
    }
  | {
      readonly kind: "invalid_json";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "invalid_schema";
      readonly path: string;
      readonly issues: readonly string[];
    };

export type WorkerResultOutcome = ResultFileState;

function requirePath(path: string): void {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TypeError("result path must not be empty");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaIssues(value: unknown): string[] {
  if (!isRecord(value)) {
    return ["result must be a JSON object"];
  }

  const issues: string[] = [];
  if (value.status !== "done" && value.status !== "failed") {
    issues.push("status must be \"done\" or \"failed\"");
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    issues.push("summary must be a non-empty string");
  }
  if (value.needs_human !== undefined &&
      (typeof value.needs_human !== "string" || value.needs_human.trim().length === 0)) {
    issues.push("needs_human must be a non-empty string when present");
  }
  return issues;
}

function asWorkerResult(value: Record<string, unknown>): WorkerResult {
  return value as WorkerResult;
}

/** Parse and classify a worker result without conflating protocol failures. */
export function parseWorkerResult(contents: string, path = "<result>"): ResultFileState {
  requirePath(path);

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    return {
      kind: "invalid_json",
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const issues = schemaIssues(value);
  if (issues.length > 0) {
    return { kind: "invalid_schema", path, issues };
  }

  const result = asWorkerResult(value as Record<string, unknown>);
  if (result.needs_human !== undefined) {
    return { kind: "needs_human", result, reason: result.needs_human };
  }
  return result.status === "done"
    ? { kind: "success", result }
    : { kind: "failure", result };
}

/** Read and classify the result file written by a worker. */
export async function readWorkerResult(path: string): Promise<ResultFileState> {
  requirePath(path);

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") {
      return { kind: "missing", path };
    }
    throw error;
  }

  return parseWorkerResult(contents, path);
}
