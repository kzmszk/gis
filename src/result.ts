import { readFile } from 'node:fs/promises';
import { requireNonEmpty, validateResultSchema } from './internal.js';

export type WorkerResultStatus = 'done' | 'failed';

/** The JSON object a worker writes before it exits. */
export interface WorkerResult {
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly needs_human?: string;
  readonly [key: string]: unknown;
}

export type ResultFileState =
  | {
      readonly kind: 'success';
      readonly result: WorkerResult;
    }
  | {
      readonly kind: 'failure';
      readonly result: WorkerResult;
    }
  | {
      readonly kind: 'needs_human';
      readonly result: WorkerResult;
      readonly reason: string;
    }
  | {
      readonly kind: 'missing';
      readonly path: string;
    }
  | {
      readonly kind: 'stale';
      readonly path: string;
      readonly expectedRunId: string;
      readonly actualRunId?: string;
    }
  | {
      readonly kind: 'invalid_json';
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: 'invalid_schema';
      readonly path: string;
      readonly issues: readonly string[];
    };

export type WorkerResultOutcome = ResultFileState;

export type WorkerResultProblem = Exclude<
  ResultFileState,
  { readonly kind: 'success' } | { readonly kind: 'needs_human' }
>;

function assertNever(value: never): never {
  throw new Error(`unhandled worker result: ${JSON.stringify(value)}`);
}

export function workerResultProblemDetail(result: WorkerResultProblem): string {
  switch (result.kind) {
    case 'failure':
      return result.result.summary;
    case 'invalid_schema':
      return result.issues.join('; ');
    case 'invalid_json':
      return result.message;
    case 'stale':
      return `result file belongs to another run: ${result.path}`;
    case 'missing':
      return `result file is missing: ${result.path}`;
    default:
      return assertNever(result);
  }
}

function schemaIssues(value: unknown): string[] {
  const validation = validateResultSchema(value, 'result');
  if (validation.kind === 'not_object') return [validation.issue];
  return [
    validation.statusIssue,
    validation.summaryIssue,
    validation.humanReasonIssue,
  ].filter((issue): issue is string => issue !== undefined);
}

function asWorkerResult(value: Record<string, unknown>): WorkerResult {
  return value as WorkerResult;
}

/** Parse and classify a worker result without conflating protocol failures. */
export function parseWorkerResult(
  contents: string,
  path = '<result>',
): ResultFileState {
  requireNonEmpty(path, 'result path');

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    return {
      kind: 'invalid_json',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const issues = schemaIssues(value);
  if (issues.length > 0) {
    return { kind: 'invalid_schema', path, issues };
  }

  const result = asWorkerResult(value as Record<string, unknown>);
  if (result.needs_human !== undefined) {
    return { kind: 'needs_human', result, reason: result.needs_human };
  }
  return result.status === 'done'
    ? { kind: 'success', result }
    : { kind: 'failure', result };
}

type ResultWithRunId = Extract<
  ResultFileState,
  { readonly kind: 'success' | 'failure' | 'needs_human' }
>;

function hasResult(parsed: ResultFileState): parsed is ResultWithRunId {
  return (
    parsed.kind === 'success' ||
    parsed.kind === 'failure' ||
    parsed.kind === 'needs_human'
  );
}

/** Build the `stale` state once a parsed result's run_id misses the expected one. */
function staleResult(
  path: string,
  expectedRunId: string,
  parsed: ResultWithRunId,
): ResultFileState {
  return {
    kind: 'stale',
    path,
    expectedRunId,
    actualRunId:
      typeof parsed.result.run_id === 'string'
        ? parsed.result.run_id
        : undefined,
  };
}

/** Read and classify the result file written by a worker. */
export async function readWorkerResult(
  path: string,
  expectedRunId?: string,
): Promise<ResultFileState> {
  requireNonEmpty(path, 'result path');

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error: unknown) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') {
      return { kind: 'missing', path };
    }
    throw error;
  }

  const parsed = parseWorkerResult(contents, path);
  if (
    expectedRunId !== undefined &&
    hasResult(parsed) &&
    parsed.result.run_id !== expectedRunId
  ) {
    return staleResult(path, expectedRunId, parsed);
  }
  return parsed;
}
