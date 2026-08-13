import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverLateCompletions } from '../dist/late-recovery.js';
import { writeRecoveryMetadata } from '../dist/recovery-manifest.js';
import { herdrAgentName } from '../dist/worker.js';
import { reconcileStartup } from '../dist/recovery.js';

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

function lateCommitBead(id, overrides = {}) {
  return {
    id,
    title: id,
    description: 'late recovery fixture',
    status: 'blocked',
    priority: 2,
    issue_type: 'task',
    notes: 'failure phase: commit\nno commit ahead of base',
    ...overrides,
  };
}

/** currentResult() reads the prompt/result files directly from disk (it is
 * not behind an injectable seam), so any test that needs a successful run
 * still needs real files on disk. Everything else -- beads, herdr, worktree
 * listing, and merge git operations -- is an in-memory fake: no PATH shims,
 * no child processes, no herdr socket server. */
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

async function writeStructuredSuccessfulRun(
  worktreePath,
  {
    beadId = 'gis-structured.1',
    runId = 'structured-run',
    resultPath = '.gis/run/structured.json',
  } = {},
) {
  const absoluteResultPath = join(worktreePath, resultPath);
  await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
  await mkdir(join(absoluteResultPath, '..'), { recursive: true });
  await writeFile(
    absoluteResultPath,
    JSON.stringify({
      run_id: runId,
      status: 'done',
      summary: 'structured late completion recovered',
    }),
    'utf8',
  );
  await writeRecoveryMetadata(worktreePath, {
    version: 1,
    beadId,
    agentName: herdrAgentName(beadId),
    runId,
    resultPath,
    failureCode: 'commit',
    role: 'implement',
  });
}

/** Writes a prompt but never a result file: currentResult() must resolve to
 * undefined instead of throwing. */
async function writeDispatchedButUnfinishedRun(worktreePath, runId = 'run-1') {
  const runPath = join(worktreePath, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  await writeFile(
    join(runPath, 'implement-prompt.md'),
    [
      '# gis worker task',
      '',
      `- Run ID: \`${runId}\``,
      '',
      'Before finishing, write a JSON result to `.gis/run/round-1-impl.json`.',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** Creates a fresh temp root and registers its cleanup with `t`. */
async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'gis-late-recovery-migrated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** In-memory beads fake that records every markMerged/markBlocked call. */
function makeBeadsSource(blocked) {
  const calls = [];
  return {
    calls,
    source: {
      listBlocked: async () => blocked,
      markMerged: async (issueId, reason) => {
        calls.push(['markMerged', issueId, reason]);
        return { id: issueId, status: 'closed' };
      },
      markBlocked: async (issueId, locations) => {
        calls.push(['markBlocked', issueId, locations]);
        return { id: issueId, status: 'blocked' };
      },
    },
  };
}

/** In-memory herdr fake driven by a workspace list; records every call. */
function makeHerdr(workspaces) {
  const calls = [];
  return {
    calls,
    herdr: {
      apiSnapshot: async () => ({
        snapshot: { workspaces, panes: [] },
      }),
      worktreeRemove: async (id, options) => {
        calls.push(['worktreeRemove', id, options]);
        return {
          type: 'worktree_removed',
          workspace_id: id,
          path: '',
          forced: options?.force ?? false,
        };
      },
    },
  };
}

/** In-memory git-worktree-listing fake for the `worktreeGit` seam. */
function makeWorktreeGit(worktrees) {
  return { listWorktrees: async () => worktrees };
}

/** In-memory `mergeGit` fake. `hasCommitsByPath` maps a worktree path to
 * either a boolean answer or a function producing/throwing one, so a single
 * test can give two worktrees different commit states (including one that
 * throws, mirroring the old PATH-shim test's non-numeric rev-count case). */
function makeMergeGit(hasCommitsByPath = {}) {
  const calls = [];
  return {
    calls,
    mergeGit: {
      hasCommits: async (path, base) => {
        calls.push(['hasCommits', path, base]);
        const answer = hasCommitsByPath[path];
        if (typeof answer === 'function') return answer();
        return answer ?? true;
      },
      rebase: async (path, base) => {
        calls.push(['rebase', path, base]);
      },
      changedPaths: async (path, base) => {
        calls.push(['changedPaths', path, base]);
        return [];
      },
      merge: async (repoPath, branch) => {
        calls.push(['merge', repoPath, branch]);
      },
      deleteBranch: async (repoPath, branch) => {
        calls.push(['deleteBranch', repoPath, branch]);
      },
    },
  };
}

function makeRunVerify(passed = true) {
  const calls = [];
  return {
    calls,
    runVerify: async (command, cwd, timeoutMs) => {
      calls.push(['runVerify', command, cwd, timeoutMs]);
      return passed
        ? { passed: true, stdout: '', stderr: '', exitCode: 0 }
        : { passed: false, stdout: '', stderr: 'boom', exitCode: 1 };
    },
  };
}

test('recovers a late-completed bead: rebases, verifies, merges, closes it, and removes only its own worktree', async (t) => {
  const beadId = 'gis-late.1';
  const decoyId = 'gis-late.decoy';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  const decoyWorktreePath = join(root, 'worktrees', decoyId);
  await mkdir(worktreePath, { recursive: true });
  await mkdir(decoyWorktreePath, { recursive: true });
  await writeSuccessfulRun(worktreePath);

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([
    // A decoy workspace pointing at an unrelated checkout path: the code
    // must select the workspace by exact checkout_path match.
    {
      workspace_id: `ws-${decoyId}`,
      worktree: { checkout_path: decoyWorktreePath },
    },
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    // The decoy is listed first on purpose: the code must select the
    // worktree by exact branch match, not just take whatever is first.
    {
      path: decoyWorktreePath,
      branch: decoyId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });
  const runVerify = makeRunVerify(true);

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
    runVerify: runVerify.runVerify,
  });

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

  const removeCall = herdr.calls.find((call) => call[0] === 'worktreeRemove');
  assert.ok(removeCall, 'worktreeRemove should have been called');
  assert.equal(
    removeCall[1],
    `ws-${beadId}`,
    'must remove the workspace matched to this bead, not the decoy',
  );
  assert.equal(
    removeCall[2]?.force,
    true,
    'a late-recovered worktree must be force-removed since it may still be attached to a pane',
  );

  assert.deepEqual(mergeGit.calls, [
    // recoverLateCompletions's own hasCommits() gate, before it even reads
    // currentResult() or enqueues the merge.
    ['hasCommits', worktreePath, baseConfig.base],
    // The merge queue then re-does rebase/hasCommits/changedPaths itself,
    // scoped to this bead's worktree (not the decoy) and the configured
    // base branch (not some other value).
    ['rebase', worktreePath, baseConfig.base],
    ['hasCommits', worktreePath, baseConfig.base],
    ['changedPaths', worktreePath, baseConfig.base],
    ['merge', root, beadId],
    ['deleteBranch', root, beadId],
  ]);

  assert.deepEqual(
    beadsSource.calls.map((call) => call[0]),
    ['markMerged'],
  );
  assert.deepEqual(beadsSource.calls[0][1], beadId);
});

test('uses structured recovery metadata before legacy notes or prompt text', async (t) => {
  const beadId = 'gis-structured.1';
  const bead = lateCommitBead(beadId, { notes: undefined });
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeStructuredSuccessfulRun(worktreePath, { beadId });
  // A conflicting prompt is intentionally present: metadata is the primary
  // protocol and must select the structured result path/run ID instead.
  await writeFile(
    join(worktreePath, '.gis', 'run', 'implement-prompt.md'),
    'write a JSON result to `../../outside.json`\nRun ID: `wrong`\n',
    'utf8',
  );

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
    runVerify: makeRunVerify(true).runVerify,
  });

  assert.equal(merged, 1);
  assert.ok(mergeGit.calls.some((call) => call[0] === 'merge'));
});

test('routes a completed startup handoff through blocked state and SerialMergeQueue', async (t) => {
  const beadId = 'gis-startup-late.1';
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeStructuredSuccessfulRun(worktreePath, { beadId });
  const pending = lateCommitBead(beadId, { notes: undefined });
  const blocked = [];
  const updates = [];
  const workspace = {
    workspace_id: `ws-${beadId}`,
    label: beadId,
    worktree: { checkout_path: worktreePath },
  };
  const pane = {
    pane_id: `pane-${beadId}`,
    workspace_id: workspace.workspace_id,
    tab_id: `tab-${beadId}`,
    name: herdrAgentName(beadId),
    agent_status: 'done',
    agent_session: {
      source: 'test',
      agent: 'codex',
      kind: 'path',
      value: join(worktreePath, '.gis', 'run', 'worker.jsonl'),
    },
  };
  const source = {
    listInProgress: async () => [pending],
    listBlocked: async () => blocked,
    update: async (id, update) => {
      updates.push({ id, update });
      return { ...pending, status: update.status };
    },
    markBlocked: async (id, locations) => {
      blocked.push({ ...pending, status: 'blocked' });
      updates.push({ id, locations });
      return { ...pending, status: 'blocked' };
    },
    markMerged: async (id) => ({ ...pending, id, status: 'closed' }),
  };
  const startup = await reconcileStartup({
    cwd: root,
    beads: source,
    herdr: {
      apiSnapshot: async () => ({
        type: 'session_snapshot',
        snapshot: {
          version: '0.7.5',
          protocol: 17,
          workspaces: [workspace],
          tabs: [],
          panes: [pane],
          agents: [],
          layouts: [],
        },
      }),
    },
    git: {
      listWorktrees: async () => [
        {
          path: worktreePath,
          branch: beadId,
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ],
    },
  });
  assert.deepEqual(startup.reopenedIssueIds, []);
  assert.deepEqual(startup.blockedIssueIds, [beadId]);
  assert.deepEqual(
    updates.map((entry) => entry.update),
    [undefined],
  );

  const herdr = makeHerdr([workspace]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    beads: source,
    herdr: herdr.herdr,
    worktreeGit: makeWorktreeGit([
      {
        path: worktreePath,
        branch: beadId,
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ]),
    mergeGit: mergeGit.mergeGit,
    runVerify: makeRunVerify(true).runVerify,
  });
  assert.equal(merged, 1);
  assert.ok(mergeGit.calls.some((call) => call[0] === 'merge'));
});

test('does not recover unknown metadata even when legacy notes claim commit failure', async (t) => {
  const beadId = 'gis-structured-authoritative.1';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
  const resultPath = '.gis/run/authoritative.json';
  await writeFile(
    join(worktreePath, resultPath),
    JSON.stringify({ run_id: 'run-1', status: 'done', summary: 'done' }),
    'utf8',
  );
  await writeRecoveryMetadata(worktreePath, {
    version: 1,
    beadId,
    agentName: herdrAgentName(beadId),
    runId: 'run-1',
    resultPath,
    failureCode: 'unknown',
    role: 'implement',
  });
  const herdr = makeHerdr([
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    beads: makeBeadsSource([bead]).source,
    herdr: herdr.herdr,
    worktreeGit: makeWorktreeGit([
      {
        path: worktreePath,
        branch: beadId,
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ]),
    mergeGit: mergeGit.mergeGit,
    runVerify: makeRunVerify(true).runVerify,
  });
  assert.equal(merged, 0);
  assert.equal(herdr.calls.length, 0);
});

test('retains a worktree and reports metadata path/run contradictions', async (t) => {
  const root = await makeRoot(t);
  const cases = [
    {
      label: 'path traversal',
      resultPath: '../../outside.json',
      runId: 'run-1',
    },
    {
      label: 'run mismatch',
      resultPath: '.gis/run/result.json',
      runId: 'expected',
    },
  ];
  for (const item of cases) {
    const beadId = `gis-structured-${item.label.replaceAll(' ', '-')}`;
    const bead = lateCommitBead(beadId, { notes: undefined });
    const worktreePath = join(root, item.label.replaceAll(' ', '-'));
    await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
    const resultPath = join(worktreePath, '.gis', 'run', 'result.json');
    await writeFile(
      resultPath,
      JSON.stringify({
        run_id: item.label === 'run mismatch' ? 'actual' : item.runId,
        status: 'done',
        summary: 'contradiction fixture',
      }),
      'utf8',
    );
    await writeRecoveryMetadata(worktreePath, {
      version: 1,
      beadId,
      agentName: beadId,
      runId: item.runId,
      resultPath: item.resultPath,
      failureCode: 'commit',
      role: 'implement',
    });
    const beadsSource = makeBeadsSource([bead]);
    const herdr = makeHerdr([
      {
        workspace_id: `ws-${beadId}`,
        worktree: { checkout_path: worktreePath },
      },
    ]);
    const worktreeGit = makeWorktreeGit([
      {
        path: worktreePath,
        branch: beadId,
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ]);
    const mergeGit = makeMergeGit({ [worktreePath]: true });
    const reports = [];
    const merged = await recoverLateCompletions({
      cwd: root,
      config: baseConfig,
      report: (message) => reports.push(message),
      beads: beadsSource.source,
      herdr: herdr.herdr,
      worktreeGit,
      mergeGit: mergeGit.mergeGit,
      runVerify: makeRunVerify(true).runVerify,
    });
    assert.equal(merged, 0, item.label);
    assert.equal(herdr.calls.length, 0, `${item.label}: worktree must remain`);
    assert.ok(
      reports.some((message) =>
        message.includes(
          item.label === 'path traversal'
            ? 'escapes worktree'
            : 'run ID mismatch',
        ),
      ),
      `${item.label}: expected a contradiction diagnostic`,
    );
  }
});

test('reports non-success results for structured recoverable metadata', async (t) => {
  const root = await makeRoot(t);
  for (const [label, result] of [
    ['missing', undefined],
    [
      'failure',
      { run_id: 'run-1', status: 'failed', summary: 'worker failed' },
    ],
    [
      'needs_human',
      { run_id: 'run-1', status: 'done', summary: 'pause', needs_human: 'ask' },
    ],
  ]) {
    const beadId = `gis-structured-${label}`;
    const bead = lateCommitBead(beadId, { notes: undefined });
    const worktreePath = join(root, label);
    await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
    const resultPath = '.gis/run/result.json';
    if (result !== undefined) {
      await writeFile(
        join(worktreePath, resultPath),
        JSON.stringify(result),
        'utf8',
      );
    }
    await writeRecoveryMetadata(worktreePath, {
      version: 1,
      beadId,
      agentName: herdrAgentName(beadId),
      runId: 'run-1',
      resultPath,
      failureCode: 'ready_to_merge',
      role: 'implement',
    });
    const reports = [];
    const herdr = makeHerdr([
      {
        workspace_id: `ws-${beadId}`,
        worktree: { checkout_path: worktreePath },
      },
    ]);
    const merged = await recoverLateCompletions({
      cwd: root,
      config: baseConfig,
      report: (message) => reports.push(message),
      beads: makeBeadsSource([bead]).source,
      herdr: herdr.herdr,
      worktreeGit: makeWorktreeGit([
        {
          path: worktreePath,
          branch: beadId,
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ]),
      mergeGit: makeMergeGit({ [worktreePath]: true }).mergeGit,
      runVerify: makeRunVerify(true).runVerify,
    });
    assert.equal(merged, 0, label);
    assert.equal(herdr.calls.length, 0, `${label}: retain worktree`);
    assert.ok(
      reports.some((message) =>
        message.includes(`non-success result ${label}`),
      ),
    );
  }
});

test('retains mismatched structured identity and reports a concrete diagnostic', async (t) => {
  const root = await makeRoot(t);
  for (const [label, override] of [
    ['beadId', { beadId: 'gis-other-bead' }],
    ['agentName', { agentName: herdrAgentName('gis-other-agent') }],
  ]) {
    const beadId = `gis-structured-identity-${label}`;
    const bead = lateCommitBead(beadId, { notes: undefined });
    const worktreePath = join(root, label);
    await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
    const resultPath = '.gis/run/result.json';
    await writeFile(
      join(worktreePath, resultPath),
      JSON.stringify({ run_id: 'run-1', status: 'done', summary: 'done' }),
      'utf8',
    );
    await writeRecoveryMetadata(worktreePath, {
      version: 1,
      beadId,
      agentName: herdrAgentName(beadId),
      runId: 'run-1',
      resultPath,
      failureCode: 'ready_to_merge',
      role: 'implement',
      ...override,
    });
    const reports = [];
    const herdr = makeHerdr([
      {
        workspace_id: `ws-${beadId}`,
        worktree: { checkout_path: worktreePath },
      },
    ]);
    const merged = await recoverLateCompletions({
      cwd: root,
      config: baseConfig,
      report: (message) => reports.push(message),
      beads: makeBeadsSource([bead]).source,
      herdr: herdr.herdr,
      worktreeGit: makeWorktreeGit([
        {
          path: worktreePath,
          branch: beadId,
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ]),
      mergeGit: makeMergeGit({ [worktreePath]: true }).mergeGit,
      runVerify: makeRunVerify(true).runVerify,
    });
    assert.equal(merged, 0, label);
    assert.equal(herdr.calls.length, 0, `${label}: no worktree removal`);
    assert.ok(
      reports.some((message) => message.includes(`metadata ${label}`)),
      `${label}: expected identity diagnostic`,
    );
  }
});

test('does not recover review-blocked or human-gated metadata despite a successful result', async (t) => {
  const root = await makeRoot(t);
  for (const failureCode of ['review_blocked', 'human_gate']) {
    const beadId = `gis-review-terminal-${failureCode}`;
    const bead = lateCommitBead(beadId);
    const worktreePath = join(root, failureCode);
    await mkdir(join(worktreePath, '.gis', 'run'), { recursive: true });
    const resultPath = '.gis/run/result.json';
    await writeFile(
      join(worktreePath, resultPath),
      JSON.stringify({ run_id: 'run-1', status: 'done', summary: 'done' }),
      'utf8',
    );
    await writeRecoveryMetadata(worktreePath, {
      version: 1,
      beadId,
      agentName: herdrAgentName(beadId),
      runId: 'run-1',
      resultPath,
      failureCode,
      role: 'implement',
    });
    const herdr = makeHerdr([
      {
        workspace_id: `ws-${beadId}`,
        worktree: { checkout_path: worktreePath },
      },
    ]);
    const mergeGit = makeMergeGit({ [worktreePath]: true });
    const merged = await recoverLateCompletions({
      cwd: root,
      config: baseConfig,
      beads: makeBeadsSource([bead]).source,
      herdr: herdr.herdr,
      worktreeGit: makeWorktreeGit([
        {
          path: worktreePath,
          branch: beadId,
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ]),
      mergeGit: mergeGit.mergeGit,
      runVerify: makeRunVerify(true).runVerify,
    });
    assert.equal(merged, 0, failureCode);
    assert.deepEqual(mergeGit.calls, [], `${failureCode}: queue must not run`);
    assert.equal(herdr.calls.length, 0, `${failureCode}: worktree retained`);
  }
});

test('does not recover a blocked bead whose worktree was already removed', async (t) => {
  const beadId = 'gis-late.2';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([]);
  // No worktree in the listing matches this bead's branch.
  const worktreeGit = makeWorktreeGit([
    {
      path: join(root, 'worktrees', 'unrelated'),
      branch: 'main',
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit();

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
  assert.ok(
    !herdr.calls.some((call) => call[0] === 'worktreeRemove'),
    'no worktree should have been touched',
  );
});

test('does not recover a blocked bead when herdr has no workspace for its worktree', async (t) => {
  const beadId = 'gis-late.3';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  // Deliberately do not write a prompt/result: if the code incorrectly
  // proceeded past the missing-workspace check it would throw reading it,
  // and the report assertion below would catch that regression too.

  const beadsSource = makeBeadsSource([bead]);
  // No workspace at all references this worktree's checkout path.
  const herdr = makeHerdr([]);
  const worktreeGit = makeWorktreeGit([
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  // hasCommits must never even be consulted once the workspace lookup
  // fails; if it were, the missing prompt/result would need to throw
  // instead, and this fake would need to guard against a mistaken call.
  const mergeGit = makeMergeGit({ [worktreePath]: true });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
  assert.deepEqual(
    mergeGit.calls,
    [],
    'hasCommits should never be reached when no workspace matches the worktree',
  );
});

test('does not recover a blocked bead whose branch has no commit ahead of base', async (t) => {
  const beadId = 'gis-late.4';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  // No implement-prompt.md is written; currentResult() must never be
  // reached once hasCommits() is false, or reading it would throw ENOENT
  // and surface as a "recovery failed" report instead of silence.

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: false });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
});

test('does not recover a blocked bead whose late run has no successful result yet', async (t) => {
  const beadId = 'gis-late.5';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  // A prompt exists (so the branch looks like it was dispatched) but the
  // worker never wrote a result file: currentResult() must resolve to
  // undefined, not throw, and no recovery attempt should be reported.
  await writeDispatchedButUnfinishedRun(worktreePath);

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
});

test('does not count a bead as merged when the merge queue blocks it instead (e.g. a failing verify command)', async (t) => {
  const beadId = 'gis-late.8';
  const bead = lateCommitBead(beadId);
  const root = await makeRoot(t);
  const worktreePath = join(root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeSuccessfulRun(worktreePath);

  const beadsSource = makeBeadsSource([bead]);
  const herdr = makeHerdr([
    { workspace_id: `ws-${beadId}`, worktree: { checkout_path: worktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    {
      path: worktreePath,
      branch: beadId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({ [worktreePath]: true });
  // Rebase and hasCommits still pass (see the "recovers" test above for
  // that path); a real failing verify command drives SerialMergeQueue's
  // result to `{ status: 'blocked', phase: 'verify', ... }` instead of
  // `merged`, exercising the queue's non-merged branch through a realistic
  // failure rather than a stubbed queue result.
  const runVerify = makeRunVerify(false);

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: { ...baseConfig, verify: 'exit 1' },
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
    runVerify: runVerify.runVerify,
  });

  assert.equal(
    merged,
    0,
    'a blocked merge-queue result must never be counted as a merge',
  );
  assert.ok(
    reports.some((message) =>
      message.includes(`resuming late completion for ${beadId}`),
    ),
    `expected a resuming report, got: ${reports.join(' | ')}`,
  );
  assert.ok(
    !herdr.calls.some((call) => call[0] === 'worktreeRemove'),
    'a blocked bead must keep its worktree instead of being cleaned up',
  );

  assert.deepEqual(
    beadsSource.calls.map((call) => call[0]),
    ['markBlocked'],
    'a blocked bead must never be closed',
  );
  assert.equal(beadsSource.calls[0][1], beadId);
});

// Each case here is otherwise a full happy path identical to the "recovers"
// test above (matching worktree, matching workspace, a commit ahead of
// base, and a successful run) with exactly one field of the bead changed so
// it should NOT be treated as a late-commit candidate. If
// isLateCommitCandidate wrongly admits the bead despite the changed field,
// the loop runs all the way through and closes it, so `merged` becomes 1
// and a markMerged call happens -- these tests fail loudly rather than
// passing for the wrong reason.
const candidateRejectionCases = [
  {
    label: 'status is not blocked',
    overrides: { status: 'open' },
  },
  {
    label: 'notes are missing the failure-phase marker',
    overrides: { notes: 'no commit ahead of base' },
  },
  {
    label: 'notes are missing the no-commit-ahead marker',
    overrides: { notes: 'failure phase: commit\nverify failed instead' },
  },
];

for (const { label, overrides } of candidateRejectionCases) {
  test(`ignores a blocked bead that is not a late-commit candidate: ${label}`, async (t) => {
    const beadId = 'gis-late.reject';
    const bead = lateCommitBead(beadId, overrides);
    const root = await makeRoot(t);
    const worktreePath = join(root, 'worktrees', beadId);
    await mkdir(worktreePath, { recursive: true });
    await writeSuccessfulRun(worktreePath);

    const beadsSource = makeBeadsSource([bead]);
    // worktree.remove is handled (not left to error/hang) so that if a
    // mutant wrongly admits this bead as a candidate, the run completes
    // normally and the assertions below fail with a clear diff instead of
    // hanging on an unanswered call.
    const herdr = makeHerdr([
      {
        workspace_id: `ws-${beadId}`,
        worktree: { checkout_path: worktreePath },
      },
    ]);
    const worktreeGit = makeWorktreeGit([
      {
        path: worktreePath,
        branch: beadId,
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ]);
    const mergeGit = makeMergeGit({ [worktreePath]: true });

    const reports = [];
    const merged = await recoverLateCompletions({
      cwd: root,
      config: baseConfig,
      report: (message) => reports.push(message),
      beads: beadsSource.source,
      herdr: herdr.herdr,
      worktreeGit,
      mergeGit: mergeGit.mergeGit,
    });

    assert.equal(merged, 0);
    assert.deepEqual(reports, []);
    assert.deepEqual(
      beadsSource.calls,
      [],
      'beads must never be asked to close a bead that was not a late-commit candidate',
    );
  });
}

test('reports a per-bead failure and still recovers a later bead in the same run', async (t) => {
  const brokenId = 'gis-late.broken';
  const okId = 'gis-late.ok';
  const brokenBead = lateCommitBead(brokenId);
  const okBead = lateCommitBead(okId);
  const root = await makeRoot(t);
  const brokenWorktreePath = join(root, 'worktrees', brokenId);
  const okWorktreePath = join(root, 'worktrees', okId);
  await mkdir(brokenWorktreePath, { recursive: true });
  await mkdir(okWorktreePath, { recursive: true });
  await writeSuccessfulRun(okWorktreePath);

  const beadsSource = makeBeadsSource([brokenBead, okBead]);
  const herdr = makeHerdr([
    {
      workspace_id: `ws-${brokenId}`,
      worktree: { checkout_path: brokenWorktreePath },
    },
    { workspace_id: `ws-${okId}`, worktree: { checkout_path: okWorktreePath } },
  ]);
  const worktreeGit = makeWorktreeGit([
    {
      path: brokenWorktreePath,
      branch: brokenId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
    {
      path: okWorktreePath,
      branch: okId,
      isBare: false,
      isDetached: false,
      isPrunable: false,
    },
  ]);
  const mergeGit = makeMergeGit({
    // hasCommits() throws for the first bead, which must be caught and
    // reported without aborting the rest of the loop.
    [brokenWorktreePath]: () => {
      throw new Error('git rev-list returned an invalid count: not-a-number');
    },
    [okWorktreePath]: true,
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: root,
    config: baseConfig,
    report: (message) => reports.push(message),
    beads: beadsSource.source,
    herdr: herdr.herdr,
    worktreeGit,
    mergeGit: mergeGit.mergeGit,
  });

  // If the loop stopped after the first bead's failure (e.g. an early
  // `break`, or only ever looking at the first candidate), the second bead
  // would never be merged and this would be 0.
  assert.equal(merged, 1);
  assert.ok(
    reports.some(
      (message) =>
        message.includes(`late completion recovery failed for ${brokenId}`) &&
        message.includes('invalid count'),
    ),
    `expected a recovery-failed report for ${brokenId}, got: ${reports.join(' | ')}`,
  );
  assert.ok(
    reports.some((message) =>
      message.includes(`resuming late completion for ${okId}`),
    ),
    `expected a resuming report for ${okId}, got: ${reports.join(' | ')}`,
  );
  assert.ok(
    !reports.some((message) => message.includes(`recovery failed for ${okId}`)),
    `${okId} should not have failed: ${reports.join(' | ')}`,
  );

  assert.deepEqual(
    beadsSource.calls.map((call) => call[0]),
    ['markMerged'],
  );
  assert.equal(beadsSource.calls[0][1], okId);
});
