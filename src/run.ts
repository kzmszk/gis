import { join, resolve } from 'node:path';
import type { Bead, BeadHandoffLocations, HumanGateRequest } from './beads.js';
import { createBeadsAdapter } from './beads.js';
import type { GisConfig } from './config.js';
import { loadConfig, parseDurationMs } from './config.js';
import { createHerdrAdapter } from './herdr.js';
import type { AgentInfo, AgentSessionInfo } from './herdr.js';
import {
  SerialMergeQueue,
  type MergeQueueItem,
  type MergeResult,
} from './merge.js';
import { startWithProfileFallback } from './profiles.js';
import {
  readWorkerResult,
  workerResultProblemDetail,
  type ResultFileState,
} from './result.js';
import { resolveAgentSessionTranscript } from './transcripts.js';
import {
  waitForAgentWithBlockedHandling,
  type AgentWaitHandlingResult,
  type BlockedHerdrSource,
} from './blocked.js';
import { runVerificationLoop, type VerifyLoopResult } from './verify.js';
import {
  createBeadWorktree,
  type BeadWorktree,
  type CreateBeadWorktreeOptions,
} from './worktree.js';
import type { WorktreeLifecycleSource } from './worktree.js';
import {
  startWorker,
  herdrAgentName,
  type StartWorkerOptions,
  type StartedWorker,
  type WorkerPromptSource,
  type WorkerStartupSource,
  WorkerStartupError,
} from './worker.js';
import type { ReviewHerdrSource, StartedReviewer } from './review.js';
import { runReviewLoop } from './review-loop.js';
import type { ProfileCandidate } from './config.js';

export interface RunBeadsSource {
  ready(): Promise<readonly Bead[]>;
  dispatch(issueId: string, kind: string): Promise<Bead>;
  markMerged(issueId: string, reason?: string): Promise<Bead>;
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
  createHumanGate(request: HumanGateRequest): Promise<Bead>;
  listHuman?(): Promise<readonly Bead[]>;
}

export type RunHerdrSource = WorktreeLifecycleSource &
  WorkerStartupSource &
  WorkerPromptSource &
  BlockedHerdrSource & {
    /** Herdr pane.split is required only when review=true. */
    paneSplit?: ReviewHerdrSource['paneSplit'];
  };

export interface RunWorktreeSource {
  create(options: CreateBeadWorktreeOptions): Promise<BeadWorktree>;
}

export interface RunWorkerSource {
  start(options: StartWorkerOptions): Promise<StartedWorker>;
}

export interface RunBlockedSource {
  wait(
    options: Parameters<typeof waitForAgentWithBlockedHandling>[0],
  ): Promise<AgentWaitHandlingResult>;
}

export interface RunVerifySource {
  verify(
    options: Parameters<typeof runVerificationLoop>[0],
  ): Promise<VerifyLoopResult>;
}

export interface RunMergeSource {
  enqueue(item: MergeQueueItem): Promise<MergeResult>;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly config?: GisConfig;
  readonly beads?: RunBeadsSource;
  readonly herdr?: RunHerdrSource;
  readonly worktrees?: RunWorktreeSource;
  readonly workers?: RunWorkerSource;
  readonly blocked?: RunBlockedSource;
  readonly verify?: RunVerifySource;
  readonly merge?: RunMergeSource;
  readonly resolveTranscript?: (
    session: AgentSessionInfo,
    worktreePath: string,
  ) => Promise<string | undefined>;
  readonly report?: (message: string) => void;
  /** Successful merges completed by startup recovery before this loop. */
  readonly initialMerged?: number;
  /** Test seam for polling externally-resolved human checkpoints. */
  readonly humanPollIntervalMs?: number;
}

export interface RunSummary {
  readonly merged: number;
  readonly blocked: number;
  readonly humanWaiting: number;
  readonly text: string;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function referencedFiles(
  bead: Pick<Bead, 'description' | 'acceptance_criteria'>,
  repositoryPath: string,
): string[] {
  const text = `${bead.description}\n${bead.acceptance_criteria ?? ''}`;
  const matches = text.match(
    /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:html?|md|txt|pdf|png|jpe?g|gif|svg|json|csv|ts|js|mjs|cjs|tsx|jsx|css)/gi,
  );
  return [
    ...new Set((matches ?? []).map((file) => resolve(repositoryPath, file))),
  ];
}

/** Format an actionable terminal notification for open human checkpoints. */
export function formatHumanGateNotification(
  beads: readonly Pick<
    Bead,
    'id' | 'title' | 'description' | 'acceptance_criteria'
  >[],
  repositoryPath = process.cwd(),
): string {
  const unique = new Map(beads.map((bead) => [bead.id, bead]));
  const lines = ['gis: 人間の確認が必要です'];

  for (const bead of [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const request = singleLine(
      bead.acceptance_criteria?.trim() || bead.description,
    );
    const files = referencedFiles(bead, repositoryPath);
    lines.push(
      `  ${bead.id}: ${singleLine(bead.title)}`,
      `    作業場所: ${repositoryPath}`,
      ...(files.length > 0 ? [`    開くファイル: ${files.join(', ')}`] : []),
      `    確認内容: ${request}`,
      `    回答: bd close ${bead.id} --reason "Responded: 確認結果をここに記入"`,
    );
  }

  lines.push('  回答後: GISが自動的に続行します');
  return lines.join('\n');
}

type JobOutcome =
  | { readonly status: 'merged' }
  | { readonly status: 'blocked' }
  | { readonly status: 'human' };

class AlreadyBlockedError extends Error {
  readonly bead: Bead;

  constructor(bead: Bead) {
    super(`worker for ${bead.id} entered blocked state`);
    this.name = 'AlreadyBlockedError';
    this.bead = bead;
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function dispatchableReady(beads: readonly Bead[]): Bead[] {
  return beads
    .filter(
      (bead) =>
        bead.status === 'open' &&
        bead.issue_type !== 'epic' &&
        !bead.labels?.includes('human'),
    )
    .sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id),
    );
}

function defaultTranscriptPath(kind: string, worktreePath: string): string {
  return join(worktreePath, '.gis', 'run', `transcript-${kind}.unresolved`);
}

function handoff(
  worktree: Pick<BeadWorktree, 'path' | 'runPath'>,
  transcriptPath: string,
): BeadHandoffLocations {
  return {
    worktreePath: worktree.path,
    roundLogPath: worktree.runPath,
    transcriptPath,
  };
}

function summaryText(
  merged: number,
  blocked: number,
  humanWaiting: number,
): string {
  return `${merged}件マージ / ${blocked}件 blocked / ${humanWaiting}件が人間の確認待ち`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function waitForCurrentResult(
  path: string,
  runId: string | undefined,
  timeout: string,
): Promise<ResultFileState> {
  const deadline = Date.now() + parseDurationMs(timeout, 'blocked_timeout');
  while (true) {
    const result = await readWorkerResult(path, runId);
    if (result.kind !== 'missing' && result.kind !== 'stale') {
      return result;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return result;
    }
    await delay(Math.min(250, remaining));
  }
}

function agentSession(
  agent: AgentInfo | undefined,
): AgentSessionInfo | undefined {
  return agent?.agent_session ?? undefined;
}

async function findWorkerSession(
  started: StartedWorker,
  agentName: string,
  herdr: RunHerdrSource,
): Promise<AgentSessionInfo | undefined> {
  const direct =
    agentSession(started.prompted?.agent) ??
    agentSession(started.started?.agent);
  if (herdr.apiSnapshot === undefined) {
    return direct;
  }

  try {
    const paneId =
      started.prompted?.agent?.pane_id ?? started.started?.agent?.pane_id;
    const agents = (await herdr.apiSnapshot()).snapshot.agents;
    const exactPane =
      paneId === undefined
        ? undefined
        : agents.find((agent) => agent.pane_id === paneId);
    if (exactPane !== undefined) {
      return agentSession(exactPane);
    }
    const named = agents.find((agent) => agent.name === agentName);
    return agentSession(named);
  } catch {
    // A captured start/prompt response is only a fallback when live state
    // cannot be read. A successful snapshot without a session is authoritative.
    return direct;
  }
}

async function resolveWorkerTranscriptPath(
  started: StartedWorker,
  agentName: string,
  kind: string,
  worktreePath: string,
  herdr: RunHerdrSource,
  resolveTranscript: NonNullable<RunOptions['resolveTranscript']>,
): Promise<string> {
  const fallback = defaultTranscriptPath(kind, worktreePath);
  try {
    const session = await findWorkerSession(started, agentName, herdr);
    if (session === undefined) {
      return fallback;
    }
    return (await resolveTranscript(session, worktreePath)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function formatRunSummary(summary: Omit<RunSummary, 'text'>): string {
  return summaryText(summary.merged, summary.blocked, summary.humanWaiting);
}

function defaultWorkers(herdr: RunHerdrSource): RunWorkerSource {
  return {
    start: (options) =>
      startWorker({
        ...options,
        herdr,
      }),
  };
}

/**
 * Run the stage-1 foreground orchestration loop.
 *
 * The loop only keeps jobs created by this invocation in memory. Every
 * completion causes a fresh `bd ready`, so closing a bead immediately exposes
 * any newly-unblocked dependents to the next dispatch pass.
 */
export async function runForegroundLoop(
  options: RunOptions = {},
): Promise<RunSummary> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? (await loadConfig(cwd));
  requirePositiveInteger(config.concurrency, 'concurrency');

  const beads = options.beads ?? createBeadsAdapter({ cwd });
  const herdr = options.herdr ?? createHerdrAdapter();
  const worktrees =
    options.worktrees ??
    ({
      create: (createOptions: CreateBeadWorktreeOptions) =>
        createBeadWorktree({
          ...createOptions,
          herdr,
        }),
    } satisfies RunWorktreeSource);
  const workers = options.workers ?? defaultWorkers(herdr);
  const blocked =
    options.blocked ??
    ({
      wait: (
        waitOptions: Parameters<typeof waitForAgentWithBlockedHandling>[0],
      ) => waitForAgentWithBlockedHandling(waitOptions),
    } satisfies RunBlockedSource);
  const verify =
    options.verify ??
    ({
      verify: (verifyOptions: Parameters<typeof runVerificationLoop>[0]) =>
        runVerificationLoop(verifyOptions),
    } satisfies RunVerifySource);
  const merge =
    options.merge ??
    new SerialMergeQueue({
      repositoryPath: cwd,
      baseBranch: config.base,
      verifyCommand: config.verify,
      verifyTimeout: config.verify_timeout,
      beads,
    });
  const resolveTranscript =
    options.resolveTranscript ?? resolveAgentSessionTranscript;
  const report = options.report ?? ((message: string) => console.log(message));
  const active = new Map<string, Promise<JobOutcome>>();
  const humanFromWorkers = new Map<string, Bead>();
  const notifiedHumanIds = new Set<string>();
  const humanPollIntervalMs = options.humanPollIntervalMs ?? 1_000;
  requirePositiveInteger(humanPollIntervalMs, 'humanPollIntervalMs');
  let merged = options.initialMerged ?? 0;
  if (!Number.isSafeInteger(merged) || merged < 0) {
    throw new RangeError('initialMerged must be a non-negative integer');
  }
  let blockedCount = 0;
  let waitingForHuman = false;

  const openHumanBeads = async (): Promise<Map<string, Bead>> => {
    if (beads.listHuman !== undefined) {
      return new Map(
        (await beads.listHuman())
          .filter((bead) => bead.status === 'open')
          .map((bead) => [bead.id, bead]),
      );
    }
    return new Map(humanFromWorkers);
  };

  const notifyHumanBeads = (
    gates: ReadonlyMap<string, Bead>,
    repositoryPath: string,
  ): void => {
    const unnotified = [...gates.values()].filter(
      (bead) => !notifiedHumanIds.has(bead.id),
    );
    if (unnotified.length === 0) return;
    report(formatHumanGateNotification(unnotified, repositoryPath));
    for (const bead of unnotified) notifiedHumanIds.add(bead.id);
  };

  const processBead = async (bead: Bead): Promise<JobOutcome> => {
    const agentName = herdrAgentName(bead.id);
    let worktree: BeadWorktree;
    try {
      worktree = await worktrees.create({ bead, config, cwd, herdr });
    } catch (error: unknown) {
      report(
        `gis: worktree creation failed for ${bead.id}: ${errorMessage(error)}`,
      );
      // There is no worktree to retain when creation itself fails. Still
      // persist a deterministic intended handoff so the bead cannot vanish
      // from the run with an in-progress status.
      const intendedPath = resolve(cwd, '.worktrees', bead.id);
      await beads.markBlocked(
        bead.id,
        handoff(
          { path: intendedPath, runPath: join(intendedPath, '.gis', 'run') },
          defaultTranscriptPath('unknown', intendedPath),
        ),
      );
      return { status: 'blocked' };
    }

    let started: StartedWorker | undefined;
    let workerKind: string | undefined;
    let implementationCandidate: ProfileCandidate | undefined;
    try {
      const selection = await startWithProfileFallback(
        bead,
        config,
        async (candidate) => {
          workerKind = candidate.kind;
          await beads.dispatch(bead.id, candidate.kind);
          return workers.start({
            bead,
            agentName,
            runPath: worktree.runPath,
            verifyCommand: config.verify,
            paneId: worktree.paneId,
            candidate,
            config,
            herdr: undefined,
          });
        },
        {
          shouldFallback: (error) =>
            error instanceof WorkerStartupError && error.phase === 'start',
        },
      );
      started = selection.result;
      workerKind = selection.candidate.kind;
      implementationCandidate = selection.candidate;
    } catch (error: unknown) {
      const phase =
        error instanceof WorkerStartupError ? error.phase : 'startup';
      report(
        `gis: worker ${phase} failed for ${bead.id}: ${errorMessage(error)}`,
      );
      const transcriptPath = defaultTranscriptPath(
        workerKind ?? 'unknown',
        worktree.path,
      );
      await beads.markBlocked(bead.id, handoff(worktree, transcriptPath));
      return { status: 'blocked' };
    }

    const currentTranscriptPath = (): Promise<string> =>
      resolveWorkerTranscriptPath(
        started,
        agentName,
        workerKind!,
        worktree.path,
        herdr,
        resolveTranscript,
      );
    const currentHandoff = async (): Promise<BeadHandoffLocations> =>
      handoff(worktree, await currentTranscriptPath());
    const waitOptions = {
      beadId: bead.id,
      target: agentName,
      worktreePath: worktree.path,
      roundLogPath: worktree.runPath,
      transcriptPath: defaultTranscriptPath(workerKind!, worktree.path),
      resolveTranscriptPath: currentTranscriptPath,
      blockedTimeout: config.blocked_timeout,
      workerTimeout: config.worker_timeout,
      herdr,
      beads,
    };

    let waitResult: AgentWaitHandlingResult;
    try {
      waitResult = await blocked.wait(waitOptions);
    } catch (error: unknown) {
      report(`gis: worker wait failed for ${bead.id}: ${errorMessage(error)}`);
      await beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }
    if (waitResult.status === 'blocked') {
      return { status: 'blocked' };
    }

    let result: ResultFileState;
    try {
      result = await waitForCurrentResult(
        started.prompt.resultPath,
        started.prompt.runId,
        config.blocked_timeout,
      );
    } catch (error: unknown) {
      report(
        `gis: worker result read failed for ${bead.id}: ${errorMessage(error)}`,
      );
      await beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }

    if (result.kind === 'needs_human') {
      const locations = await currentHandoff();
      await beads.markBlocked(bead.id, locations);
      try {
        const gate = await beads.createHumanGate({
          issueId: bead.id,
          reason: result.reason,
          locations,
        });
        humanFromWorkers.set(gate.id, gate);
        notifyHumanBeads(new Map([[gate.id, gate]]), locations.worktreePath);
        return { status: 'human' };
      } catch {
        return { status: 'blocked' };
      }
    }
    if (result.kind !== 'success') {
      const detail = workerResultProblemDetail(result);
      report(`gis: worker result ${result.kind} for ${bead.id}: ${detail}`);
      await beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }

    const verifyImplementation = async (): Promise<'verified' | 'blocked'> => {
      const verification = await verify.verify({
        bead,
        worktreePath: worktree.path,
        runPath: worktree.runPath,
        transcriptPath: await currentTranscriptPath(),
        resolveTranscriptPath: currentTranscriptPath,
        config,
        beads,
        target: agentName,
        herdr,
        waitForWorker: async () => {
          const retry = await blocked.wait(waitOptions);
          if (retry.status === 'blocked') {
            throw new AlreadyBlockedError(retry.bead ?? bead);
          }
        },
      });
      return verification.status;
    };

    try {
      if ((await verifyImplementation()) === 'blocked') {
        return { status: 'blocked' };
      }

      if (config.review) {
        const reviewerTranscriptPath = (
          reviewer: StartedReviewer,
        ): Promise<string> =>
          resolveWorkerTranscriptPath(
            reviewer.selection.result,
            reviewer.agentName,
            reviewer.selection.candidate.kind,
            worktree.path,
            herdr,
            resolveTranscript,
          );
        const reviewOutcome = await runReviewLoop({
          bead,
          worktree,
          config,
          implementation: {
            agentName,
            kind: workerKind!,
            candidate: implementationCandidate,
          },
          herdr: herdr as ReviewHerdrSource,
          beads,
          blocked,
          implementationWaitOptions: waitOptions,
          implementationHandoff: currentHandoff,
          reviewerTranscriptPath,
          verifyImplementation,
          onHumanGate: (gate, locations) => {
            humanFromWorkers.set(gate.id, gate);
            notifyHumanBeads(
              new Map([[gate.id, gate]]),
              locations.worktreePath,
            );
          },
          report,
        });
        if (reviewOutcome !== 'approved') {
          return { status: reviewOutcome };
        }
      }

      const finalTranscriptPath = await currentTranscriptPath();
      const mergeResult = await merge.enqueue({
        bead,
        worktree,
        transcriptPath: finalTranscriptPath,
      });
      if (mergeResult.status === 'merged') {
        if (mergeResult.stateError !== undefined) {
          report(
            `gis: main contains ${bead.id}, but closing the Beads issue failed; ` +
              'the worktree was retained for manual reconciliation',
          );
        }
        if (mergeResult.cleanupError !== undefined) {
          report(
            `gis: cleanup failed for ${bead.id}; main and bd are merged, ` +
              'but the worktree was retained for manual recovery',
          );
        }
        return { status: 'merged' };
      }
      return { status: 'blocked' };
    } catch (error: unknown) {
      if (error instanceof AlreadyBlockedError) {
        return { status: 'blocked' };
      }
      await beads.markBlocked(bead.id, await currentHandoff());
      return { status: 'blocked' };
    }
  };

  const processBeadSafely = async (bead: Bead): Promise<JobOutcome> => {
    try {
      return await processBead(bead);
    } catch (error: unknown) {
      report(
        `gis: job ${bead.id} failed while recording recovery state: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return { status: 'blocked' };
    }
  };

  while (true) {
    const ready = dispatchableReady(await beads.ready());
    for (const bead of ready) {
      if (active.size >= config.concurrency) {
        break;
      }
      if (active.has(bead.id)) {
        continue;
      }
      const job = processBeadSafely(bead);
      active.set(bead.id, job);
    }

    if (active.size === 0) {
      const humanBeads = await openHumanBeads();
      notifyHumanBeads(humanBeads, cwd);
      if (humanBeads.size === 0 || beads.listHuman === undefined) {
        if (waitingForHuman && beads.listHuman !== undefined) {
          waitingForHuman = false;
          continue;
        }
        break;
      }
      waitingForHuman = true;
      await delay(humanPollIntervalMs);
      continue;
    }

    const completed = await Promise.race(
      [...active.entries()].map(async ([id, job]) => ({
        id,
        outcome: await job,
      })),
    );
    active.delete(completed.id);
    if (completed.outcome.status === 'merged') {
      merged += 1;
    } else if (completed.outcome.status === 'blocked') {
      blockedCount += 1;
    }
  }

  const remainingHumanBeads = await openHumanBeads();
  notifyHumanBeads(remainingHumanBeads, cwd);
  const summary = {
    merged,
    blocked: blockedCount,
    humanWaiting: remainingHumanBeads.size,
  };
  const result = { ...summary, text: formatRunSummary(summary) };
  report(result.text);
  return result;
}

export const runOrchestration = runForegroundLoop;
export const runLoop = runForegroundLoop;
