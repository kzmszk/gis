import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, parseConfig } from '../dist/config.js';
import {
  buildAgentStartArgs,
  resolveProfileCandidate,
  resolveProfileName,
  selectProfileCandidate,
  startWithProfileFallback,
} from '../dist/profiles.js';

const task = (overrides = {}) => ({
  id: 'gis-vst.test',
  title: 'profile test',
  description: 'profile test bead',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  ...overrides,
});
test('resolves plan and implement profiles from bead type', () => {
  assert.equal(resolveProfileName(task({ issue_type: 'decision' })), 'plan');
  assert.equal(resolveProfileName(task({ issue_type: 'epic' })), 'plan');
  assert.equal(resolveProfileName(task()), 'implement');
});

test('profile labels override the bead type', () => {
  assert.equal(
    resolveProfileName(
      task({
        issue_type: 'decision',
        labels: ['area:runtime', 'profile:implement'],
      }),
    ),
    'implement',
  );
  assert.equal(resolveProfileName(task({ labels: ['profile:plan'] })), 'plan');
});

test('selects the first candidate with an available slot', () => {
  const candidates = [
    { kind: 'claude', model: 'opus', effort: 'high' },
    { kind: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' },
  ];

  assert.deepEqual(
    selectProfileCandidate(candidates, { availableKinds: ['codex'] }),
    candidates[1],
  );
  assert.deepEqual(
    selectProfileCandidate(candidates, {
      availableKinds: ['claude', 'codex'],
      excludeKinds: ['claude'],
    }),
    candidates[1],
  );
  assert.throws(
    () => selectProfileCandidate(candidates, { availableKinds: ['pi'] }),
    /no profile candidate has an available worker slot/,
  );
});

test('resolves an available candidate from config', () => {
  const config = parseConfig(`
kinds = ["codex"]
[[profiles.plan]]
kind = "claude"
model = "opus"
effort = "medium"
[[profiles.plan]]
kind = "codex"
model = "gpt-5.6-sol"
effort = "high"
`);

  assert.deepEqual(
    resolveProfileCandidate(task({ issue_type: 'decision' }), config),
    { kind: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
  );
});

test('builds runner-specific trailing arguments', () => {
  assert.deepEqual(
    buildAgentStartArgs(
      { kind: 'claude', model: 'opus', effort: 'xhigh' },
      { claude_permission_mode: 'acceptEdits' },
    ),
    [
      '--model',
      'opus',
      '--effort',
      'xhigh',
      '--permission-mode',
      'acceptEdits',
    ],
  );
  assert.deepEqual(
    buildAgentStartArgs(
      { kind: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' },
      DEFAULT_CONFIG,
    ),
    [
      '-m',
      'gpt-5.6-luna',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-a',
      'on-request',
      '-s',
      'workspace-write',
    ],
  );
  assert.deepEqual(
    buildAgentStartArgs(
      { kind: 'future-agent', model: 'future-model', effort: 'high' },
      DEFAULT_CONFIG,
    ),
    [],
  );
});

test('falls back to the next candidate only after a start failure', async () => {
  const config = parseConfig(`
kinds = ["claude", "codex"]
[[profiles.implement]]
kind = "claude"
model = "opus"
effort = "xhigh"
[[profiles.implement]]
kind = "codex"
model = "gpt-5.6-luna"
effort = "xhigh"
`);
  const attempts = [];

  const started = await startWithProfileFallback(
    task(),
    config,
    async (candidate, args) => {
      attempts.push({ candidate, args });
      if (attempts.length === 1) {
        throw new Error('claude could not start');
      }
      return 'pane-2';
    },
  );

  assert.equal(started.profile, 'implement');
  assert.equal(started.candidate.kind, 'codex');
  assert.equal(started.result, 'pane-2');
  assert.equal(started.attempts, 2);
  assert.deepEqual(
    attempts.map(({ candidate }) => candidate.kind),
    ['claude', 'codex'],
  );
  assert.deepEqual(attempts[1].args, [
    '-m',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="xhigh"',
    '-a',
    'on-request',
    '-s',
    'workspace-write',
  ]);
});

test('does not try unavailable candidates during fallback', async () => {
  const attempts = [];
  const result = await startWithProfileFallback(
    task(),
    DEFAULT_CONFIG,
    async (candidate) => {
      attempts.push(candidate.kind);
      return candidate.kind;
    },
    { availableKinds: ['codex'] },
  );

  assert.equal(result.candidate.kind, 'codex');
  assert.deepEqual(attempts, ['codex']);
});

test('uses an explicit pipeline profile when returning a start result', async () => {
  const config = parseConfig(`
kinds = ["claude", "codex"]
[[profiles.implement]]
kind = "codex"
model = "implementation"
effort = "low"
[[profiles.review]]
kind = "claude"
model = "review"
effort = "high"
`);
  const result = await startWithProfileFallback(
    task(),
    config,
    async (candidate) => candidate.model,
    { profile: 'review' },
  );

  assert.equal(result.profile, 'review');
  assert.equal(result.candidate.kind, 'claude');
  assert.equal(result.result, 'review');
});
