import type { Bead, BeadHandoffLocations } from "./beads.js";
import { HerdrProtocolError } from "./herdr.js";
import type { AgentStatus, AgentWaitOptions, AgentWaitResult } from "./herdr.js";

export interface BlockedHerdrSource {
  agentWait(target: string, options?: AgentWaitOptions): Promise<AgentWaitResult>;
}
export interface BlockedBeadsSource {
  markBlocked(issueId: string, locations: BeadHandoffLocations): Promise<Bead>;
}

export interface BlockedHandlingOptions {
  /** Bead whose worker is being observed. */
  readonly beadId: string;
  /** Herdr agent name or other supported wait target. */
  readonly target: string;
  /** The worktree and handoff paths are deliberately kept, not removed. */
  readonly worktreePath: string;
  readonly roundLogPath: string;
  readonly transcriptPath: string;
  /** Duration for which a human may resume a blocked worker. */
  readonly blockedTimeout: string;
  readonly herdr: BlockedHerdrSource;
  readonly beads: BlockedBeadsSource;
  /** Called as soon as a blocked event is observed. */
  readonly notify?: (message: string) => void;
}

export interface AgentWaitHandlingResult {
  readonly status: "done" | "blocked";
  /** Whether the worker entered blocked and was offered to a human. */
  readonly wasBlocked: boolean;
  /** True when the handler leaves the pane/worktree available for a human. */
  readonly worktreeRetained: boolean;
  /** The updated bead is present only after the timeout escalation. */
  readonly bead?: Bead;
}

const DURATION_PATTERN = /^(?<amount>[1-9]\d*)(?<unit>ms|s|m|h|d)$/;
const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convert the config duration syntax into milliseconds for herdr. */
export function parseBlockedTimeout(value: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("blockedTimeout must be a non-empty duration");
  }

  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError("blockedTimeout must be a positive duration such as 500ms, 15s, 15m, or 1h");
  }

  const amount = Number(match.groups?.amount);
  const multiplier = DURATION_MULTIPLIERS[match.groups?.unit ?? ""];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError("blockedTimeout is too large");
  }
  return milliseconds;
}

export function formatBlockedNotification(options: Pick<
  BlockedHandlingOptions,
  "beadId" | "target" | "worktreePath" | "blockedTimeout"
>): string {
  return [
    `agent ${options.target} for bead ${options.beadId} is blocked`,
    `keeping pane and worktree ${options.worktreePath} for human intervention`,
    `waiting up to ${options.blockedTimeout}`,
  ].join("; ");
}

function statusFromWait(result: AgentWaitResult): AgentStatus {
  const status = result.event.data.agent_status;
  if (status === "done" || status === "blocked") {
    return status;
  }
  throw new HerdrProtocolError(
    `agent.wait did not report done or blocked (received ${String(status)})`,
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return (typeof code === "string" && /timeout|timed[_-]?out/i.test(code)) ||
    /timed?\s*out|time[- ]?out/i.test(error.message);
}

async function markBlocked(
  options: BlockedHandlingOptions,
): Promise<AgentWaitHandlingResult> {
  const locations: BeadHandoffLocations = {
    worktreePath: options.worktreePath,
    roundLogPath: options.roundLogPath,
    transcriptPath: options.transcriptPath,
  };
  const bead = await options.beads.markBlocked(options.beadId, locations);
  return {
    status: "blocked",
    wasBlocked: true,
    worktreeRetained: true,
    bead,
  };
}

/**
 * Wait for an agent and handle herdr's blocked state without answering it.
 *
 * A blocked event is reported immediately. The second wait only watches for
 * `done`, so a blocked worker is given the configured timeout to be resumed by
 * a human. This function never prompts an agent and never removes a worktree.
 */
export async function waitForAgentWithBlockedHandling(
  options: BlockedHandlingOptions,
): Promise<AgentWaitHandlingResult> {
  const initial = await options.herdr.agentWait(options.target, {
    until: ["done", "blocked"],
  });
  const initialStatus = statusFromWait(initial);

  if (initialStatus === "done") {
    return { status: "done", wasBlocked: false, worktreeRetained: false };
  }

  const notify = options.notify ?? ((message: string) => console.warn(`gis: ${message}`));
  notify(formatBlockedNotification(options));

  const timeoutMs = parseBlockedTimeout(options.blockedTimeout);
  try {
    const resumed = await options.herdr.agentWait(options.target, {
      until: ["done"],
      timeoutMs,
    });
    const resumedStatus = statusFromWait(resumed);
    if (resumedStatus === "done") {
      return { status: "done", wasBlocked: true, worktreeRetained: true };
    }

    // A compliant herdr endpoint should return a timeout error because this
    // wait excludes blocked. Treat an explicit blocked result as still blocked
    // rather than ever sending an automatic response.
    return markBlocked(options);
  } catch (error: unknown) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    return markBlocked(options);
  }
}
