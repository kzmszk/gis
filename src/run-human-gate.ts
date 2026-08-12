import { resolve } from 'node:path';
import type { Bead } from './beads.js';

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

/**
 * Tracks open "human checkpoint" beads across a foreground run and decides
 * what the dispatch loop should do when it goes idle (no active jobs).
 *
 * Interface:
 * - `recordFromWorker(bead, worktreePath)`: called when a worker itself
 *   raises a human gate (as opposed to it being discovered via
 *   `beads.listHuman`). Immediately notifies for that bead.
 * - `refreshAndNotify(beadsSource, repositoryPath)`: returns the current set
 *   of open human-gate beads and, in the same call, notifies for any of them
 *   not already notified. If `beadsSource` exposes `listHuman`, that is the
 *   source of truth (filtered to `status === 'open'`); otherwise falls back
 *   to the beads this tracker has seen reported by workers. Also records,
 *   for the next `evaluateIdle` call, whether `listHuman` was available —
 *   that fact is intrinsic to `beadsSource` and does not change within a
 *   run. Invariant: a given bead id is only ever notified once for the
 *   lifetime of this tracker, regardless of how many times it appears in
 *   later snapshots.
 * - `evaluateIdle(gates)`: given the set of open gates just returned by
 *   `refreshAndNotify`, decides the loop action and updates internal
 *   "waiting" state accordingly:
 *     - `'stop'`   — no reason to keep looping; the caller should exit.
 *     - `'retry'`  — a previous wait resolved (gates cleared); the caller
 *                    should re-check for newly-dispatchable work rather than
 *                    exit, since closing a human gate may unblock beads.
 *     - `'poll'`   — gates are still open and polling is supported; the
 *                    caller should wait and re-check.
 *   Calling `evaluateIdle` mutates internal state and is not idempotent —
 *   call it exactly once per idle check, after `refreshAndNotify`.
 *
 * Deletion test: removing this module pushes the notified-id bookkeeping,
 * the listHuman-vs-worker-reported fallback, and the
 * stop/retry/poll idle decision back into the caller's dispatch loop, where
 * they previously accounted for most of its branching.
 */
export class HumanGateTracker {
  private readonly fromWorkers = new Map<string, Bead>();
  private readonly notifiedIds = new Set<string>();
  private waiting = false;
  private hasListHuman = false;

  constructor(private readonly report: (message: string) => void) {}

  recordFromWorker(bead: Bead, worktreePath: string): void {
    this.fromWorkers.set(bead.id, bead);
    this.notify(new Map([[bead.id, bead]]), worktreePath);
  }

  async refreshAndNotify(
    beadsSource: { listHuman?(): Promise<readonly Bead[]> },
    repositoryPath: string,
  ): Promise<Map<string, Bead>> {
    // Call `beadsSource.listHuman()` as a method (not via a destructured
    // reference) so adapters that rely on their own `this` keep working.
    this.hasListHuman = beadsSource.listHuman !== undefined;
    let gates: Map<string, Bead>;
    if (beadsSource.listHuman !== undefined) {
      gates = new Map(
        (await beadsSource.listHuman())
          .filter((bead) => bead.status === 'open')
          .map((bead) => [bead.id, bead]),
      );
    } else {
      gates = new Map(this.fromWorkers);
    }
    this.notify(gates, repositoryPath);
    return gates;
  }

  private notify(
    gates: ReadonlyMap<string, Bead>,
    repositoryPath: string,
  ): void {
    const unnotified = [...gates.values()].filter(
      (bead) => !this.notifiedIds.has(bead.id),
    );
    if (unnotified.length === 0) return;
    this.report(formatHumanGateNotification(unnotified, repositoryPath));
    for (const bead of unnotified) this.notifiedIds.add(bead.id);
  }

  evaluateIdle(gates: ReadonlyMap<string, Bead>): 'stop' | 'retry' | 'poll' {
    if (gates.size === 0 || !this.hasListHuman) {
      // `this.waiting` can only have been set true while `hasListHuman` was
      // true (see the `poll` branch below), and `hasListHuman` is fixed for
      // the lifetime of a run, so it is already implied here — no need to
      // re-check it.
      if (this.waiting) {
        this.waiting = false;
        return 'retry';
      }
      return 'stop';
    }
    this.waiting = true;
    return 'poll';
  }
}
