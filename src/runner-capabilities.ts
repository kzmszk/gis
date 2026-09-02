import type { ProfileCandidate } from './config.js';

type Effort = ProfileCandidate['effort'];

const RUNNER_EFFORTS: Readonly<Record<string, ReadonlySet<Effort>>> = {
  agy: new Set<Effort>(['low', 'medium', 'high']),
};

/** Return whether a runner accepts the requested reasoning effort. */
export function supportsRunnerEffort(kind: string, effort: Effort): boolean {
  return RUNNER_EFFORTS[kind]?.has(effort) ?? true;
}

/** Describe a runner-specific effort constraint for configuration errors. */
export function runnerEffortError(
  kind: string,
  effort: Effort,
): string | undefined {
  if (supportsRunnerEffort(kind, effort)) {
    return undefined;
  }
  if (kind === 'agy') {
    return 'effort must be low, medium, or high for agy';
  }
  return `effort ${effort} is not supported by ${kind}`;
}
