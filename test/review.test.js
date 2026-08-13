import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { WorkerStartupError } from '../dist/worker.js';
import {
  parseReviewResult,
  reviewAgentName,
  startReviewer,
} from '../dist/review.js';
import {
  pollUntilTerminal,
  requestedChangesFeedback,
  reviewProblemDetail,
  runReviewLoop,
} from '../dist/review-loop.js';
import { runForegroundLoop } from '../dist/run.js';

const bead = {
  id: 'gis-review.1',
  title: 'review',
  description: 'Review the implementation',
  acceptance_criteria: 'The implementation is correct',
  issue_type: 'task',
  labels: [],
};

function config(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    kinds: ['claude', 'codex'],
    verify: 'npm test',
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      implement: [{ kind: 'codex', model: 'impl', effort: 'low' }],
      review: [
        { kind: 'claude', model: 'review', effort: 'high' },
        { kind: 'codex', model: 'fallback', effort: 'low' },
      ],
    },
    ...overrides,
  };
}

function readySnapshot(agent = {}) {
  return {
    type: 'session_snapshot',
    snapshot: {
      agents: [
        {
          pane_id: 'review-pane',
          name: reviewAgentName(bead.id),
          agent: 'claude',
          agent_status: 'done',
          interactive_ready: true,
          launch_pending: false,
          state_change_seq: 1,
          ...agent,
        },
      ],
    },
  };
}

test('parses reviewer verdicts and rejects malformed review results', () => {
  assert.deepEqual(
    parseReviewResult(
      JSON.stringify({
        run_id: 'run-1',
        status: 'done',
        summary: 'all good',
        verdict: 'approved',
      }),
      'result.json',
      'run-1',
    ),
    {
      kind: 'success',
      result: {
        run_id: 'run-1',
        status: 'done',
        summary: 'all good',
        verdict: 'approved',
      },
    },
  );
  assert.equal(
    parseReviewResult(
      JSON.stringify({
        run_id: 'run-1',
        status: 'done',
        summary: 'fix null handling',
        verdict: 'changes_requested',
        feedback: 'Handle null input before dereferencing it.',
      }),
      'result.json',
      'run-1',
    ).kind,
    'changes_requested',
  );
  assert.equal(
    parseReviewResult('{"status":"done","summary":"missing verdict"}').kind,
    'invalid_schema',
  );
  assert.deepEqual(
    parseReviewResult(
      JSON.stringify({
        run_id: '',
        status: 'nope',
        summary: '',
        verdict: 'nope',
      }),
    ).issues,
    [
      'run_id must be a non-empty string',
      'status must be "done" or "failed"',
      'summary must be a non-empty string',
      'verdict must be "approved" or "changes_requested"',
    ],
  );
});

test('reports each review result schema violation independently', () => {
  const valid = {
    run_id: 'run-1',
    status: 'done',
    summary: 'all good',
    verdict: 'approved',
  };
  const cases = [
    [null, 'review result must be a JSON object'],
    [[], 'review result must be a JSON object'],
    ['review', 'review result must be a JSON object'],
    [42, 'review result must be a JSON object'],
    [true, 'review result must be a JSON object'],
    (() => {
      const value = { ...valid };
      delete value.run_id;
      return [value, 'run_id must be a non-empty string'];
    })(),
    [{ ...valid, run_id: '  ' }, 'run_id must be a non-empty string'],
    [{ ...valid, run_id: 1 }, 'run_id must be a non-empty string'],
    (() => {
      const value = { ...valid };
      delete value.status;
      return [value, 'status must be "done" or "failed"'];
    })(),
    [{ ...valid, status: 'waiting' }, 'status must be "done" or "failed"'],
    [{ ...valid, status: 1 }, 'status must be "done" or "failed"'],
    (() => {
      const value = { ...valid };
      delete value.summary;
      return [value, 'summary must be a non-empty string'];
    })(),
    [{ ...valid, summary: '' }, 'summary must be a non-empty string'],
    [{ ...valid, summary: '  ' }, 'summary must be a non-empty string'],
    [{ ...valid, summary: 1 }, 'summary must be a non-empty string'],
    (() => {
      const value = { ...valid };
      delete value.verdict;
      return [value, 'verdict must be "approved" or "changes_requested"'];
    })(),
    [
      { ...valid, verdict: 'maybe' },
      'verdict must be "approved" or "changes_requested"',
    ],
    [
      { ...valid, verdict: 1 },
      'verdict must be "approved" or "changes_requested"',
    ],
    [
      { ...valid, feedback: '  ' },
      'feedback must be a non-empty string when present',
    ],
    [
      { ...valid, feedback: 1 },
      'feedback must be a non-empty string when present',
    ],
    [
      { ...valid, needs_human: false },
      'needs_human must be a non-empty string when present',
    ],
    [
      { ...valid, needs_human: '  ' },
      'needs_human must be a non-empty string when present',
    ],
  ];

  for (const [value, expectedIssue] of cases) {
    const parsed = parseReviewResult(JSON.stringify(value));
    assert.equal(parsed.kind, 'invalid_schema');
    assert.deepEqual(parsed.issues, [expectedIssue]);
  }
});

test('classifies malformed JSON and terminal review outcomes through the parser', () => {
  const invalidJson = parseReviewResult('{"run_id":', 'review.json');
  assert.equal(invalidJson.kind, 'invalid_json');
  assert.equal(invalidJson.path, 'review.json');
  assert.ok(invalidJson.message.length > 0);

  const failedApproved = parseReviewResult(
    JSON.stringify({
      run_id: 'run-1',
      status: 'failed',
      summary: 'review crashed',
      verdict: 'approved',
    }),
  );
  assert.equal(failedApproved.kind, 'failure');
  assert.equal(failedApproved.result.status, 'failed');
  assert.equal(failedApproved.result.verdict, 'approved');

  const failedChangesRequested = parseReviewResult(
    JSON.stringify({
      run_id: 'run-1',
      status: 'failed',
      summary: 'review crashed',
      verdict: 'changes_requested',
    }),
  );
  assert.equal(failedChangesRequested.kind, 'failure');
  assert.equal(failedChangesRequested.result.verdict, 'changes_requested');

  const changesRequested = parseReviewResult(
    JSON.stringify({
      run_id: 'run-1',
      status: 'done',
      summary: 'fix needed',
      verdict: 'changes_requested',
    }),
  );
  assert.equal(changesRequested.kind, 'changes_requested');
  assert.equal(changesRequested.result.feedback, undefined);

  const needsHuman = parseReviewResult(
    JSON.stringify({
      run_id: 'run-1',
      status: 'failed',
      summary: 'review paused',
      verdict: 'changes_requested',
      needs_human: 'choose whether to continue',
    }),
  );
  assert.equal(needsHuman.kind, 'needs_human');
  assert.equal(needsHuman.reason, 'choose whether to continue');
});

test('accepts unknown review result fields for forward compatibility', () => {
  const parsed = parseReviewResult(
    JSON.stringify({
      run_id: 'run-1',
      status: 'done',
      summary: 'all good',
      verdict: 'approved',
      future_field: { supported: true },
    }),
  );

  assert.equal(parsed.kind, 'success');
  assert.equal(parsed.result.future_field.supported, true);
});

test('classifies every non-success review result without nested conditionals', () => {
  assert.equal(
    requestedChangesFeedback({
      kind: 'changes_requested',
      result: {
        status: 'done',
        summary: 'summary fallback',
        verdict: 'changes_requested',
        feedback: '  concrete finding  ',
      },
    }),
    'concrete finding',
  );
  assert.equal(
    requestedChangesFeedback({
      kind: 'changes_requested',
      result: {
        status: 'done',
        summary: 'summary fallback',
        verdict: 'changes_requested',
      },
    }),
    'summary fallback',
  );

  const problems = [
    [
      { kind: 'failure', result: { summary: 'failed review' } },
      'failed review',
    ],
    [
      { kind: 'invalid_schema', issues: ['missing verdict'] },
      'missing verdict',
    ],
    [{ kind: 'invalid_json', message: 'bad JSON' }, 'bad JSON'],
    [
      { kind: 'stale', path: '/tmp/stale.json' },
      'result file belongs to another run: /tmp/stale.json',
    ],
    [
      { kind: 'missing', path: '/tmp/missing.json' },
      'result file is missing: /tmp/missing.json',
    ],
  ];
  for (const [problem, expected] of problems) {
    assert.equal(reviewProblemDetail(problem), expected);
  }
});

test('starts review in a split pane and prefers a different kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-start-'));
  const calls = [];
  let snapshots = 0;
  try {
    const started = await startReviewer({
      bead,
      worktreePath: root,
      runPath: join(root, '.gis', 'run'),
      implementationPaneId: 'impl-pane',
      workspaceId: 'workspace-1',
      implementationKind: 'codex',
      implementationCandidate: config().profiles.implement[0],
      config: config(),
      herdr: {
        async paneSplit(options) {
          calls.push(['split', options]);
          return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
        },
        async apiSnapshot() {
          calls.push(['snapshot']);
          snapshots += 1;
          return readySnapshot({ state_change_seq: snapshots === 1 ? 1 : 2 });
        },
        async agentStart(options) {
          calls.push(['start', options]);
          return {
            type: 'agent_started',
            agent: { pane_id: options.paneId },
            argv: [],
          };
        },
        async agentPrompt(target, text) {
          calls.push(['prompt', target, text]);
          return { type: 'agent_prompted', agent: { pane_id: 'review-pane' } };
        },
      },
    });

    assert.equal(started.paneId, 'review-pane');
    assert.equal(started.selection.candidate.kind, 'claude');
    assert.equal(started.agentName, reviewAgentName(bead.id));
    assert.equal(calls[0][0], 'split');
    assert.equal(calls[0][1].targetPaneId, 'impl-pane');
    assert.equal(calls[0][1].workspaceId, 'workspace-1');
    assert.equal(calls.find((call) => call[0] === 'start')[1].kind, 'claude');
    const prompt = await readFile(
      join(root, '.gis', 'run', 'review-prompt.md'),
      'utf8',
    );
    assert.match(prompt, /gis reviewer task/);
    assert.match(prompt, /round-1-review\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to same kind when the different reviewer cannot start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fallback-'));
  const startedKinds = [];
  let snapshots = 0;
  try {
    const result = await startReviewer({
      bead,
      worktreePath: root,
      runPath: join(root, '.gis', 'run'),
      implementationPaneId: 'impl-pane',
      workspaceId: 'workspace-1',
      implementationKind: 'codex',
      implementationCandidate: config().profiles.implement[0],
      config: config(),
      herdr: {
        async paneSplit() {
          return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
        },
        async apiSnapshot() {
          snapshots += 1;
          return readySnapshot({
            agent: startedKinds.length === 0 ? 'claude' : 'codex',
            state_change_seq: snapshots,
          });
        },
        async agentStart(options) {
          startedKinds.push(options.kind);
          if (options.kind === 'claude') {
            throw new WorkerStartupError('start', new Error('capacity'));
          }
          return {
            type: 'agent_started',
            agent: { pane_id: options.paneId },
            argv: [],
          };
        },
        async agentPrompt() {
          return { type: 'agent_prompted', agent: { pane_id: 'review-pane' } };
        },
      },
    });

    assert.equal(result.selection.candidate.kind, 'codex');
    assert.deepEqual(startedKinds, ['claude', 'codex']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back after a reviewer readiness failure as well as agent.start failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-readiness-fallback-'));
  const startedKinds = [];
  let activeKind;
  let stateChangeSeq = 0;
  let injectedReadinessFailure = false;
  try {
    const result = await startReviewer({
      bead,
      worktreePath: root,
      runPath: join(root, '.gis', 'run'),
      implementationPaneId: 'impl-pane',
      workspaceId: 'workspace-1',
      implementationKind: 'codex',
      implementationCandidate: config().profiles.implement[0],
      config: config(),
      herdr: {
        async paneSplit() {
          return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
        },
        async apiSnapshot() {
          stateChangeSeq += 1;
          if (activeKind === 'claude' && !injectedReadinessFailure) {
            injectedReadinessFailure = true;
            throw new Error('reviewer capacity exhausted during readiness');
          }
          if (activeKind !== 'codex') {
            return {
              type: 'session_snapshot',
              snapshot: { agents: [] },
            };
          }
          return readySnapshot({
            agent: 'codex',
            state_change_seq: stateChangeSeq,
          });
        },
        async agentStart(options) {
          activeKind = options.kind;
          startedKinds.push(options.kind);
          return {
            type: 'agent_started',
            agent: { pane_id: options.paneId },
            argv: [],
          };
        },
        async agentPrompt() {
          return { type: 'agent_prompted', agent: { pane_id: 'review-pane' } };
        },
      },
    });

    assert.equal(result.selection.candidate.kind, 'codex');
    assert.deepEqual(startedKinds, ['claude', 'codex']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not restart another reviewer after a prompt-phase startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-prompt-failure-'));
  const startedKinds = [];
  let snapshots = 0;
  try {
    await assert.rejects(
      startReviewer({
        bead,
        worktreePath: root,
        runPath: join(root, '.gis', 'run'),
        implementationPaneId: 'impl-pane',
        workspaceId: 'workspace-1',
        implementationKind: 'codex',
        implementationCandidate: config().profiles.implement[0],
        config: config(),
        herdr: {
          async paneSplit() {
            return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
          },
          async apiSnapshot() {
            snapshots += 1;
            return readySnapshot({ state_change_seq: snapshots });
          },
          async agentStart(options) {
            startedKinds.push(options.kind);
            return {
              type: 'agent_started',
              agent: { pane_id: options.paneId },
              argv: [],
            };
          },
          async agentPrompt() {
            throw new WorkerStartupError('prompt', new Error('prompt failed'));
          },
        },
      }),
      (error) =>
        error instanceof WorkerStartupError && error.phase === 'prompt',
    );
    assert.deepEqual(startedKinds, ['claude']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns implementation fixes to the original pane and re-reviews the same reviewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-loop-'));
  const events = [];
  const implementation = {
    id: 'gis-review.loop',
    title: 'review loop',
    description: 'Implement then review',
    acceptance_criteria: 'Review feedback is addressed',
    status: 'open',
    priority: 1,
    issue_type: 'task',
    labels: [],
  };
  const reviewerName = reviewAgentName(implementation.id);
  let ready = true;
  let reviewPrompts = 0;
  let verifyAttempts = 0;
  let herdrSnapshots = 0;
  const implementationPromptBodies = [];
  const cfg = config({
    review: true,
    concurrency: 1,
    review_max: 2,
    blocked_timeout: '1s',
    profiles: {
      ...config().profiles,
      implement: [{ kind: 'codex', model: 'impl', effort: 'low' }],
      review: [
        { kind: 'claude', model: 'review', effort: 'high' },
        { kind: 'codex', model: 'fallback', effort: 'low' },
      ],
    },
  });
  const runPath = join(root, '.gis', 'run');
  const initialResultPath = join(runPath, 'round-1-impl.json');
  const writePromptResult = async (role, verdict) => {
    const prompt = await readFile(
      join(
        runPath,
        role === 'review' ? 'review-prompt.md' : 'implement-prompt.md',
      ),
      'utf8',
    );
    const runId = /Run ID: `([^`]+)`/.exec(prompt)?.[1];
    const resultRelative = /write a JSON result to `([^`]+)`/.exec(prompt)?.[1];
    assert.ok(runId);
    assert.ok(resultRelative);
    await writeFile(
      join(root, resultRelative),
      JSON.stringify({
        run_id: runId,
        status: 'done',
        summary:
          verdict === 'changes_requested'
            ? 'Please fix null handling'
            : 'approved',
        verdict,
        ...(verdict === 'changes_requested'
          ? { feedback: 'Handle null input before dereferencing it.' }
          : {}),
      }),
    );
  };

  try {
    await mkdir(runPath, { recursive: true });
    const result = await runForegroundLoop({
      cwd: root,
      config: cfg,
      beads: {
        async ready() {
          if (ready) {
            ready = false;
            return [implementation];
          }
          return [];
        },
        async dispatch(id, kind) {
          events.push(['dispatch', id, kind]);
          return { ...implementation, status: 'in_progress' };
        },
        async markBlocked(id) {
          events.push(['blocked', id]);
          return { ...implementation, status: 'blocked' };
        },
        async createHumanGate() {
          throw new Error('human gate should not be needed');
        },
      },
      worktrees: {
        async create() {
          return {
            beadId: implementation.id,
            path: root,
            runPath,
            workspaceId: 'workspace-1',
            paneId: 'impl-pane',
          };
        },
      },
      workers: {
        async start() {
          events.push(['implementation-start']);
          await writeFile(
            initialResultPath,
            JSON.stringify({
              run_id: 'implementation-run',
              status: 'done',
              summary: 'implemented',
            }),
          );
          return {
            prompt: {
              resultPath: initialResultPath,
              runId: 'implementation-run',
            },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait({ target }) {
          events.push(['wait', target]);
          return { status: 'done', wasBlocked: false, worktreeRetained: false };
        },
      },
      verify: {
        async verify() {
          verifyAttempts += 1;
          events.push(['verify', verifyAttempts]);
          return { status: 'verified', attempts: 1, result: { passed: true } };
        },
      },
      herdr: {
        async paneSplit(options) {
          events.push(['split', options.targetPaneId]);
          return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
        },
        async apiSnapshot() {
          herdrSnapshots += 1;
          return {
            type: 'session_snapshot',
            snapshot: {
              agents: [
                {
                  pane_id: 'review-pane',
                  name: reviewerName,
                  agent: 'claude',
                  agent_status: 'done',
                  interactive_ready: true,
                  launch_pending: false,
                  state_change_seq: herdrSnapshots,
                },
              ],
            },
          };
        },
        async agentStart(options) {
          events.push(['review-start', options.kind]);
          return {
            type: 'agent_started',
            agent: { pane_id: options.paneId },
            argv: [],
          };
        },
        async agentPrompt(target, text) {
          events.push(['prompt', target, text]);
          if (target === reviewerName) {
            reviewPrompts += 1;
            await writePromptResult(
              'review',
              reviewPrompts === 1 ? 'changes_requested' : 'approved',
            );
          } else {
            implementationPromptBodies.push(
              await readFile(join(runPath, 'implement-prompt.md'), 'utf8'),
            );
            await writePromptResult('impl', 'approved');
          }
          return {
            type: 'agent_prompted',
            agent: {
              pane_id: target === reviewerName ? 'review-pane' : 'impl-pane',
            },
          };
        },
      },
      merge: {
        async enqueue({ bead: issue }) {
          events.push(['merge', issue.id]);
          return { status: 'merged', bead: { ...issue, status: 'closed' } };
        },
      },
      report: (message) => events.push(['report', message]),
    });

    assert.equal(result.merged, 1);
    assert.equal(verifyAttempts, 2);
    assert.equal(reviewPrompts, 2);
    assert.match(implementationPromptBodies[0], /Previous review findings/);
    assert.match(
      implementationPromptBodies[0],
      /Handle null input before dereferencing it\./,
    );
    assert.deepEqual(
      events
        .filter(([kind]) =>
          ['split', 'review-start', 'verify', 'merge'].includes(kind),
        )
        .map(([kind, value]) => [kind, value]),
      [
        ['verify', 1],
        ['split', 'impl-pane'],
        ['review-start', 'claude'],
        ['verify', 2],
        ['merge', implementation.id],
      ],
    );
    assert.equal(
      events.filter(
        ([kind, target]) => kind === 'wait' && target === reviewerName,
      ).length,
      2,
    );
    assert.equal(
      events.filter(
        ([kind, target]) => kind === 'wait' && target !== reviewerName,
      ).length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'needs_human',
    implementationResult: {
      status: 'done',
      summary: 'implementation needs a decision',
      needs_human: 'Choose the migration strategy.',
    },
    expectedOutcome: 'human',
    expectedGates: 1,
  },
  {
    name: 'failure',
    implementationResult: {
      status: 'failed',
      summary: 'implementation failed',
    },
    expectedOutcome: 'blocked',
    expectedGates: 0,
  },
  {
    name: 'missing',
    implementationResult: undefined,
    expectedOutcome: 'blocked',
    expectedGates: 0,
  },
]) {
  test(`handles review-fix implementation ${scenario.name} results`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), `gis-review-fix-${scenario.name}-`),
    );
    const runPath = join(root, '.gis', 'run');
    const source = {
      ...bead,
      id: `gis-review-fix-${scenario.name}`,
    };
    const reviewerName = reviewAgentName(source.id);
    const blocked = [];
    const gates = [];
    let snapshotCalls = 0;
    try {
      const writeResult = async (role, result) => {
        const promptPath = join(
          runPath,
          role === 'review' ? 'review-prompt.md' : 'implement-prompt.md',
        );
        const prompt = await readFile(promptPath, 'utf8');
        const runId = /Run ID: `([^`]+)`/.exec(prompt)?.[1];
        const resultRelative = /write a JSON result to `([^`]+)`/.exec(
          prompt,
        )?.[1];
        assert.ok(runId);
        assert.ok(resultRelative);
        if (result === undefined) return;
        await writeFile(
          join(root, resultRelative),
          JSON.stringify({ run_id: runId, ...result }),
          'utf8',
        );
      };

      const outcome = await runReviewLoop({
        bead: source,
        worktree: {
          beadId: source.id,
          path: root,
          runPath,
          workspaceId: 'workspace-1',
          paneId: 'implementation-pane',
        },
        config: config({ review_max: 2, blocked_timeout: '1s' }),
        implementation: {
          agentName: 'implementation-agent',
          kind: 'codex',
          candidate: config().profiles.implement[0],
        },
        herdr: {
          async paneSplit() {
            return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
          },
          async apiSnapshot() {
            snapshotCalls += 1;
            return {
              type: 'session_snapshot',
              snapshot: {
                agents:
                  snapshotCalls === 1
                    ? []
                    : [
                        {
                          pane_id: 'review-pane',
                          name: reviewerName,
                          agent: 'claude',
                          agent_status: 'done',
                          interactive_ready: true,
                          launch_pending: false,
                          state_change_seq: snapshotCalls,
                        },
                      ],
              },
            };
          },
          async agentStart(options) {
            return {
              type: 'agent_started',
              agent: { pane_id: options.paneId },
              argv: [],
            };
          },
          async agentPrompt(target) {
            if (target === reviewerName) {
              await writeResult('review', {
                status: 'done',
                summary: 'Please fix the reported issue.',
                verdict: 'changes_requested',
                feedback: 'Fix the reported issue before review.',
              });
            } else {
              await writeResult('implement', scenario.implementationResult);
            }
            return { type: 'agent_prompted', agent: { pane_id: target } };
          },
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate(request) {
            const gate = {
              ...source,
              id: `${source.id}-human`,
              status: 'open',
            };
            gates.push({ request, gate });
            return gate;
          },
        },
        blocked: {
          async wait() {
            return {
              status: 'done',
              wasBlocked: false,
              worktreeRetained: false,
            };
          },
        },
        implementationWaitOptions: {
          beadId: source.id,
          target: 'implementation-agent',
          worktreePath: root,
          roundLogPath: runPath,
          transcriptPath: join(root, 'implementation-session.jsonl'),
          blockedTimeout: '1s',
          workerTimeout: '1s',
          herdr: {},
          beads: {},
        },
        implementationHandoff: async () => ({
          worktreePath: root,
          roundLogPath: runPath,
          transcriptPath: join(root, 'implementation-session.jsonl'),
        }),
        reviewerTranscriptPath: async () => join(root, 'review-session.jsonl'),
        verifyImplementation: async () => {
          throw new Error(
            'verification must not run after a non-success result',
          );
        },
        onHumanGate: () => undefined,
        report: () => undefined,
      });

      assert.equal(outcome, scenario.expectedOutcome);
      assert.equal(blocked.length, 1);
      assert.equal(gates.length, scenario.expectedGates);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('uses the reviewer session for reviewer blocked handoff locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-handoff-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = {
    id: 'gis-review.handoff',
    title: 'review handoff',
    description: 'Review and retain the right transcript',
    acceptance_criteria: 'Reviewer failures identify the reviewer session',
    status: 'open',
    priority: 1,
    issue_type: 'task',
    labels: [],
  };
  const implementationName = 'gis-review-handoff-impl';
  const reviewerName = reviewAgentName(source.id);
  const implementationSession = {
    source: 'runner',
    agent: 'codex',
    kind: 'id',
    value: 'implementation-session',
  };
  const reviewerSession = {
    source: 'runner',
    agent: 'claude',
    kind: 'id',
    value: 'reviewer-session',
  };
  const blockedLocations = [];
  const resolvedSessions = [];
  let ready = true;
  let snapshotSequence = 0;

  try {
    const result = await runForegroundLoop({
      cwd: root,
      config: config({
        review: true,
        concurrency: 1,
        blocked_timeout: '1s',
      }),
      beads: {
        async ready() {
          if (!ready) return [];
          ready = false;
          return [source];
        },
        async dispatch() {
          return { ...source, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blockedLocations.push({ id, locations });
          return { ...source, status: 'blocked' };
        },
        async createHumanGate() {
          throw new Error('human gate should not be needed');
        },
      },
      worktrees: {
        async create() {
          return {
            beadId: source.id,
            path: root,
            runPath,
            workspaceId: 'workspace-handoff',
            paneId: 'implementation-pane',
          };
        },
      },
      workers: {
        async start() {
          await writeFile(
            join(runPath, 'round-1-impl.json'),
            JSON.stringify({
              run_id: 'implementation-run',
              status: 'done',
              summary: 'implemented',
            }),
          );
          return {
            prompt: {
              resultPath: join(runPath, 'round-1-impl.json'),
              runId: 'implementation-run',
            },
            started: {
              agent: {
                pane_id: 'implementation-pane',
                agent_session: implementationSession,
              },
            },
            prompted: {},
          };
        },
      },
      blocked: {
        async wait(options) {
          if (options.target === reviewerName) {
            resolvedSessions.push(await options.resolveTranscriptPath());
            throw new Error('reviewer pane disappeared');
          }
          return { status: 'done', wasBlocked: false, worktreeRetained: false };
        },
      },
      verify: {
        async verify() {
          return { status: 'verified', attempts: 1, result: { passed: true } };
        },
      },
      herdr: {
        async paneSplit() {
          return { type: 'pane_split', pane: { pane_id: 'reviewer-pane' } };
        },
        async apiSnapshot() {
          snapshotSequence += 1;
          return {
            type: 'session_snapshot',
            snapshot: {
              agents: [
                {
                  pane_id: 'implementation-pane',
                  name: implementationName,
                  agent: 'codex',
                  agent_status: 'done',
                  agent_session: implementationSession,
                  state_change_seq: snapshotSequence,
                },
                {
                  pane_id: 'reviewer-pane',
                  name: reviewerName,
                  agent: 'claude',
                  agent_status: 'done',
                  interactive_ready: true,
                  launch_pending: false,
                  agent_session: reviewerSession,
                  state_change_seq: snapshotSequence,
                },
              ],
            },
          };
        },
        async agentStart(options) {
          return {
            type: 'agent_started',
            agent: { pane_id: options.paneId },
            argv: [],
          };
        },
        async agentPrompt() {
          return {
            type: 'agent_prompted',
            agent: { pane_id: 'reviewer-pane' },
          };
        },
      },
      resolveTranscript: async (session) => {
        return `/transcripts/${session.value}.jsonl`;
      },
      report: () => undefined,
    });

    assert.equal(result.blocked, 1);
    assert.equal(resolvedSessions.at(0), '/transcripts/reviewer-session.jsonl');
    assert.equal(
      blockedLocations.at(-1).locations.transcriptPath,
      '/transcripts/reviewer-session.jsonl',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- runReviewLoop branch coverage -----------------------------------------
//
// The tests below drive runReviewLoop directly (as the "handles review-fix
// implementation ... results" tests above do) to exercise every blocked/
// human/error branch inside the state machine, since runForegroundLoop's
// happy-path tests never take these branches.

function reviewLoopConfig(overrides = {}) {
  return config({ review_max: 2, blocked_timeout: '1s', ...overrides });
}

async function writeRoundResult(root, runPath, role, payload) {
  const promptPath = join(
    runPath,
    role === 'review' ? 'review-prompt.md' : 'implement-prompt.md',
  );
  const prompt = await readFile(promptPath, 'utf8');
  const runId = /Run ID: `([^`]+)`/.exec(prompt)?.[1];
  const resultRelative = /write a JSON result to `([^`]+)`/.exec(prompt)?.[1];
  assert.ok(runId);
  assert.ok(resultRelative);
  await writeFile(
    join(root, resultRelative),
    JSON.stringify({ run_id: runId, ...payload }),
  );
}

function baseReviewLoopOptions({
  root,
  runPath,
  source,
  cfg,
  herdr,
  blockedWait,
  beads,
  verifyImplementation,
  report,
  onHumanGate,
}) {
  return {
    bead: source,
    worktree: {
      beadId: source.id,
      path: root,
      runPath,
      workspaceId: 'workspace-1',
      paneId: 'implementation-pane',
    },
    config: cfg,
    implementation: {
      agentName: 'implementation-agent',
      kind: 'codex',
      candidate: cfg.profiles.implement[0],
    },
    herdr,
    beads,
    blocked: { wait: blockedWait },
    implementationWaitOptions: {
      beadId: source.id,
      target: 'implementation-agent',
      worktreePath: root,
      roundLogPath: runPath,
      transcriptPath: join(root, 'implementation-session.jsonl'),
      blockedTimeout: cfg.blocked_timeout,
      workerTimeout: cfg.blocked_timeout,
      herdr: {},
      beads: {},
    },
    implementationHandoff: async () => ({
      worktreePath: root,
      roundLogPath: runPath,
      transcriptPath: join(root, 'implementation-session.jsonl'),
    }),
    reviewerTranscriptPath: async () => join(root, 'review-session.jsonl'),
    verifyImplementation: verifyImplementation ?? (async () => 'verified'),
    onHumanGate: onHumanGate ?? (() => undefined),
    report: report ?? (() => undefined),
  };
}

function readyReviewerHerdr({ reviewerName, agentKind = 'claude', onPrompt }) {
  let snapshotCalls = 0;
  return {
    async paneSplit() {
      return { type: 'pane_split', pane: { pane_id: 'review-pane' } };
    },
    async apiSnapshot() {
      snapshotCalls += 1;
      return {
        type: 'session_snapshot',
        snapshot: {
          agents: [
            {
              pane_id: 'review-pane',
              name: reviewerName,
              agent: agentKind,
              agent_status: 'done',
              interactive_ready: true,
              launch_pending: false,
              state_change_seq: snapshotCalls,
            },
          ],
        },
      };
    },
    async agentStart(options) {
      return {
        type: 'agent_started',
        agent: { pane_id: options.paneId },
        argv: [],
      };
    },
    async agentPrompt(target, text) {
      await onPrompt?.(target, text);
      return { type: 'agent_prompted', agent: { pane_id: target } };
    },
  };
}

test('clamps a poll delay to the remaining timeout', async () => {
  const waits = [];
  let reads = 0;
  let now = 0;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  try {
    Date.now = () => now;
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      waits.push(milliseconds);
      now += milliseconds;
      callback(...args);
      return 0;
    };
    const result = await pollUntilTerminal(async () => {
      reads += 1;
      return reads === 1 ? { kind: 'missing' } : { kind: 'success' };
    }, '100ms');

    assert.deepEqual(result, { kind: 'success' });
    assert.deepEqual(waits, [100]);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('blocks without starting a reviewer when herdr pane.split is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-nosplit-'));
  const runPath = join(root, '.gis', 'run');
  const source = { ...bead, id: 'gis-review-nosplit' };
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: {},
        blockedWait: async () => {
          throw new Error('blocked.wait should not be called');
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports[0], /Herdr pane\.split is unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks when the reviewer fails to start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-startfail-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-startfail' };
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: {
          async paneSplit() {
            throw new Error('herdr unavailable');
          },
        },
        blockedWait: async () => {
          throw new Error('blocked.wait should not be called');
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports[0], /reviewer startup failed/);
    assert.match(reports[0], /herdr unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports a reviewer kind fallback and still completes the review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fallback-kind-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fallback-kind' };
  const reviewerName = reviewAgentName(source.id);
  // Only the implementation's own kind is configured, so the reviewer must
  // fall back to it instead of the usual opposite-vendor reviewer.
  const cfg = reviewLoopConfig({ kinds: ['codex'] });
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          agentKind: 'codex',
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'looks good',
                verdict: 'approved',
              });
            }
          },
        }),
        blockedWait: async () => ({
          status: 'done',
          wasBlocked: false,
          worktreeRetained: false,
        }),
        beads: {
          async markBlocked() {
            throw new Error('should not block');
          },
          async createHumanGate() {
            throw new Error('should not need a human gate');
          },
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'approved');
    assert.ok(
      reports.some((message) => /reviewer kind fallback/.test(message)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns blocked immediately when the initial reviewer wait reports blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-wait-blocked-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-wait-blocked' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({ reviewerName }),
        blockedWait: async () => ({
          status: 'blocked',
          wasBlocked: true,
          worktreeRetained: true,
        }),
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
      }),
    );

    assert.equal(outcome, 'blocked');
    // The wait helper already accounts for the block; runReviewLoop must not
    // mark the bead blocked a second time on this path.
    assert.equal(blocked.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'accepted', createsGate: true, expectedOutcome: 'human' },
  { name: 'rejected', createsGate: false, expectedOutcome: 'blocked' },
]) {
  test(`handles a reviewer needs_human result whose human gate creation is ${scenario.name}`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), `gis-review-needs-human-${scenario.name}-`),
    );
    const runPath = join(root, '.gis', 'run');
    await mkdir(runPath, { recursive: true });
    const source = { ...bead, id: `gis-review-needs-human-${scenario.name}` };
    const reviewerName = reviewAgentName(source.id);
    const cfg = reviewLoopConfig();
    const blocked = [];
    const gates = [];
    try {
      const outcome = await runReviewLoop(
        baseReviewLoopOptions({
          root,
          runPath,
          source,
          cfg,
          herdr: readyReviewerHerdr({
            reviewerName,
            onPrompt: async (target) => {
              if (target === reviewerName) {
                await writeRoundResult(root, runPath, 'review', {
                  status: 'done',
                  summary: 'unsure how to proceed',
                  verdict: 'changes_requested',
                  needs_human: 'Choose the migration strategy.',
                });
              }
            },
          }),
          blockedWait: async () => ({
            status: 'done',
            wasBlocked: false,
            worktreeRetained: false,
          }),
          beads: {
            async markBlocked(id, locations) {
              blocked.push({ id, locations });
              return { ...source, id, status: 'blocked' };
            },
            async createHumanGate(request) {
              if (!scenario.createsGate) {
                throw new Error('human gate creation failed');
              }
              const gate = {
                ...source,
                id: `${source.id}-human`,
                status: 'open',
              };
              gates.push({ request, gate });
              return gate;
            },
          },
          verifyImplementation: async () => {
            throw new Error('verification must not run');
          },
        }),
      );

      assert.equal(outcome, scenario.expectedOutcome);
      assert.equal(blocked.length, 1);
      assert.equal(gates.length, scenario.createsGate ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('blocks when the reviewer result cannot be read before the timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-result-timeout-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-result-timeout' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig({ blocked_timeout: '150ms' });
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        // Never writes a review result file, so waitForReviewResult times
        // out and returns a 'missing' problem.
        herdr: readyReviewerHerdr({ reviewerName }),
        blockedWait: async () => ({
          status: 'done',
          wasBlocked: false,
          worktreeRetained: false,
        }),
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports[0], /reviewer result missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks when reading the reviewer result throws an unexpected error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-result-throw-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-result-throw' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({ reviewerName }),
        // The review prompt is left unanswered: instead the expected result
        // path is turned into a directory so readFile rejects with a
        // non-ENOENT error that waitForReviewResult must not swallow.
        blockedWait: async () => {
          await mkdir(join(runPath, 'round-1-review.json'), {
            recursive: true,
          });
          return { status: 'done', wasBlocked: false, worktreeRetained: false };
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports[0], /reviewer result read failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('asks a human to decide once the review round limit is reached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-limit-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-limit' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig({ review_max: 1 });
  const gates = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'Please fix null handling',
                verdict: 'changes_requested',
                feedback: 'Handle null input before dereferencing it.',
              });
            }
          },
        }),
        blockedWait: async () => ({
          status: 'done',
          wasBlocked: false,
          worktreeRetained: false,
        }),
        beads: {
          async markBlocked() {
            return { ...source, status: 'blocked' };
          },
          async createHumanGate(request) {
            const gate = {
              ...source,
              id: `${source.id}-human`,
              status: 'open',
            };
            gates.push({ request, gate });
            return gate;
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
      }),
    );

    assert.equal(outcome, 'human');
    assert.equal(gates.length, 1);
    assert.match(gates[0].request.reason, /review_max=1 reached/);
    assert.match(
      gates[0].request.reason,
      /Handle null input before dereferencing it\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks when reading the implementation result throws during review-fix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fix-read-throw-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fix-read-throw' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'Please fix the reported issue.',
                verdict: 'changes_requested',
                feedback: 'Fix the reported issue before review.',
              });
            }
            // The implementation prompt is left unanswered: the wait fake
            // below turns the expected result path into a directory so the
            // read throws an unexpected (non-ENOENT) error.
          },
        }),
        blockedWait: async (options) => {
          if (options.target === reviewerName) {
            return {
              status: 'done',
              wasBlocked: false,
              worktreeRetained: false,
            };
          }
          await mkdir(join(runPath, 'round-2-impl-review-fix.json'), {
            recursive: true,
          });
          return { status: 'done', wasBlocked: false, worktreeRetained: false };
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports.at(-1), /implementation result read failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns blocked immediately when the review-fix implementation wait reports blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fix-wait-blocked-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fix-wait-blocked' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'Please fix the reported issue.',
                verdict: 'changes_requested',
                feedback: 'Fix the reported issue before review.',
              });
            }
          },
        }),
        blockedWait: async (options) => {
          if (options.target === reviewerName) {
            return {
              status: 'done',
              wasBlocked: false,
              worktreeRetained: false,
            };
          }
          return {
            status: 'blocked',
            wasBlocked: true,
            worktreeRetained: true,
          };
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks when the review-fix implementation wait throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fix-wait-throw-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fix-wait-throw' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'Please fix the reported issue.',
                verdict: 'changes_requested',
                feedback: 'Fix the reported issue before review.',
              });
            }
          },
        }),
        blockedWait: async (options) => {
          if (options.target === reviewerName) {
            return {
              status: 'done',
              wasBlocked: false,
              worktreeRetained: false,
            };
          }
          throw new Error('implementation pane disappeared');
        },
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          throw new Error('verification must not run');
        },
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports.at(-1), /implementation wait failed/);
    assert.match(reports.at(-1), /implementation pane disappeared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns blocked when re-verification fails during review-fix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fix-verify-blocked-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fix-verify-blocked' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  let verifyCalls = 0;
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              await writeRoundResult(root, runPath, 'review', {
                status: 'done',
                summary: 'Please fix the reported issue.',
                verdict: 'changes_requested',
                feedback: 'Fix the reported issue before review.',
              });
            } else {
              await writeRoundResult(root, runPath, 'implement', {
                status: 'done',
                summary: 'fixed',
              });
            }
          },
        }),
        blockedWait: async () => ({
          status: 'done',
          wasBlocked: false,
          worktreeRetained: false,
        }),
        beads: {
          async markBlocked() {
            throw new Error('should not block via markBlocked');
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => {
          verifyCalls += 1;
          return 'blocked';
        },
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(verifyCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks when prompting the reviewer for the next round fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-review-fix-prompt-fail-'));
  const runPath = join(root, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const source = { ...bead, id: 'gis-review-fix-prompt-fail' };
  const reviewerName = reviewAgentName(source.id);
  const cfg = reviewLoopConfig();
  const blocked = [];
  const reports = [];
  let reviewerPromptCount = 0;
  try {
    const outcome = await runReviewLoop(
      baseReviewLoopOptions({
        root,
        runPath,
        source,
        cfg,
        herdr: readyReviewerHerdr({
          reviewerName,
          onPrompt: async (target) => {
            if (target === reviewerName) {
              reviewerPromptCount += 1;
              if (reviewerPromptCount === 1) {
                await writeRoundResult(root, runPath, 'review', {
                  status: 'done',
                  summary: 'Please fix the reported issue.',
                  verdict: 'changes_requested',
                  feedback: 'Fix the reported issue before review.',
                });
                return;
              }
              throw new Error('reviewer pane rejected the round-2 prompt');
            }
            await writeRoundResult(root, runPath, 'implement', {
              status: 'done',
              summary: 'fixed',
            });
          },
        }),
        blockedWait: async () => ({
          status: 'done',
          wasBlocked: false,
          worktreeRetained: false,
        }),
        beads: {
          async markBlocked(id, locations) {
            blocked.push({ id, locations });
            return { ...source, id, status: 'blocked' };
          },
          async createHumanGate() {
            throw new Error('human gate should not be needed');
          },
        },
        verifyImplementation: async () => 'verified',
        report: (message) => reports.push(message),
      }),
    );

    assert.equal(outcome, 'blocked');
    assert.equal(blocked.length, 1);
    assert.match(reports.at(-1), /reviewer prompt failed/);
    assert.match(reports.at(-1), /reviewer pane rejected the round-2 prompt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
