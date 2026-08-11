import { resolve } from 'node:path';
import type { Bead } from './beads.js';
import { createBeadsAdapter } from './beads.js';
import type { GisConfig } from './config.js';
import { loadConfig } from './config.js';
import { createHerdrAdapter } from './herdr.js';
import type { AgentSessionInfo } from './herdr.js';
import { SerialMergeQueue } from './merge.js';
import { resolveAgentSessionTranscript } from './transcripts.js';
import { waitForAgentWithBlockedHandling } from './blocked.js';
import { runVerificationLoop } from './verify.js';
import { createBeadWorktree } from './worktree.js';
import type { CreateBeadWorktreeOptions } from './worktree.js';
import { startWorker } from './worker.js';
import {
  createBeadJobProcessor,
  type BeadJobBeadsSource,
  type BeadJobBlockedSource,
  type BeadJobHerdrSource,
  type BeadJobMergeSource,
  type BeadJobVerifySource,
  type BeadJobWorkerSource,
  type BeadJobWorktreeSource,
  type JobOutcome,
} from './run-worker.js';
import { assertNever, delay } from './internal.js';

export interface RunBeadsSource extends BeadJobBeadsSource {
  ready(): Promise<readonly Bead[]>;
  markMerged(issueId: string, reason?: string): Promise<Bead>;
  listHuman?(): Promise<readonly Bead[]>;
}

export type RunHerdrSource = BeadJobHerdrSource;

export type RunWorktreeSource = BeadJobWorktreeSource;

export type RunWorkerSource = BeadJobWorkerSource;

export type RunBlockedSource = BeadJobBlockedSource;

export type RunVerifySource = BeadJobVerifySource;

export type RunMergeSource = BeadJobMergeSource;

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

function summaryText(
  merged: number,
  blocked: number,
  humanWaiting: number,
): string {
  return `${merged}件マージ / ${blocked}件 blocked / ${humanWaiting}件が人間の確認待ち`;
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

  const processBead = createBeadJobProcessor({
    cwd,
    config,
    beads,
    herdr,
    worktrees,
    workers,
    blocked,
    verify,
    merge,
    resolveTranscript,
    report,
    onHumanGate: (gate, locations) => {
      humanFromWorkers.set(gate.id, gate);
      notifyHumanBeads(new Map([[gate.id, gate]]), locations.worktreePath);
    },
  });

  while (true) {
    const ready = dispatchableReady(await beads.ready());
    for (const bead of ready) {
      if (active.size >= config.concurrency) {
        break;
      }
      if (active.has(bead.id)) {
        continue;
      }
      active.set(bead.id, processBead(bead));
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
    switch (completed.outcome.status) {
      case 'merged':
        merged += 1;
        break;
      case 'blocked':
        blockedCount += 1;
        break;
      case 'human':
        break;
      default:
        assertNever(completed.outcome, 'unhandled job outcome');
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
