import { parse as parseToml } from "@iarna/toml";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_PATH = [".gis", "config.toml"] as const;

export type ClaudePermissionMode = "auto" | "acceptEdits";
export type ProfileName = "plan" | "implement" | "review";

export interface ProfileCandidate {
  readonly kind: string;
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ProfileConfig {
  readonly plan: readonly ProfileCandidate[];
  readonly implement: readonly ProfileCandidate[];
  readonly review: readonly ProfileCandidate[];
}

export interface GisConfig {
  readonly concurrency: number;
  readonly base: string;
  readonly verify: string;
  readonly kinds: readonly string[];
  readonly review: boolean;
  readonly verify_max: number;
  readonly review_max: number;
  readonly blocked_timeout: string;
  readonly worker_timeout: string;
  readonly verify_timeout: string;
  readonly claude_permission_mode: ClaudePermissionMode;
  readonly profiles: ProfileConfig;
}

export type ConfigWarningSink = (message: string) => void;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`invalid gis configuration: ${message}`, options);
    this.name = "ConfigError";
  }
}

const DEFAULT_PROFILES: ProfileConfig = {
  plan: [
    { kind: "claude", model: "opus", effort: "medium" },
    { kind: "codex", model: "gpt-5.6-sol", effort: "high" },
  ],
  implement: [
    { kind: "codex", model: "gpt-5.6-luna", effort: "xhigh" },
    { kind: "claude", model: "opus", effort: "xhigh" },
  ],
  review: [
    { kind: "claude", model: "opus", effort: "xhigh" },
    { kind: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
  ],
};

export const DEFAULT_CONFIG: GisConfig = {
  concurrency: 1,
  base: "main",
  verify: "npm test",
  kinds: ["claude", "codex"],
  review: false,
  verify_max: 5,
  review_max: 3,
  blocked_timeout: "15m",
  worker_timeout: "1h",
  verify_timeout: "15m",
  claude_permission_mode: "auto",
  profiles: DEFAULT_PROFILES,
};

const TOP_LEVEL_KEYS = new Set([
  "concurrency",
  "base",
  "verify",
  "kinds",
  "review",
  "verify_max",
  "review_max",
  "blocked_timeout",
  "worker_timeout",
  "verify_timeout",
  "claude_permission_mode",
  "profiles",
]);
const PROFILE_KEYS = new Set(["kind", "model", "effort"]);
const PROFILE_NAMES: readonly ProfileName[] = ["plan", "implement", "review"];
const EFFORTS = new Set<ProfileCandidate["effort"]>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new ConfigError(`${path} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${path}.${key} is not supported`);
    }
  }
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function asPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${path} must be a positive integer`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${path} must be a non-empty array of strings`);
  }
  return value.map((item, index) => asString(item, `${path}[${index}]`));
}

function asBlockedTimeout(value: unknown): string {
  const timeout = asString(value, "blocked_timeout");
  if (!/^(?:[1-9]\d*)(?:ms|s|m|h|d)$/.test(timeout)) {
    throw new ConfigError(
      "blocked_timeout must be a positive duration such as 500ms, 15s, 15m, or 1h",
    );
  }
  return timeout;
}

function asTimeout(value: unknown, path: string): string {
  const timeout = asString(value, path);
  if (!/^(?:[1-9]\d*)(?:ms|s|m|h|d)$/.test(timeout)) {
    throw new ConfigError(
      `${path} must be a positive duration such as 500ms, 15s, 15m, or 1h`,
    );
  }
  return timeout;
}

function asWorkerTimeout(value: unknown): string {
  const timeout = asTimeout(value, "worker_timeout");
  if (parseDurationMs(timeout, "worker_timeout") <= 3_000) {
    throw new ConfigError("worker_timeout must be greater than 3000ms for herdr agent.start");
  }
  return timeout;
}

const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convert a validated gis duration to milliseconds for subprocess/API timeouts. */
export function parseDurationMs(value: string, name: string): number {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(value);
  if (match === null) {
    throw new RangeError(`${name} must be a positive duration`);
  }
  const milliseconds = Number(match[1]) * DURATION_MULTIPLIERS[match[2]];
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError(`${name} is too large`);
  }
  return milliseconds;
}

function asPermissionMode(value: unknown): ClaudePermissionMode {
  if (value !== "auto" && value !== "acceptEdits") {
    throw new ConfigError("claude_permission_mode must be auto or acceptEdits");
  }
  return value;
}

function cloneProfiles(profiles: ProfileConfig): ProfileConfig {
  return {
    plan: profiles.plan.map((candidate) => ({ ...candidate })),
    implement: profiles.implement.map((candidate) => ({ ...candidate })),
    review: profiles.review.map((candidate) => ({ ...candidate })),
  };
}

function asProfileCandidate(value: unknown, path: string): ProfileCandidate {
  const record = asRecord(value, path);
  assertKnownKeys(record, PROFILE_KEYS, path);
  const effort = asString(record.effort, `${path}.effort`);
  if (!EFFORTS.has(effort as ProfileCandidate["effort"])) {
    throw new ConfigError(`${path}.effort must be one of low, medium, high, xhigh, or max`);
  }

  return {
    kind: asString(record.kind, `${path}.kind`),
    model: asString(record.model, `${path}.model`),
    effort: effort as ProfileCandidate["effort"],
  };
}

function asProfileList(value: unknown, name: ProfileName): ProfileCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`profiles.${name} must be a non-empty array of candidates`);
  }
  return value.map((candidate, index) => asProfileCandidate(candidate, `profiles.${name}[${index}]`));
}

function asProfiles(value: unknown): ProfileConfig {
  if (value === undefined) {
    return cloneProfiles(DEFAULT_PROFILES);
  }

  const record = asRecord(value, "profiles");
  assertKnownKeys(record, new Set(PROFILE_NAMES), "profiles");
  const defaults = cloneProfiles(DEFAULT_PROFILES);
  return {
    plan: record.plan === undefined ? defaults.plan : asProfileList(record.plan, "plan"),
    implement: record.implement === undefined
      ? defaults.implement
      : asProfileList(record.implement, "implement"),
    review: record.review === undefined ? defaults.review : asProfileList(record.review, "review"),
  };
}

export function parseConfig(contents: string): GisConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch (error: unknown) {
    throw new ConfigError(error instanceof Error ? error.message : String(error), { cause: error });
  }

  const source = asRecord(parsed, "config");
  assertKnownKeys(source, TOP_LEVEL_KEYS, "config");
  const profiles = asProfiles(source.profiles);

  return {
    concurrency: source.concurrency === undefined
      ? DEFAULT_CONFIG.concurrency
      : asPositiveInteger(source.concurrency, "concurrency"),
    base: source.base === undefined ? DEFAULT_CONFIG.base : asString(source.base, "base"),
    verify: source.verify === undefined ? DEFAULT_CONFIG.verify : asString(source.verify, "verify"),
    kinds: source.kinds === undefined
      ? [...DEFAULT_CONFIG.kinds]
      : asStringArray(source.kinds, "kinds"),
    review: source.review === undefined ? DEFAULT_CONFIG.review : asBoolean(source.review, "review"),
    verify_max: source.verify_max === undefined
      ? DEFAULT_CONFIG.verify_max
      : asPositiveInteger(source.verify_max, "verify_max"),
    review_max: source.review_max === undefined
      ? DEFAULT_CONFIG.review_max
      : asPositiveInteger(source.review_max, "review_max"),
    blocked_timeout: source.blocked_timeout === undefined
      ? DEFAULT_CONFIG.blocked_timeout
      : asBlockedTimeout(source.blocked_timeout),
    worker_timeout: source.worker_timeout === undefined
      ? DEFAULT_CONFIG.worker_timeout
      : asWorkerTimeout(source.worker_timeout),
    verify_timeout: source.verify_timeout === undefined
      ? DEFAULT_CONFIG.verify_timeout
      : asTimeout(source.verify_timeout, "verify_timeout"),
    claude_permission_mode: source.claude_permission_mode === undefined
      ? DEFAULT_CONFIG.claude_permission_mode
      : asPermissionMode(source.claude_permission_mode),
    profiles,
  };
}

export async function readConfig(cwd: string = process.cwd()): Promise<string> {
  return readFile(resolve(cwd, ...CONFIG_PATH), "utf8");
}

export async function loadConfig(
  cwd: string = process.cwd(),
  warn: ConfigWarningSink = (message) => console.warn(message),
): Promise<GisConfig> {
  const config = parseConfig(await readConfig(cwd));
  if (config.review) {
    warn("review=true is not implemented yet");
  }
  return config;
}
