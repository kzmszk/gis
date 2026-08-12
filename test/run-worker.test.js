import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBeadJobProcessor } from '../dist/run-worker.js';
import { WorkerStartupError } from '../dist/worker.js';
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
