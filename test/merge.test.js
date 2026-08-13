import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialMergeQueue, runMergeQueue } from '../dist/merge.js';

const bead = (id) => ({ id });

function item(id, events) {
  return {
    bead: bead(id),
    worktree: {
      path: `/repo/.worktrees/${id}`,
      runPath: `/repo/.worktrees/${id}/.gis/run`,
      async remove() {
        events.push(`${id}:remove`);
      },
    },
    transcriptPath: `/home/kazu/.codex/sessions/${id}.jsonl`,
  };
}

function options(events, overrides = {}) {
  return {
    repositoryPath: '/repo',
    baseBranch: 'main',
    verifyCommand: 'npm test',
    verifyTimeout: '15m',
    git: {
      async rebase(worktreePath, baseBranch) {
        events.push(`rebase:${worktreePath}:${baseBranch}`);
      },
      async hasCommits() {
        return true;
      },
      async merge(repositoryPath, branch) {
        events.push(`merge:${repositoryPath}:${branch}`);
      },
      async deleteBranch() {},
    },
    runVerify: async (command, cwd) => {
      events.push(`verify:${command}:${cwd}`);
      return { passed: true, stdout: 'ok' };
    },
    beads: {
      async markMerged(issueId, reason) {
        events.push(`close:${issueId}:${reason}`);
        return {
          ...bead(issueId),
          title: issueId,
          description: '',
          status: 'closed',
          priority: 1,
          issue_type: 'task',
        };
      },
      async markBlocked(issueId, locations) {
        events.push(`blocked:${issueId}:${locations.worktreePath}`);
        return {
          ...bead(issueId),
          title: issueId,
          description: '',
          status: 'blocked',
          priority: 1,
          issue_type: 'task',
        };
      },
    },
    ...overrides,
  };
}

test('runs each merge lifecycle in order and removes only after bd close', async () => {
  const events = [];
  const queue = new SerialMergeQueue(options(events));
  const result = await queue.enqueue(item('gis-vst.10', events));

  assert.equal(result.status, 'merged');
  assert.deepEqual(events, [
    'rebase:/repo/.worktrees/gis-vst.10:main',
    'verify:npm test:/repo/.worktrees/gis-vst.10',
    'merge:/repo:gis-vst.10',
    'close:gis-vst.10:merged after rebase and verify',
    'gis-vst.10:remove',
  ]);
});

test('does not re-block a closed bead when cleanup fails after merge', async () => {
  const events = [];
  const result = await new SerialMergeQueue(options(events)).enqueue({
    ...item('gis-vst.10', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.10',
      runPath: '/repo/.worktrees/gis-vst.10/.gis/run',
      async remove() {
        events.push('gis-vst.10:remove-failed');
        throw new Error('herdr unavailable');
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.match(String(result.cleanupError), /herdr unavailable/);
  assert.deepEqual(events, [
    'rebase:/repo/.worktrees/gis-vst.10:main',
    'verify:npm test:/repo/.worktrees/gis-vst.10',
    'merge:/repo:gis-vst.10',
    'close:gis-vst.10:merged after rebase and verify',
    'gis-vst.10:remove-failed',
    'gis-vst.10:remove-failed',
  ]);
});

test('preserves the first cleanup error when a retry rejects with a nullish value', async () => {
  const events = [];
  const base = options(events);
  let removeCalls = 0;
  const result = await new SerialMergeQueue(base).enqueue({
    ...item('gis-vst.cleanup-nullish', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.cleanup-nullish',
      runPath: '/repo/.worktrees/gis-vst.cleanup-nullish/.gis/run',
      async remove() {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error('first cleanup failure');
        throw undefined;
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'worktree_failed');
  assert.match(String(result.cleanupError), /first cleanup failure/);
  assert.match(String(result.cleanup?.worktree.error), /first cleanup failure/);
  assert.equal(result.cleanup?.worktree.attempts, 2);
});

test('reports a failed worktree removal separately and does not attempt branch deletion', async () => {
  const events = [];
  const base = options(events);
  let deleteCalls = 0;
  const result = await new SerialMergeQueue({
    ...base,
    git: {
      ...base.git,
      async deleteBranch() {
        deleteCalls += 1;
      },
    },
  }).enqueue({
    ...item('gis-vst.cleanup-worktree', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.cleanup-worktree',
      runPath: '/repo/.worktrees/gis-vst.cleanup-worktree/.gis/run',
      async remove() {
        events.push('remove-failed');
        throw new Error('worktree unavailable');
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'worktree_failed');
  assert.equal(result.cleanup?.worktree.status, 'failed');
  assert.equal(result.cleanup?.worktree.attempts, 2);
  assert.equal(result.cleanup?.branch.status, 'not_attempted');
  assert.deepEqual(result.cleanup?.remaining, ['worktree', 'branch']);
  assert.equal(deleteCalls, 0);
});

test('reports branch deletion failure after worktree removal without retrying removal', async () => {
  const events = [];
  const base = options(events);
  let removeCalls = 0;
  let deleteCalls = 0;
  const result = await new SerialMergeQueue({
    ...base,
    git: {
      ...base.git,
      async deleteBranch() {
        deleteCalls += 1;
        throw new Error('branch is locked');
      },
    },
  }).enqueue({
    ...item('gis-vst.cleanup-branch', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.cleanup-branch',
      runPath: '/repo/.worktrees/gis-vst.cleanup-branch/.gis/run',
      async remove() {
        removeCalls += 1;
        events.push('remove');
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'branch_failed');
  assert.equal(result.cleanup?.worktree.status, 'removed');
  assert.equal(result.cleanup?.worktree.attempts, 1);
  assert.equal(result.cleanup?.branch.status, 'failed');
  assert.equal(result.cleanup?.branch.attempts, 2);
  assert.deepEqual(result.cleanup?.remaining, ['branch']);
  assert.equal(removeCalls, 1);
  assert.equal(deleteCalls, 2);
});

test('preserves a same-stage branch error when the branch retry rejects nullish', async () => {
  const events = [];
  const base = options(events);
  let deleteCalls = 0;
  const result = await new SerialMergeQueue({
    ...base,
    git: {
      ...base.git,
      async deleteBranch() {
        deleteCalls += 1;
        if (deleteCalls === 1) throw new Error('first branch failure');
        throw null;
      },
    },
  }).enqueue(item('gis-vst.cleanup-branch-nullish', events));

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'branch_failed');
  assert.equal(result.cleanup?.branch.attempts, 2);
  assert.match(String(result.cleanup?.branch.error), /first branch failure/);
  assert.match(String(result.cleanupError), /first branch failure/);
  assert.equal(deleteCalls, 2);
});

test('retries only incomplete cleanup stages and converges after a transient worktree failure', async () => {
  const events = [];
  const base = options(events);
  let removeCalls = 0;
  let deleteCalls = 0;
  const result = await new SerialMergeQueue({
    ...base,
    git: {
      ...base.git,
      async deleteBranch() {
        deleteCalls += 1;
      },
    },
  }).enqueue({
    ...item('gis-vst.cleanup-retry', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.cleanup-retry',
      runPath: '/repo/.worktrees/gis-vst.cleanup-retry/.gis/run',
      async remove() {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error('worktree busy');
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'cleaned');
  assert.equal(result.cleanup?.worktree.attempts, 2);
  assert.equal(result.cleanup?.branch.attempts, 1);
  assert.equal(removeCalls, 2);
  assert.equal(deleteCalls, 1);
});

test('reports a compound cleanup failure after worktree retry without re-blocking', async () => {
  const events = [];
  let removeCalls = 0;
  let deleteCalls = 0;
  let blockedCalls = 0;
  const base = options(events);
  const result = await new SerialMergeQueue({
    ...base,
    beads: {
      ...base.beads,
      async markBlocked() {
        blockedCalls += 1;
        throw new Error('must not re-block a merged bead');
      },
    },
    git: {
      ...base.git,
      async deleteBranch() {
        deleteCalls += 1;
        throw null;
      },
    },
  }).enqueue({
    ...item('gis-vst.cleanup-compound', events),
    worktree: {
      path: '/repo/.worktrees/gis-vst.cleanup-compound',
      runPath: '/repo/.worktrees/gis-vst.cleanup-compound/.gis/run',
      async remove() {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error('worktree busy');
      },
    },
  });

  assert.equal(result.status, 'merged');
  assert.equal(result.cleanup?.status, 'branch_failed');
  assert.equal(result.cleanup?.worktree.status, 'removed');
  assert.equal(result.cleanup?.worktree.attempts, 2);
  assert.equal(result.cleanup?.branch.status, 'failed');
  assert.equal(result.cleanup?.branch.attempts, 1);
  assert.equal(result.cleanup?.branch.error, null);
  assert.deepEqual(result.cleanup?.remaining, ['branch']);
  assert.match(String(result.cleanupError), /worktree busy/);
  assert.equal(removeCalls, 2);
  assert.equal(deleteCalls, 1);
  assert.equal(blockedCalls, 0);
});

test('serializes concurrent enqueue calls and continues after a blocked item', async () => {
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const git = {
    async rebase(worktreePath) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      events.push(`rebase:${worktreePath}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
    async hasCommits() {
      return true;
    },
    async merge(repositoryPath, branch) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      events.push(`merge:${repositoryPath}:${branch}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
    async deleteBranch() {},
  };
  const verifyCalls = [];
  const queue = new SerialMergeQueue(
    options(events, {
      git,
      runVerify: async (_command, cwd) => {
        verifyCalls.push(cwd);
        return cwd.endsWith('gis-vst.10')
          ? { passed: false, stderr: 'conflict after rebase' }
          : { passed: true };
      },
    }),
  );

  const first = item('gis-vst.10', events);
  const second = item('gis-vst.12', events);
  const results = await Promise.all([
    queue.enqueue(first),
    queue.enqueue(second),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ['blocked', 'merged'],
  );
  assert.equal(maximumActive, 1);
  assert.deepEqual(verifyCalls, [
    '/repo/.worktrees/gis-vst.10',
    '/repo/.worktrees/gis-vst.12',
  ]);
  assert.deepEqual(events, [
    'rebase:/repo/.worktrees/gis-vst.10',
    'blocked:gis-vst.10:/repo/.worktrees/gis-vst.10',
    'rebase:/repo/.worktrees/gis-vst.12',
    'merge:/repo:gis-vst.12',
    'close:gis-vst.12:merged after rebase and verify',
    'gis-vst.12:remove',
  ]);
});

test('does not merge, close, or remove before a successful post-rebase verify', async () => {
  const events = [];
  const result = await runMergeQueue(
    [item('gis-vst.10', events)],
    options(events, {
      runVerify: async () => ({
        passed: false,
        exitCode: 1,
        stderr: 'still failing',
      }),
    }),
  );

  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].phase, 'verify');
  assert.deepEqual(result[0].handoff, {
    worktreePath: '/repo/.worktrees/gis-vst.10',
    roundLogPath: '/repo/.worktrees/gis-vst.10/.gis/run',
    transcriptPath: '/home/kazu/.codex/sessions/gis-vst.10.jsonl',
    failurePhase: 'verify',
    failureDetail: 'verification failed (exit code 1)\nstill failing',
  });
  assert.deepEqual(events, [
    'rebase:/repo/.worktrees/gis-vst.10:main',
    'blocked:gis-vst.10:/repo/.worktrees/gis-vst.10',
  ]);
});

test('blocks a verification runner exception without cleanup', async () => {
  const events = [];
  const result = await new SerialMergeQueue(
    options(events, {
      runVerify: async () => {
        throw new Error('verification process could not start');
      },
    }),
  ).enqueue(item('gis-vst.10', events));

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'verify');
  assert.match(String(result.error), /verification process could not start/);
  assert.deepEqual(events, [
    'rebase:/repo/.worktrees/gis-vst.10:main',
    'blocked:gis-vst.10:/repo/.worktrees/gis-vst.10',
  ]);
});

test('blocks and retains the worktree when rebase fails', async () => {
  const events = [];
  const result = await new SerialMergeQueue(
    options(events, {
      git: {
        async rebase() {
          throw new Error('rebase conflict');
        },
        async hasCommits() {
          return true;
        },
        async merge() {
          events.push('merge');
        },
        async deleteBranch() {},
      },
    }),
  ).enqueue(item('gis-vst.10', events));

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'rebase');
  assert.match(String(result.error), /rebase conflict/);
  assert.deepEqual(events, ['blocked:gis-vst.10:/repo/.worktrees/gis-vst.10']);
});

test('blocks a bead whose branch has no commit ahead of base', async () => {
  const events = [];
  const result = await new SerialMergeQueue(
    options(events, {
      git: {
        async rebase() {},
        async hasCommits() {
          return false;
        },
        async merge() {
          events.push('merge');
        },
        async deleteBranch() {},
      },
    }),
  ).enqueue(item('gis-vst.empty', events));

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'commit');
  assert.match(String(result.error), /no commit ahead/);
  assert.deepEqual(events, [
    'blocked:gis-vst.empty:/repo/.worktrees/gis-vst.empty',
  ]);
});

test('blocks commits containing GIS runtime artifacts', async () => {
  const events = [];
  const base = options(events);
  const result = await new SerialMergeQueue(
    options(events, {
      git: {
        ...base.git,
        async changedPaths() {
          return ['src/feature.ts', '.gis/run/round-1-impl.json'];
        },
      },
    }),
  ).enqueue(item('gis-vst.artifact', events));

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'commit');
  assert.match(String(result.error), /GIS runtime artifacts/);
  assert.equal(
    events.some((event) => event.startsWith('merge:')),
    false,
  );
});

test('does not re-block after git merge when closing the bead fails', async () => {
  const events = [];
  const result = await new SerialMergeQueue(
    options(events, {
      beads: {
        async markMerged() {
          events.push('close-failed');
          throw new Error('bd locked');
        },
        async markBlocked() {
          events.push('blocked');
          throw new Error('must not re-block an integrated bead');
        },
      },
    }),
  ).enqueue(item('gis-vst.integrated', events));

  assert.equal(result.status, 'merged');
  assert.match(String(result.stateError), /bd locked/);
  assert.equal(events.includes('blocked'), false);
  assert.equal(events.includes('gis-vst.integrated:remove'), false);
});
