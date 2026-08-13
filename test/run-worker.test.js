import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBeadJobProcessor } from '../dist/run-worker.js';
import { WorkerStartupError, herdrAgentName } from '../dist/worker.js';
import { ConfigError } from '../dist/config.js';

const config = {
  base: 'main',
  verify: 'npm test',
  kinds: ['codex'],
  review: false,
  verify_max: 2,
  review_max: 1,
  blocked_timeout: '1s',
  worker_timeout: '1h',
  verify_timeout: '15m',
  claude_permission_mode: 'auto',
  profiles: {
    plan: [{ kind: 'codex', model: 'plan', effort: 'low' }],
    implement: [{ kind: 'codex', model: 'implement', effort: 'low' }],
    review: [{ kind: 'codex', model: 'review', effort: 'low' }],
  },
};

test('rejects construction when review is enabled but herdr has no pane.split, before any dispatch', () => {
  const worktreeCreateCalls = [];
  const dispatchCalls = [];

  assert.throws(
    () =>
      createBeadJobProcessor({
        cwd: '/does-not-matter',
        config: { ...config, review: true },
        beads: {
          async dispatch(id, kind) {
            dispatchCalls.push([id, kind]);
            throw new Error('dispatch must not run');
          },
          async markBlocked() {
            throw new Error('markBlocked must not run');
          },
          async createHumanGate() {
            throw new Error('human gate must not run');
          },
        },
        herdr: {},
        worktrees: {
          async create(options) {
            worktreeCreateCalls.push(options);
            throw new Error('worktree creation must not run');
          },
        },
        workers: {},
        blocked: {},
        verify: {},
        merge: {},
        resolveTranscript: async () => undefined,
        report: () => undefined,
        onHumanGate: () => undefined,
      }),
    ConfigError,
  );

  assert.deepEqual(worktreeCreateCalls, []);
  assert.deepEqual(dispatchCalls, []);
});

test('retains an intended handoff when worktree creation fails', async () => {
  const issue = {
    id: 'gis-vst.worktree-failure',
    title: 'worktree failure',
    description: 'retain the failed worktree handoff',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const blocked = [];
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-boundary-'));
  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          throw new Error('dispatch must not run');
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          throw new Error('git worktree add failed');
        },
      },
      workers: {},
      blocked: {},
      verify: {},
      merge: {},
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    assert.deepEqual(await processor(issue), { status: 'blocked' });
    const intendedPath = join(root, '.worktrees', issue.id);
    const intendedRunPath = join(intendedPath, '.gis', 'run');
    assert.deepEqual(blocked, [
      [
        issue.id,
        {
          worktreePath: intendedPath,
          roundLogPath: intendedRunPath,
          transcriptPath: join(
            intendedRunPath,
            'transcript-unknown.unresolved',
          ),
        },
      ],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker service owns result handling and emits a human outcome at its boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-'));
  const issue = {
    id: 'gis-vst.worker-boundary',
    title: 'worker boundary',
    description: 'inspect the worker boundary',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const gate = {
    ...issue,
    id: 'gis-vst.human-boundary',
    status: 'open',
    labels: ['human'],
  };
  const calls = [];

  await writeFile(
    resultPath,
    JSON.stringify({
      status: 'failed',
      summary: 'waiting for a decision',
      needs_human: 'choose the migration strategy',
    }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch(id, kind) {
          calls.push(['dispatch', id, kind]);
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          calls.push(['blocked', id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate(request) {
          calls.push(['gate', request]);
          return gate;
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          throw new Error('verification must not run for a human result');
        },
      },
      merge: {
        async enqueue() {
          throw new Error('merge must not run for a human result');
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: (createdGate, locations) => {
        calls.push(['human-callback', createdGate, locations]);
      },
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'human' });
    assert.equal(calls[0][0], 'dispatch');
    assert.equal(calls[1][0], 'blocked');
    assert.equal(calls[2][0], 'gate');
    assert.equal(calls[3][0], 'human-callback');
    assert.equal(calls[3][1].id, gate.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to the next profile candidate after a WorkerStartupError start failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-fallback-'));
  const issue = {
    id: 'gis-vst.profile-fallback',
    title: 'profile fallback',
    description: 'fall back to the next candidate after a start failure',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const dispatched = [];
  const cfg = {
    ...config,
    kinds: ['codex', 'claude'],
    profiles: {
      ...config.profiles,
      implement: [
        { kind: 'codex', model: 'implement', effort: 'low' },
        { kind: 'claude', model: 'implement', effort: 'low' },
      ],
    },
  };
  const worktree = {
    beadId: issue.id,
    path: join(root, 'worktree'),
    runPath: join(root, 'worktree', '.gis', 'run'),
    workspaceId: 'workspace',
    paneId: 'pane',
    async remove() {},
  };

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config: cfg,
      beads: {
        async dispatch(id, kind) {
          dispatched.push(kind);
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          throw new Error('markBlocked must not run once a candidate starts');
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return worktree;
        },
      },
      workers: {
        async start({ candidate }) {
          if (candidate.kind === 'codex') {
            throw new WorkerStartupError('start', new Error('runner crashed'));
          }
          return {
            prompt: { resultPath: join(root, 'result.json') },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'blocked' };
        },
      },
      verify: {},
      merge: {},
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.deepEqual(dispatched, ['codex', 'claude']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks the bead blocked once every profile candidate fails to start', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'gis-run-worker-fallback-exhausted-'),
  );
  const issue = {
    id: 'gis-vst.profile-exhausted',
    title: 'profile exhausted',
    description: 'mark blocked once every candidate fails to start',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const dispatched = [];
  const blocked = [];
  const cfg = {
    ...config,
    kinds: ['codex', 'claude'],
    profiles: {
      ...config.profiles,
      implement: [
        { kind: 'codex', model: 'implement', effort: 'low' },
        { kind: 'claude', model: 'implement', effort: 'low' },
      ],
    },
  };
  const worktree = {
    beadId: issue.id,
    path: join(root, 'worktree'),
    runPath: join(root, 'worktree', '.gis', 'run'),
    workspaceId: 'workspace',
    paneId: 'pane',
    async remove() {},
  };

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config: cfg,
      beads: {
        async dispatch(id, kind) {
          dispatched.push(kind);
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return worktree;
        },
      },
      workers: {
        async start() {
          throw new WorkerStartupError('start', new Error('runner crashed'));
        },
      },
      blocked: {},
      verify: {},
      merge: {},
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.deepEqual(dispatched, ['codex', 'claude']);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0][0], issue.id);
    assert.deepEqual(blocked[0][1], {
      worktreePath: worktree.path,
      roundLogPath: worktree.runPath,
      transcriptPath: join(
        worktree.path,
        '.gis',
        'run',
        'transcript-claude.unresolved',
      ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not double markBlocked when waitForWorker observes AlreadyBlockedError during verify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-verify-blocked-'));
  const issue = {
    id: 'gis-vst.verify-already-blocked',
    title: 'verify already blocked',
    description:
      'do not double markBlocked once verify observes a blocked wait',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const blocked = [];
  let waitCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          waitCalls += 1;
          if (waitCalls === 1) {
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
      },
      verify: {
        async verify(verifyOptions) {
          await verifyOptions.waitForWorker();
          throw new Error(
            'verify must not continue after waitForWorker rejects',
          );
        },
      },
      merge: {
        async enqueue() {
          throw new Error('merge must not run once verify observes blocked');
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(waitCalls, 2);
    assert.equal(blocked.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks the bead blocked when the result file never appears before blocked_timeout elapses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-result-timeout-'));
  const issue = {
    id: 'gis-vst.result-timeout',
    title: 'result timeout',
    description: 'time out waiting for a result file that is never written',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const blocked = [];
  let humanGateCalls = 0;
  let verifyCalls = 0;
  let mergeCalls = 0;

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config: { ...config, blocked_timeout: '1ms' },
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath: join(root, 'never-written.json') },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          verifyCalls += 1;
          throw new Error('verify must not run when the result never arrives');
        },
      },
      merge: {
        async enqueue() {
          mergeCalls += 1;
          throw new Error('merge must not run when the result never arrives');
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0][0], issue.id);
    assert.equal(humanGateCalls, 0);
    assert.equal(verifyCalls, 0);
    assert.equal(mergeCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to the default transcript path when resolveTranscript throws', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'gis-run-worker-transcript-throws-'),
  );
  const issue = {
    id: 'gis-vst.transcript-resolve-throws',
    title: 'transcript resolve throws',
    description: 'fall back to the default transcript path on a resolver error',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const blocked = [];
  let humanGateCalls = 0;
  const worktree = {
    beadId: issue.id,
    path: join(root, 'worktree'),
    runPath: join(root, 'worktree', '.gis', 'run'),
    workspaceId: 'workspace',
    paneId: 'pane',
    async remove() {},
  };

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return worktree;
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath: join(root, 'result.json') },
            started: {},
            prompted: {
              agent: {
                agent_session: { session_id: 'session-1' },
                pane_id: 'pane-1',
              },
            },
          };
        },
      },
      blocked: {
        async wait() {
          throw new Error('herdr wait crashed');
        },
      },
      verify: {},
      merge: {},
      resolveTranscript: async () => {
        throw new Error('transcript resolver crashed');
      },
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(blocked.length, 1);
    assert.equal(humanGateCalls, 0);
    assert.deepEqual(blocked[0][1], {
      worktreePath: worktree.path,
      roundLogPath: worktree.runPath,
      transcriptPath: join(
        worktree.path,
        '.gis',
        'run',
        'transcript-codex.unresolved',
      ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks the bead blocked when reading the result file raises instead of returning missing', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'gis-run-worker-result-read-throws-'),
  );
  const issue = {
    id: 'gis-vst.result-read-throws',
    title: 'result read throws',
    description: 'handle a result read failure that is not a missing file',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const blocked = [];
  let humanGateCalls = 0;
  let verifyCalls = 0;
  let mergeCalls = 0;

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          // A directory path makes readFile fail with EISDIR rather than
          // ENOENT, so readWorkerResult rethrows instead of reporting missing.
          return {
            prompt: { resultPath: root },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          verifyCalls += 1;
          throw new Error('verify must not run when the result read fails');
        },
      },
      merge: {
        async enqueue() {
          mergeCalls += 1;
          throw new Error('merge must not run when the result read fails');
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(blocked.length, 1);
    assert.equal(humanGateCalls, 0);
    assert.equal(verifyCalls, 0);
    assert.equal(mergeCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivers worsened slop feedback to the agent and reports when delivery fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-slop-worsened-'));
  const issue = {
    id: 'gis-vst.slop-worsened',
    title: 'slop worsened',
    description: 'report worsened quality metrics and a failed delivery',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const reports = [];
  const promptCalls = [];
  let markBlockedCalls = 0;
  let humanGateCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          markBlockedCalls += 1;
          throw new Error('markBlocked must not run on a merged outcome');
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {
        async agentPrompt(target, message) {
          promptCalls.push([target, message]);
          throw new Error('herdr prompt channel down');
        },
      },
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          const report = {
            base: { verbosity: 0, erosion: 0 },
            current: { verbosity: 0.1, erosion: 0.1 },
            verbosityDelta: 0.05,
            erosionDelta: 0.05,
          };
          return {
            status: 'verified',
            attempts: 1,
            result: {
              passed: true,
              stdout: `GIS_SLOP_REPORT=${JSON.stringify(report)}`,
            },
          };
        },
      },
      merge: {
        async enqueue() {
          return { status: 'merged' };
        },
      },
      resolveTranscript: async () => undefined,
      report: (message) => reports.push(message),
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'merged' });
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0][0], herdrAgentName(issue.id));
    assert.ok(
      reports.some(
        (message) =>
          message.includes(issue.id) && message.includes('verbosity'),
      ),
    );
    assert.ok(
      reports.some((message) =>
        message.includes('could not deliver informational slop report'),
      ),
    );
    assert.equal(markBlockedCalls, 0);
    assert.equal(humanGateCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns blocked directly when initial verification is blocked', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'gis-run-worker-verify-blocked-initial-'),
  );
  const issue = {
    id: 'gis-vst.verify-blocked-initial',
    title: 'verify blocked initial',
    description:
      'return blocked when the initial verification cycle is blocked',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  let humanGateCalls = 0;
  let mergeCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'blocked',
            attempts: 1,
            result: { passed: false },
            handoff: {
              worktreePath: join(root, 'worktree'),
              roundLogPath: join(root, 'worktree', '.gis', 'run'),
              transcriptPath: join(root, 'transcript.unresolved'),
            },
            bead: issue,
          };
        },
      },
      merge: {
        async enqueue() {
          mergeCalls += 1;
          throw new Error(
            'merge must not run once initial verification is blocked',
          );
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(mergeCalls, 0);
    assert.equal(humanGateCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports state and cleanup errors surfaced by a merged outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-merge-errors-'));
  const issue = {
    id: 'gis-vst.merge-errors',
    title: 'merge errors',
    description:
      'report state and cleanup errors on an otherwise merged outcome',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const reports = [];
  let markBlockedCalls = 0;
  let humanGateCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          markBlockedCalls += 1;
          throw new Error('markBlocked must not run on a merged outcome');
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'verified',
            attempts: 1,
            result: { passed: true, stdout: '' },
          };
        },
      },
      merge: {
        async enqueue() {
          return {
            status: 'merged',
            stateError: new Error('bd close failed'),
            cleanup: {
              status: 'worktree_failed',
              worktree: {
                status: 'failed',
                attempts: 2,
                error: new Error('worktree remove failed'),
              },
              branch: {
                status: 'not_attempted',
                attempts: 0,
                reason: 'worktree_failed',
              },
              remaining: ['worktree', 'branch'],
            },
            cleanupError: new Error('worktree remove failed'),
          };
        },
      },
      resolveTranscript: async () => undefined,
      report: (message) => reports.push(message),
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'merged' });
    assert.ok(
      reports.some((message) =>
        message.includes('closing the Beads issue failed'),
      ),
    );
    assert.ok(reports.some((message) => message.includes('cleanup failed')));
    assert.ok(
      reports.some((message) =>
        message.includes('worktree was retained at ' + join(root, 'worktree')),
      ),
    );
    assert.equal(markBlockedCalls, 0);
    assert.equal(humanGateCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the legacy cleanupError-only merge result fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-legacy-cleanup-'));
  const issue = {
    id: 'gis-vst.legacy-cleanup',
    title: 'legacy cleanup',
    description: 'exercise the pre-gis-zjr merge result shape',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const reports = [];
  let markBlockedCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          markBlockedCalls += 1;
          throw new Error('markBlocked must not run on a merged outcome');
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'verified',
            attempts: 1,
            result: { passed: true, stdout: '' },
          };
        },
      },
      merge: {
        async enqueue() {
          return {
            status: 'merged',
            cleanupError: new Error('legacy cleanup failure'),
          };
        },
      },
      resolveTranscript: async () => undefined,
      report: (message) => reports.push(message),
      onHumanGate: () => undefined,
    });

    assert.deepEqual(await processor(issue), { status: 'merged' });
    assert.ok(
      reports.some((message) =>
        message.includes('cleanup state could not be determined'),
      ),
    );
    assert.equal(markBlockedCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports a removed worktree when branch cleanup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-branch-cleanup-'));
  const issue = {
    id: 'gis-vst.branch-cleanup',
    title: 'branch cleanup',
    description: 'report a branch-only cleanup failure accurately',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const reports = [];
  let markBlockedCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          markBlockedCalls += 1;
          throw new Error('markBlocked must not run on a merged outcome');
        },
        async createHumanGate() {
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'verified',
            attempts: 1,
            result: { passed: true, stdout: '' },
          };
        },
      },
      merge: {
        async enqueue() {
          return {
            status: 'merged',
            cleanup: {
              status: 'branch_failed',
              worktree: { status: 'removed', attempts: 1 },
              branch: {
                status: 'failed',
                attempts: 2,
                error: new Error('branch deletion failed'),
              },
              remaining: ['branch'],
            },
            cleanupError: new Error('branch deletion failed'),
          };
        },
      },
      resolveTranscript: async () => undefined,
      report: (message) => reports.push(message),
      onHumanGate: () => undefined,
    });

    assert.deepEqual(await processor(issue), { status: 'merged' });
    assert.ok(
      reports.some((message) =>
        message.includes('the worktree was removed but branch deletion failed'),
      ),
    );
    assert.ok(reports.some((message) => message.includes(issue.id)));
    assert.ok(
      reports.every((message) => !message.includes('worktree was retained')),
    );
    assert.equal(markBlockedCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns blocked without re-marking when merge enqueue itself reports blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-merge-blocked-'));
  const issue = {
    id: 'gis-vst.merge-blocked',
    title: 'merge blocked',
    description: 'propagate a blocked outcome reported by merge.enqueue',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const reports = [];
  let markBlockedCalls = 0;
  let humanGateCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked() {
          markBlockedCalls += 1;
          throw new Error(
            'merge.enqueue owns marking blocked on its own outcome',
          );
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'verified',
            attempts: 1,
            result: { passed: true, stdout: '' },
          };
        },
      },
      merge: {
        async enqueue() {
          return {
            status: 'blocked',
            phase: 'merge',
            bead: issue,
            handoff: {
              worktreePath: join(root, 'worktree'),
              roundLogPath: join(root, 'worktree', '.gis', 'run'),
              transcriptPath: join(root, 'transcript.unresolved'),
            },
          };
        },
      },
      resolveTranscript: async () => undefined,
      report: (message) => reports.push(message),
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(markBlockedCalls, 0);
    assert.equal(humanGateCalls, 0);
    assert.ok(
      !reports.some((message) =>
        message.includes('failed while recording recovery state'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks the bead blocked when merge enqueue throws an unexpected error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-run-worker-merge-throws-'));
  const issue = {
    id: 'gis-vst.merge-throws',
    title: 'merge throws',
    description: 'record a blocked handoff when merge.enqueue raises',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  };
  const resultPath = join(root, 'result.json');
  const blocked = [];
  let humanGateCalls = 0;

  await writeFile(
    resultPath,
    JSON.stringify({ status: 'done', summary: 'implemented' }),
  );

  try {
    const processor = createBeadJobProcessor({
      cwd: root,
      config,
      beads: {
        async dispatch() {
          return { ...issue, status: 'in_progress' };
        },
        async markBlocked(id, locations) {
          blocked.push([id, locations]);
          return { ...issue, status: 'blocked' };
        },
        async createHumanGate() {
          humanGateCalls += 1;
          throw new Error('human gate must not run');
        },
      },
      herdr: {},
      worktrees: {
        async create() {
          return {
            beadId: issue.id,
            path: join(root, 'worktree'),
            runPath: join(root, 'worktree', '.gis', 'run'),
            workspaceId: 'workspace',
            paneId: 'pane',
            async remove() {},
          };
        },
      },
      workers: {
        async start() {
          return {
            prompt: { resultPath },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: 'done', wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return {
            status: 'verified',
            attempts: 1,
            result: { passed: true, stdout: '' },
          };
        },
      },
      merge: {
        async enqueue() {
          throw new Error('merge queue crashed');
        },
      },
      resolveTranscript: async () => undefined,
      report: () => undefined,
      onHumanGate: () => undefined,
    });

    const outcome = await processor(issue);

    assert.deepEqual(outcome, { status: 'blocked' });
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0][0], issue.id);
    assert.equal(humanGateCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
