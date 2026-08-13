/** Format an unknown thrown value for an operational error message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Require a non-empty string for public adapter and orchestration inputs. */
export function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

/** Require a positive safe integer for bounded retry and polling settings. */
export function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/** Normalize text-like command output without leaking Buffer values. */
export function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value instanceof Buffer
      ? value.toString('utf8')
      : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function statusIssue(record: Record<string, unknown>): string | undefined {
  return record.status === 'done' || record.status === 'failed'
    ? undefined
    : 'status must be "done" or "failed"';
}

function summaryIssue(record: Record<string, unknown>): string | undefined {
  return isNonEmptyString(record.summary)
    ? undefined
    : 'summary must be a non-empty string';
}

function humanReasonIssue(record: Record<string, unknown>): string | undefined {
  if (record.needs_human === undefined) return undefined;
  return isNonEmptyString(record.needs_human)
    ? undefined
    : 'needs_human must be a non-empty string when present';
}

export type ResultSchemaValidation =
  | { readonly kind: 'not_object'; readonly issue: string }
  | {
      readonly kind: 'record';
      readonly record: Record<string, unknown>;
      readonly statusIssue?: string;
      readonly summaryIssue?: string;
      readonly humanReasonIssue?: string;
    };

/** Validate and narrow the fields shared by worker and reviewer results. */
export function validateResultSchema(
  value: unknown,
  label: string,
): ResultSchemaValidation {
  if (!isRecord(value)) {
    return { kind: 'not_object', issue: `${label} must be a JSON object` };
  }
  return {
    kind: 'record',
    record: value,
    statusIssue: statusIssue(value),
    summaryIssue: summaryIssue(value),
    humanReasonIssue: humanReasonIssue(value),
  };
}

/** Suspend asynchronous control flow without coupling callers to timers. */
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Assert a discriminated union has been handled exhaustively. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
