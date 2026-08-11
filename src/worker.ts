import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bead } from "./beads.js";
import {
  createHerdrAdapter,
  type AgentPromptedResult,
  type AgentStartedResult,
  type HerdrClient,
  type AgentStartOptions,
} from "./herdr.js";
import { parseDurationMs, type GisConfig, type ProfileCandidate } from "./config.js";
import { buildAgentStartArgs } from "./profiles.js";

/** The only text that gis injects into a worker's interactive TUI. */
export const WORKER_PROMPT = "Read .gis/run/prompt.md and execute it.";
const MAX_AGENT_START_TIMEOUT_MS = 30_000;

export interface WorkerPromptOptions {
  readonly bead: Pick<Bead, "id" | "description" | "acceptance_criteria">;
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
  readonly content: string;
}

export interface WorkerStartupSource {
  agentStart(options: AgentStartOptions): Promise<AgentStartedResult>;
  agentPrompt(target: string, text: string): Promise<AgentPromptedResult>;
}

export interface WorkerPromptSource {
  agentPrompt(target: string, text: string): Promise<AgentPromptedResult>;
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
  readonly paneId: string;
  readonly candidate: ProfileCandidate;
  readonly config: Pick<GisConfig, "claude_permission_mode" | "worker_timeout">;
  readonly herdr?: WorkerStartupSource;
}

export interface StartedWorker {
  readonly prompt: WorkerPrompt;
  readonly started: AgentStartedResult;
  readonly prompted: AgentPromptedResult;
}

export type WorkerStartupPhase = "start" | "prompt";

/** Distinguish a runner process failure from a prompt/API failure. */
export class WorkerStartupError extends Error {
  readonly phase: WorkerStartupPhase;

  constructor(phase: WorkerStartupPhase, cause: unknown) {
    super(`worker ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "WorkerStartupError";
    this.phase = phase;
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function roundNumber(value: number | undefined): number {
  const round = value ?? 1;
  if (!Number.isSafeInteger(round) || round <= 0) {
    throw new RangeError("round must be a positive integer");
  }
  return round;
}

function acceptanceCriteria(value: string | undefined): string {
  return value?.trim() || "No acceptance criteria were provided.";
}

function verificationFeedback(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return [
    "## Previous verification failure",
    "",
    value.trim(),
    "",
    "Fix the failure above, then run verification again before reporting completion.",
    "",
  ];
}

function promptContent(
  options: WorkerPromptOptions,
  resultRelativePath: string,
): string {
  const { bead } = options;
  return [
    "# gis worker task",
    "",
    `- Bead ID: \`${bead.id}\``,
    "",
    "## Task",
    "",
    bead.description.trim(),
    "",
    "## Acceptance criteria",
    "",
    acceptanceCriteria(bead.acceptance_criteria),
    "",
    "## Verification",
    "",
    `Run this command before reporting completion: \`${options.verifyCommand}\``,
    "",
    "## Commit requirement",
    "",
    "Commit all intended implementation changes on this bead branch before reporting completion.",
    "Do not report done when the branch has no commit ahead of the configured base.",
    "",
    ...verificationFeedback(options.verificationFeedback),
    "## Result file",
    "",
    `Before finishing, write a JSON result to \`${resultRelativePath}\`.`,
    "The object must contain `status` (`done` or `failed`) and a concise `summary`.",
    "If a human must decide or intervene, also include `needs_human` with the reason.",
    "",
  ].join("\n");
}

/** Write the complete worker instructions to the worktree filesystem. */
export async function writeWorkerPrompt(options: WorkerPromptOptions): Promise<WorkerPrompt> {
  requireNonEmpty(options.bead.id, "bead.id");
  requireNonEmpty(options.bead.description, "bead.description");
  requireNonEmpty(options.runPath, "runPath");
  requireNonEmpty(options.verifyCommand, "verifyCommand");

  const round = roundNumber(options.round);
  const resultRelativePath = `.gis/run/round-${round}-impl.json`;
  const path = join(options.runPath, "prompt.md");
  const resultPath = join(options.runPath, `round-${round}-impl.json`);
  const content = promptContent(options, resultRelativePath);

  await mkdir(options.runPath, { recursive: true });
  await writeFile(path, content, "utf8");
  return { path, resultPath, resultRelativePath, content };
}

function defaultHerdr(): WorkerStartupSource {
  return createHerdrAdapter() as HerdrClient;
}

/** Write a retry prompt and send the same one-line instruction to the live pane. */
export async function promptWorker(options: PromptWorkerOptions): Promise<PromptedWorker> {
  requireNonEmpty(options.target, "target");
  const prompt = await writeWorkerPrompt(options);
  const herdr = options.herdr ?? defaultHerdr();
  const prompted = await herdr.agentPrompt(options.target, WORKER_PROMPT);
  return { prompt, prompted };
}

/** Write the prompt, start the selected runner, then inject only WORKER_PROMPT. */
export async function startWorker(options: StartWorkerOptions): Promise<StartedWorker> {
  requireNonEmpty(options.paneId, "paneId");
  requireNonEmpty(options.candidate.kind, "candidate.kind");

  const prompt = await writeWorkerPrompt(options);
  const herdr = options.herdr ?? defaultHerdr();
  let started: AgentStartedResult;
  try {
    started = await herdr.agentStart({
      name: options.bead.id,
      kind: options.candidate.kind,
      paneId: options.paneId,
      args: buildAgentStartArgs(options.candidate, options.config),
      timeoutMs: Math.min(
        parseDurationMs(options.config.worker_timeout, "worker_timeout"),
        MAX_AGENT_START_TIMEOUT_MS,
      ),
    });
  } catch (error: unknown) {
    throw new WorkerStartupError("start", error);
  }

  let prompted: AgentPromptedResult;
  try {
    prompted = await herdr.agentPrompt(options.bead.id, WORKER_PROMPT);
  } catch (error: unknown) {
    throw new WorkerStartupError("prompt", error);
  }
  return { prompt, started, prompted };
}
