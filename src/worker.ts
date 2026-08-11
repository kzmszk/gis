import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Bead } from './beads.js';
import {
  createHerdrAdapter,
  type AgentPromptedResult,
  type AgentStartedResult,
  type AgentStartOptions,
  type AgentPromptOptions,
  type SessionSnapshotResult,
} from './herdr.js';
import {
  parseDurationMs,
  type GisConfig,
  type ProfileCandidate,
} from './config.js';
import { buildAgentStartArgs } from './profiles.js';

/** The only text that gis injects into a worker's interactive TUI. */
export const WORKER_PROMPT = 'Read .gis/run/prompt.md and execute it.';
const MAX_AGENT_START_TIMEOUT_MS = 300_000;
const MIN_AGENT_START_TIMEOUT_MS = 3_000;
const AGENT_READY_POLL_MS = 50;
const IDLE_READINESS_FALLBACK_MS = 30_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 10_000;
const HERDR_AGENT_NAME_MAX_LENGTH = 32;
const HERDR_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface WorkerPromptOptions {
  readonly bead: Pick<Bead, 'id' | 'description' | 'acceptance_criteria'>;
  readonly runPath: string;
  readonly verifyCommand: string;
  /** The implementation round used in the result filename. */
  readonly round?: number;
  /** Verification output that the worker should address on a retry. */
  readonly verificationFeedback?: string;
}

export interface WorkerPrompt {
  readonly path: string;
  readonly resultPath: string;
  readonly resultRelativePath: string;
  readonly runId: string;
  readonly content: string;
}

export interface WorkerPromptSource {
  agentPrompt(
    target: string,
    text: string,
    options?: AgentPromptOptions,
  ): Promise<AgentPromptedResult>;
}

export interface WorkerStartupSource extends WorkerPromptSource {
  agentStart(options: AgentStartOptions): Promise<AgentStartedResult>;
  apiSnapshot(timeoutMs?: number): Promise<SessionSnapshotResult>;
}

export interface PromptedWorker {
  readonly prompt: WorkerPrompt;
  readonly prompted: AgentPromptedResult;
}

export interface PromptWorkerOptions extends WorkerPromptOptions {
  readonly target: string;
  readonly herdr?: WorkerPromptSource;
}

export interface StartWorkerOptions extends WorkerPromptOptions {
  readonly agentName: string;
  readonly paneId: string;
  readonly candidate: ProfileCandidate;
  readonly config: Pick<GisConfig, 'claude_permission_mode' | 'worker_timeout'>;
  readonly herdr?: WorkerStartupSource;
  /** Test seam for Herdr versions that leave an otherwise-idle agent launch-pending. */
  readonly idleReadinessFallbackMs?: number;
}

export interface StartedWorker {
  readonly prompt: WorkerPrompt;
  readonly started: AgentStartedResult;
  readonly prompted: AgentPromptedResult;
}

export type WorkerStartupPhase = 'start' | 'readiness' | 'prompt';

/** Distinguish a runner process failure from a prompt/API failure. */
export class WorkerStartupError extends Error {
  readonly phase: WorkerStartupPhase;

  constructor(phase: WorkerStartupPhase, cause: unknown) {
    super(
      `worker ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = 'WorkerStartupError';
    this.phase = phase;
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

/** Map an arbitrary Bead ID to a stable, collision-resistant Herdr agent name. */
export function herdrAgentName(beadId: string): string {
  requireNonEmpty(beadId, 'beadId');
  const source = beadId.trim();
  if (HERDR_AGENT_NAME_PATTERN.test(source)) {
    return source;
  }

  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const baseLimit = HERDR_AGENT_NAME_MAX_LENGTH - hash.length - 1;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, baseLimit)
    .replace(/[-_]+$/, '');
  const base = normalized.length === 0 ? 'bead' : normalized;
  return `${base}-${hash}`;
}

function roundNumber(value: number | undefined): number {
  const round = value ?? 1;
  if (!Number.isSafeInteger(round) || round <= 0) {
    throw new RangeError('round must be a positive integer');
  }
  return round;
}

function acceptanceCriteria(value: string | undefined): string {
  return value?.trim() || 'No acceptance criteria were provided.';
}

function verificationFeedback(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return [
    '## Previous verification failure',
    '',
    value.trim(),
    '',
    'Fix the failure above, then run verification again before reporting completion.',
    '',
  ];
}

function promptContent(
  options: WorkerPromptOptions,
  resultRelativePath: string,
  runId: string,
): string {
  const { bead } = options;
  return [
    '# gis worker task',
    '',
    `- Bead ID: \`${bead.id}\``,
    `- Run ID: \`${runId}\``,
    '',
    '## Task',
    '',
    bead.description.trim(),
    '',
    '## Acceptance criteria',
    '',
    acceptanceCriteria(bead.acceptance_criteria),
    '',
    '## Verification',
    '',
    `Run this command before reporting completion: \`${options.verifyCommand}\``,
    '',
    '## Commit requirement',
    '',
    'The user explicitly authorizes the task-scoped commits needed to complete this bead on this branch.',
    'This task-specific authorization overrides any conservative or no-git default printed by `bd prime`.',
    'Commit all intended implementation changes on this bead branch before reporting completion.',
    'Do not bypass or disable Git hooks, including with `--no-verify`.',
    'If a pre-commit hook modifies files or rejects a commit, inspect its output and changes, restage the intended changes, rerun verification, and retry the commit.',
    'Do not report done when the branch has no commit ahead of the configured base.',
    'Before reporting completion, confirm `git status --porcelain` is empty.',
    'Files under `.gis/run/` are GIS runtime artifacts: never stage or commit them, even with `git add -f`.',
    'Ignored `.gis/run/` files do not count against the clean-worktree requirement.',
    'Do not push the branch, and do not run `bd dolt push`.',
    'Do not close, reopen, or otherwise change the Bead status; GIS owns task-state transitions.',
    '',
    ...verificationFeedback(options.verificationFeedback),
    '## Result file',
    '',
    `Before finishing, write a JSON result to \`${resultRelativePath}\`.`,
    `The object must contain \`run_id\` exactly equal to \`${runId}\`, \`status\` (\`done\` or \`failed\`), and a concise \`summary\`.`,
    'Write this result only after the task commit and final verification have succeeded.',
    'If a human must decide or intervene, also include `needs_human` with the reason.',
    '',
  ].join('\n');
}

/** Write the complete worker instructions to the worktree filesystem. */
export async function writeWorkerPrompt(
  options: WorkerPromptOptions,
): Promise<WorkerPrompt> {
  requireNonEmpty(options.bead.id, 'bead.id');
  requireNonEmpty(options.bead.description, 'bead.description');
  requireNonEmpty(options.runPath, 'runPath');
  requireNonEmpty(options.verifyCommand, 'verifyCommand');

  const round = roundNumber(options.round);
  const resultRelativePath = `.gis/run/round-${round}-impl.json`;
  const path = join(options.runPath, 'prompt.md');
  const resultPath = join(options.runPath, `round-${round}-impl.json`);
  const runId = randomUUID();
  const content = promptContent(options, resultRelativePath, runId);

  await mkdir(options.runPath, { recursive: true });
  await rm(resultPath, { force: true });
  await writeFile(path, content, 'utf8');
  return { path, resultPath, resultRelativePath, runId, content };
}

function defaultHerdr(): WorkerStartupSource {
  return createHerdrAdapter();
}

function promptAcceptanceOptions(timeoutMs: number): AgentPromptOptions {
  return { wait: { until: ['working'], timeoutMs } };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  description: string,
): Promise<T> {
  const timeoutMs = remainingTime(deadline);
  if (timeoutMs === 0) {
    throw new Error(`${description} timed out`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForNamedAgentReady(
  herdr: WorkerStartupSource,
  paneId: string,
  name: string,
  kind: string,
  previousStateChangeSeq: number,
  deadline: number,
  idleFallbackMs: number,
): Promise<void> {
  let stableIdle: { stateChangeSeq: number; since: number } | undefined;
  while (true) {
    const { snapshot } = await beforeDeadline(
      herdr.apiSnapshot(remainingTime(deadline)),
      deadline,
      `waiting for agent ${name} readiness snapshot`,
    );
    const agent = snapshot.agents.find(
      (candidate) => candidate.pane_id === paneId,
    );
    const stateChangeSeq = agent?.state_change_seq;
    const matchesStartedAgent =
      agent?.name === name &&
      agent.agent === kind &&
      typeof stateChangeSeq === 'number' &&
      stateChangeSeq > previousStateChangeSeq;
    const launchIsSettled =
      agent?.agent_status === 'idle' || agent?.agent_status === 'done';
    if (
      matchesStartedAgent &&
      agent.interactive_ready === true &&
      agent.launch_pending !== true &&
      launchIsSettled
    ) {
      return;
    }

    if (
      matchesStartedAgent &&
      typeof stateChangeSeq === 'number' &&
      agent.launch_pending === true &&
      agent.agent_status === 'idle'
    ) {
      const now = Date.now();
      if (
        stableIdle === undefined ||
        stableIdle.stateChangeSeq !== stateChangeSeq
      ) {
        stableIdle = { stateChangeSeq, since: now };
      }
      if (now - stableIdle.since >= idleFallbackMs) {
        return;
      }
    } else {
      stableIdle = undefined;
    }

    const remainingMs = remainingTime(deadline);
    if (remainingMs <= 0) {
      throw new Error(
        `agent ${name} in pane ${paneId} did not become interactive-ready before startup timeout`,
      );
    }
    await delay(Math.min(AGENT_READY_POLL_MS, remainingMs));
  }
}

/** Write a retry prompt and send the same one-line instruction to the live pane. */
export async function promptWorker(
  options: PromptWorkerOptions,
): Promise<PromptedWorker> {
  requireNonEmpty(options.target, 'target');
  const prompt = await writeWorkerPrompt(options);
  const herdr = options.herdr ?? defaultHerdr();
  const prompted = await herdr.agentPrompt(
    options.target,
    WORKER_PROMPT,
    promptAcceptanceOptions(PROMPT_ACCEPT_TIMEOUT_MS),
  );
  return { prompt, prompted };
}

/** Write the prompt, start the selected runner, then inject only WORKER_PROMPT. */
export async function startWorker(
  options: StartWorkerOptions,
): Promise<StartedWorker> {
  requireNonEmpty(options.agentName, 'agentName');
  if (!HERDR_AGENT_NAME_PATTERN.test(options.agentName)) {
    throw new TypeError('agentName must be a valid Herdr agent name');
  }
  requireNonEmpty(options.paneId, 'paneId');
  requireNonEmpty(options.candidate.kind, 'candidate.kind');
  const idleFallbackMs =
    options.idleReadinessFallbackMs ?? IDLE_READINESS_FALLBACK_MS;
  if (!Number.isFinite(idleFallbackMs) || idleFallbackMs < 0) {
    throw new RangeError(
      'idleReadinessFallbackMs must be a non-negative finite number',
    );
  }

  const prompt = await writeWorkerPrompt(options);
  const herdr = options.herdr ?? defaultHerdr();
  const configuredTimeoutMs = parseDurationMs(
    options.config.worker_timeout,
    'worker_timeout',
  );
  if (configuredTimeoutMs <= MIN_AGENT_START_TIMEOUT_MS) {
    throw new RangeError(
      'worker_timeout must be greater than 3000ms for herdr agent.start',
    );
  }
  const startTimeoutMs = Math.min(
    configuredTimeoutMs,
    MAX_AGENT_START_TIMEOUT_MS,
  );
  const deadline = Date.now() + startTimeoutMs;
  let started: AgentStartedResult;
  let previousStateChangeSeq: number;
  try {
    const beforeStart = await beforeDeadline(
      herdr.apiSnapshot(remainingTime(deadline)),
      deadline,
      `capturing agent ${options.agentName} pre-start snapshot`,
    );
    const previousAgent = beforeStart.snapshot.agents.find(
      (agent) => agent.pane_id === options.paneId,
    );
    previousStateChangeSeq =
      typeof previousAgent?.state_change_seq === 'number'
        ? previousAgent.state_change_seq
        : -1;
    const agentStartTimeoutMs = remainingTime(deadline);
    if (agentStartTimeoutMs <= MIN_AGENT_START_TIMEOUT_MS) {
      throw new Error('not enough startup time remains for herdr agent.start');
    }
    started = await beforeDeadline(
      herdr.agentStart({
        name: options.agentName,
        kind: options.candidate.kind,
        paneId: options.paneId,
        args: buildAgentStartArgs(options.candidate, options.config),
        timeoutMs: agentStartTimeoutMs,
      }),
      deadline,
      `starting agent ${options.agentName}`,
    );
  } catch (error: unknown) {
    throw new WorkerStartupError('start', error);
  }

  try {
    await waitForNamedAgentReady(
      herdr,
      options.paneId,
      options.agentName,
      options.candidate.kind,
      previousStateChangeSeq,
      deadline,
      idleFallbackMs,
    );
  } catch (error: unknown) {
    throw new WorkerStartupError('readiness', error);
  }

  let prompted: AgentPromptedResult;
  try {
    const promptTimeoutMs = remainingTime(deadline);
    if (promptTimeoutMs === 0) {
      throw new Error(`prompting agent ${options.agentName} timed out`);
    }
    prompted = await beforeDeadline(
      herdr.agentPrompt(
        options.agentName,
        WORKER_PROMPT,
        promptAcceptanceOptions(promptTimeoutMs),
      ),
      deadline,
      `prompting agent ${options.agentName}`,
    );
  } catch (error: unknown) {
    throw new WorkerStartupError('prompt', error);
  }
  return { prompt, started, prompted };
}
