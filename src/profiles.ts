import type { Bead } from "./beads.js";
import type {
  ClaudePermissionMode,
  GisConfig,
  ProfileCandidate,
  ProfileConfig,
  ProfileName,
} from "./config.js";

export type ProfileBead = Pick<Bead, "issue_type" | "labels">;

export interface CandidateSelectionOptions {
  /** Kinds with an available worker slot. Omit to consider every candidate. */
  readonly availableKinds?: readonly string[] | ReadonlySet<string>;
  /** Kinds that must not be selected, for example the implementation kind during review. */
  readonly excludeKinds?: readonly string[] | ReadonlySet<string>;
  /** Return false to stop fallback and surface this startup error immediately. */
  readonly shouldFallback?: (error: unknown) => boolean;
}

export interface ProfileStartResult<T> {
  readonly profile: ProfileName;
  readonly candidate: ProfileCandidate;
  readonly result: T;
  readonly attempts: number;
}

export type ProfileAgentStarter<T> = (
  candidate: ProfileCandidate,
  args: readonly string[],
) => Promise<T>;

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(`profile resolution failed: ${message}`);
    this.name = "ProfileResolutionError";
  }
}

const PROFILE_NAMES: readonly ProfileName[] = ["plan", "implement", "review"];
const PROFILE_LABEL_PREFIX = "profile:";

function isProfileName(value: string): value is ProfileName {
  return PROFILE_NAMES.includes(value as ProfileName);
}

function includesKind(
  kinds: readonly string[] | ReadonlySet<string> | undefined,
  kind: string,
): boolean {
  if (kinds === undefined) {
    return false;
  }
  return Array.isArray(kinds)
    ? (kinds as readonly string[]).includes(kind)
    : (kinds as ReadonlySet<string>).has(kind);
}

function isAvailable(
  kinds: readonly string[] | ReadonlySet<string> | undefined,
  kind: string,
): boolean {
  return kinds === undefined || includesKind(kinds, kind);
}

function profileLabel(labels: readonly string[] | undefined): ProfileName | undefined {
  let override: ProfileName | undefined;

  for (const label of labels ?? []) {
    if (!label.startsWith(PROFILE_LABEL_PREFIX)) {
      continue;
    }

    const name = label.slice(PROFILE_LABEL_PREFIX.length);
    if (!isProfileName(name)) {
      throw new ProfileResolutionError(`unsupported profile label ${label}`);
    }
    if (override !== undefined && override !== name) {
      throw new ProfileResolutionError(
        `conflicting profile labels profile:${override} and profile:${name}`,
      );
    }
    override = name;
  }

  return override;
}

/** Resolve a bead to its deterministic worker profile. */
export function resolveProfileName(bead: ProfileBead): ProfileName {
  const override = profileLabel(bead.labels);
  if (override !== undefined) {
    return override;
  }

  return bead.issue_type === "decision" || bead.issue_type === "epic" ? "plan" : "implement";
}

/** Short alias for callers that already use the profile terminology. */
export const resolveProfile = resolveProfileName;

export function selectProfileCandidate(
  candidates: readonly ProfileCandidate[],
  options: CandidateSelectionOptions = {},
): ProfileCandidate {
  for (const candidate of candidates) {
    if (!isAvailable(options.availableKinds, candidate.kind)) {
      continue;
    }
    if (includesKind(options.excludeKinds, candidate.kind)) {
      continue;
    }
    return candidate;
  }

  throw new ProfileResolutionError("no profile candidate has an available worker slot");
}

export function resolveProfileCandidate(
  bead: ProfileBead,
  config: Pick<GisConfig, "profiles" | "kinds">,
  options: CandidateSelectionOptions = {},
): ProfileCandidate {
  const profile = resolveProfileName(bead);
  return selectProfileCandidate(config.profiles[profile], {
    ...options,
    availableKinds: options.availableKinds ?? config.kinds,
  });
}

function permissionMode(
  config: Pick<GisConfig, "claude_permission_mode"> | ClaudePermissionMode,
): ClaudePermissionMode {
  return typeof config === "string" ? config : config.claude_permission_mode;
}

/** Build the arguments appended after `herdr agent start ... --`. */
export function buildAgentStartArgs(
  candidate: ProfileCandidate,
  config: Pick<GisConfig, "claude_permission_mode"> | ClaudePermissionMode,
): string[] {
  if (candidate.kind === "claude") {
    return [
      "--model",
      candidate.model,
      "--effort",
      candidate.effort,
      "--permission-mode",
      permissionMode(config),
    ];
  }

  if (candidate.kind === "codex") {
    return [
      "-m",
      candidate.model,
      "-c",
      `model_reasoning_effort=\"${candidate.effort}\"`,
      "-a",
      "on-request",
      "-s",
      "workspace-write",
    ];
  }

  // Other kinds are intentionally passed through without runner-specific flags.
  // Adding a kind to config should not require gis to know that runner's CLI.
  return [];
}

export const buildStartArgs = buildAgentStartArgs;

/**
 * Start a worker using the first available profile candidate and fall back only
 * when the start operation itself rejects. No pane output or result files are
 * inspected here.
 */
export async function startWithProfileFallback<T>(
  bead: ProfileBead,
  config: Pick<GisConfig, "profiles" | "kinds" | "claude_permission_mode">,
  start: ProfileAgentStarter<T>,
  options: CandidateSelectionOptions = {},
): Promise<ProfileStartResult<T>> {
  const profile = resolveProfileName(bead);
  const candidates = config.profiles[profile];
  let attempts = 0;
  let lastError: unknown;
  let hasError = false;

  for (const candidate of candidates) {
    if (!isAvailable(options.availableKinds ?? config.kinds, candidate.kind) ||
        includesKind(options.excludeKinds, candidate.kind)) {
      continue;
    }

    attempts += 1;
    try {
      const result = await start(candidate, buildAgentStartArgs(candidate, config));
      return { profile, candidate, result, attempts };
    } catch (error: unknown) {
      if (options.shouldFallback !== undefined && !options.shouldFallback(error)) {
        throw error;
      }
      hasError = true;
      lastError = error;
    }
  }

  if (hasError) {
    throw lastError;
  }
  throw new ProfileResolutionError("no profile candidate has an available worker slot");
}

export function profileCandidates(
  config: ProfileConfig,
  profile: ProfileName,
): readonly ProfileCandidate[] {
  return config[profile];
}
