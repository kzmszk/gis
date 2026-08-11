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
  requestedChangesFeedback,
  reviewProblemDetail,
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
      join(root, '.gis', 'run', 'prompt.md'),
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
  const resultPath = (round, role) =>
    join(runPath, `round-${round}-${role}.json`);

  const writePromptResult = async (role, verdict) => {
    const prompt = await readFile(join(runPath, 'prompt.md'), 'utf8');
    const runId = /Run ID: `([^`]+)`/.exec(prompt)?.[1];
    const round = /round-(\d+)-/.exec(prompt)?.[1];
    assert.ok(runId);
    assert.ok(round);
    await writeFile(
      resultPath(round, role),
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
            resultPath(1, 'impl'),
            JSON.stringify({
              run_id: 'implementation-run',
              status: 'done',
              summary: 'implemented',
            }),
          );
          return {
            prompt: {
              resultPath: resultPath(1, 'impl'),
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
              await readFile(join(runPath, 'prompt.md'), 'utf8'),
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
