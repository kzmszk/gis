import { exec } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import type { Bead, BeadHandoffLocations } from './beads.js';
import { parseDurationMs, type GisConfig } from './config.js';
import {
  promptWorker,
  type VerificationCycle,
  type WorkerPromptSource,
} from './worker.js';

const execAsync = promisify(exec);
const VERIFY_MAX_BUFFER = 10 * 1024 * 1024;

export interface VerifyCommandResult {
  readonly passed: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

export type VerifyCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs?: number,
) => Promise<VerifyCommandResult>;

export interface VerifyLoopBeadsSource {
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
}

export interface VerifyLoopOptions {
  readonly bead: Pick<Bead, 'id' | 'description' | 'acceptance_criteria'>;
  readonly worktreePath: string;
  readonly runPath: string;
  readonly transcriptPath: string;
  /** Resolve the live session again when a final failed attempt is handed off. */
  readonly resolveTranscriptPath?: () => Promise<string>;
  readonly config: Pick<GisConfig, 'verify' | 'verify_max' | 'verify_timeout'>;
  readonly beads: VerifyLoopBeadsSource;
  /** Herdr target for the implementation pane; defaults to the bead ID. */
  readonly target?: string;
  readonly herdr?: WorkerPromptSource;
  /** The caller waits for the worker's initial completion before entering this loop. */
  readonly waitForWorker?: () => Promise<void>;
  readonly runVerify?: VerifyCommandRunner;
  /** Namespace that separates retries from prior review cycles. */
  readonly verificationCycle?: VerificationCycle;
}

export interface VerifyLoopVerifiedResult {
  readonly status: 'verified';
  /** Number of verify commands that were actually run. */
  readonly attempts: number;
  readonly result: VerifyCommandResult;
}

export interface VerifyLoopBlockedResult {
  readonly status: 'blocked';
  /** Number of verify commands that were actually run. */
  readonly attempts: number;
  readonly result: VerifyCommandResult;
  readonly handoff: BeadHandoffLocations;
  readonly bead: Bead;
}

export type VerifyLoopResult =
  | VerifyLoopVerifiedResult
  | VerifyLoopBlockedResult;

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value instanceof Buffer
      ? value.toString('utf8')
      : '';
}

function exitCode(
  error: ExecException & { code?: string | number },
): number | undefined {
  return typeof error.code === 'number' ? error.code : undefined;
}

/** Execute the configured shell command in the bead's worktree. */
export async function runVerifyCommand(
  command: string,
  cwd: string,
  timeoutMs?: number,
): Promise<VerifyCommandResult> {
  requireNonEmpty(command, 'verifyCommand');
  requireNonEmpty(cwd, 'cwd');

  try {
    const result = await execAsync(command, {
      cwd,
      encoding: 'utf8',
      maxBuffer: VERIFY_MAX_BUFFER,
      timeout: timeoutMs,
    });
    return {
      passed: true,
      stdout: text(result.stdout),
      stderr: text(result.stderr),
    };
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }

    const commandError = error as ExecException & {
      code?: string | number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      passed: false,
      stdout: text(commandError.stdout),
      stderr: text(commandError.stderr),
      exitCode: exitCode(commandError),
      signal: commandError.signal,
    };
  }
}

function failureFeedback(command: string, result: VerifyCommandResult): string {
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
    `Verification command failed: ${command}`,
    `Result: ${status}`,
    '',
    output || '(the command produced no output)',
  ].join('\n');
}

/**
 * Run the phase-1 verify loop.
 *
 * `verify_max` counts verify command executions, including the first one.
 * Therefore a failure on the last allowed attempt is escalated immediately:
 * no extra prompt or verify command is issued. The caller may provide
 * `waitForWorker` to wait for the same live implementation pane after each
 * retry prompt; the initial wait belongs to the caller because the worker is
 * started by a separate lifecycle step.
 */
export async function runVerificationLoop(
  options: VerifyLoopOptions,
): Promise<VerifyLoopResult> {
  requireNonEmpty(options.bead.id, 'bead.id');
  requireNonEmpty(options.bead.description, 'bead.description');
  requireNonEmpty(options.worktreePath, 'worktreePath');
  requireNonEmpty(options.runPath, 'runPath');
  requireNonEmpty(options.transcriptPath, 'transcriptPath');
  requireNonEmpty(options.config.verify, 'config.verify');
  requirePositiveInteger(options.config.verify_max, 'config.verify_max');

  const target = options.target ?? options.bead.id;
  requireNonEmpty(target, 'target');
  const runVerify = options.runVerify ?? runVerifyCommand;

  for (let attempt = 1; attempt <= options.config.verify_max; attempt += 1) {
    const result = await runVerify(
      options.config.verify,
      options.worktreePath,
      parseDurationMs(options.config.verify_timeout, 'verify_timeout'),
    );
    if (result.passed) {
      return { status: 'verified', attempts: attempt, result };
    }

    if (attempt === options.config.verify_max) {
      const transcriptPath =
        options.resolveTranscriptPath === undefined
          ? options.transcriptPath
          : await options.resolveTranscriptPath();
      const handoff: BeadHandoffLocations = {
        worktreePath: options.worktreePath,
        roundLogPath: options.runPath,
        transcriptPath,
      };
      const bead = await options.beads.markBlocked(options.bead.id, handoff);
      return { status: 'blocked', attempts: attempt, result, handoff, bead };
    }

    await promptWorker({
      bead: options.bead,
      runPath: options.runPath,
      verifyCommand: options.config.verify,
      round: attempt + 1,
      phase: 'verify',
      verificationCycle: options.verificationCycle,
      verificationAttempt: attempt + 1,
      verificationFeedback: failureFeedback(options.config.verify, result),
      target,
      herdr: options.herdr,
    });
    await options.waitForWorker?.();
  }

  // The positive-integer validation and bounded loop make this unreachable.
  throw new Error('verify loop ended without a result');
}

export const verifyLoop = runVerificationLoop;
