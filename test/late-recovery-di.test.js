import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverLateCompletions } from '../dist/late-recovery.js';

const baseConfig = {
  concurrency: 1,
  base: 'main',
  verify: 'true',
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

function lateCommitBead(id) {
  return {
    id,
    title: id,
    description: 'late recovery DI fixture',
    status: 'blocked',
    priority: 2,
    issue_type: 'task',
    notes: 'failure phase: commit\nno commit ahead of base',
  };
}

/** currentResult() reads the prompt/result files directly from disk (it is
 * not behind an injectable seam), so this fixture still needs real files —
 * everything else in this test is an in-memory fake: no PATH shims, no
 * child processes, no herdr socket server. */
async function writeSuccessfulRun(worktreePath, runId = 'run-1') {
  const runPath = join(worktreePath, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const prompt = [
    '# gis worker task',
    '',
    `- Run ID: \`${runId}\``,
    '',
    '## Result file',
    '',
    'Before finishing, write a JSON result to `.gis/run/round-1-impl.json`.',
    '',
  ].join('\n');
  await writeFile(join(runPath, 'implement-prompt.md'), prompt, 'utf8');
  await writeFile(
    join(runPath, 'round-1-impl.json'),
    JSON.stringify({
      run_id: runId,
      status: 'done',
      summary: 'late completion recovered',
    }),
    'utf8',
  );
}

test('DI seam: recovers a late completion using only in-memory fakes (no PATH shims, no herdr socket)', async (t) => {
  const beadId = 'gis-di.1';
  const bead = lateCommitBead(beadId);
  const root = await mkdtemp(join(tmpdir(), 'gis-late-recovery-di-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeSuccessfulRun(worktreePath);

  const beadsCalls = [];
  const beads = {
    listBlocked: async () => [bead],
    markMerged: async (issueId, reason) => {
      beadsCalls.push(['markMerged', issueId, reason]);
      return { id: issueId };
    },
    markBlocked: async (issueId, locations) => {
      beadsCalls.push(['markBlocked', issueId, locations]);
      return { id: issueId, status: 'blocked' };
    },
  };

  const herdrCalls = [];
  const workspaceId = `ws-${beadId}`;
  const herdr = {
    apiSnapshot: async () => ({
      snapshot: {
        workspaces: [
          {
            workspace_id: workspaceId,
            worktree: { checkout_path: worktreePath },
          },
        ],
        panes: [],
      },
    }),
    worktreeRemove: async (id, options) => {
      herdrCalls.push(['worktreeRemove', id, options]);
      return {
        type: 'worktree_removed',
        workspace_id: id,
        path: worktreePath,
        forced: true,
      };
    },
  };

  const worktreeGit = {
    listWorktrees: async () => [
      {
        path: worktreePath,
        branch: beadId,
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ],
  };

  const mergeGitCalls = [];
  const mergeGit = {
    hasCommits: async (path, base) => {
      mergeGitCalls.push(['hasCommits', path, base]);
      return true;
    },
    rebase: async (path, base) => {
      mergeGitCalls.push(['rebase', path, base]);
    },
    merge: async (repoPath, branch) => {
      mergeGitCalls.push(['merge', repoPath, branch]);
    },
    deleteBranch: async (repoPath, branch) => {
      mergeGitCalls.push(['deleteBranch', repoPath, branch]);
    },
  };

  const runVerifyCalls = [];
  const runVerify = async (command, cwd, timeoutMs) => {
    runVerifyCalls.push(['runVerify', command, cwd, timeoutMs]);
    return { passed: true, stdout: '', stderr: '', exitCode: 0 };
  };

  const reports = [];
  const started = performance.now();
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads,
    herdr,
    worktreeGit,
    mergeGit,
    runVerify,
  });
  const elapsedMs = performance.now() - started;

  assert.equal(merged, 1);
  assert.ok(
    reports.some((message) =>
      message.includes(`resuming late completion for ${beadId}`),
    ),
  );
  assert.ok(
    !reports.some((message) => message.includes('recovery failed')),
    `unexpected failure reports: ${reports.join(' | ')}`,
  );

  // The runVerify seam actually fired: proof this path no longer needs a
  // real child process for `config.verify`.
  assert.equal(runVerifyCalls.length, 1);
  assert.equal(runVerifyCalls[0][1], baseConfig.verify);

  assert.deepEqual(
    beadsCalls.map((call) => call[0]),
    ['markMerged'],
  );
  assert.deepEqual(
    herdrCalls.map((call) => call[0]),
    ['worktreeRemove'],
  );
  assert.deepEqual(
    mergeGitCalls.map((call) => call[0]),
    ['hasCommits', 'rebase', 'hasCommits', 'merge', 'deleteBranch'],
  );

  // Informational only: compare against the ~250ms/test PATH-shim + socket
  // baseline in test/late-recovery.test.js.
  t.diagnostic(`DI-seam test elapsed: ${elapsedMs.toFixed(2)}ms`);
});
