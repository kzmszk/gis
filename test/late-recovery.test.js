import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

/** Writes fake `bd` and `git` executables driven entirely by env vars, so
 * each test can control blocked-issue listings and worktree/commit state
 * without touching a real Beads DB or Git repository. `git` recognizes the
 * `-C <path> <subcommand> ...` shape every call in late-recovery.ts and
 * merge.ts uses, and looks `rev-list --count` answers up per `-C` path so a
 * single test can give two worktrees different commit states. */
async function writeFakeCommands(root) {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'bd'),
    `#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const args = process.argv.slice(2);
await appendFile(process.env.GIS_BD_LOG, JSON.stringify(args) + "\\n");

if (args[0] === "list" && args.includes("--status=blocked")) {
  const data = await readFile(process.env.GIS_BD_BLOCKED, "utf8");
  process.stdout.write(data);
} else if (args[0] === "close") {
  const id = args[1];
  process.stdout.write(
    JSON.stringify([
      {
        id,
        title: id,
        description: "late recovery fixture",
        status: "closed",
        priority: 2,
        issue_type: "task",
      },
    ]) + "\\n",
  );
} else if (args[0] === "update") {
  const id = args[1];
  const statusArg = args.find((a) => a.startsWith("--status="));
  const status = statusArg ? statusArg.slice("--status=".length) : "blocked";
  process.stdout.write(
    JSON.stringify([
      {
        id,
        title: id,
        description: "late recovery fixture",
        status,
        priority: 2,
        issue_type: "task",
      },
    ]) + "\\n",
  );
} else {
  process.stdout.write("[]\\n");
}
`,
    'utf8',
  );
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const args = process.argv.slice(2);
await appendFile(process.env.GIS_GIT_LOG, JSON.stringify(args) + "\\n");

if (args[0] === "worktree" && args[1] === "list") {
  const data = await readFile(process.env.GIS_GIT_WORKTREES, "utf8");
  process.stdout.write(data);
} else if (args[0] === "-C") {
  const path = args[1];
  const subcommand = args[2];
  if (subcommand === "rev-list") {
    const map = JSON.parse(await readFile(process.env.GIS_GIT_REV_COUNT_MAP, "utf8"));
    const count = Object.prototype.hasOwnProperty.call(map, path) ? map[path] : "0";
    process.stdout.write(count + "\\n");
  } else if (subcommand === "diff") {
    process.stdout.write("\\n");
  } else {
    // rebase, merge --ff-only, branch -d: all succeed silently.
    process.stdout.write("");
  }
} else {
  process.stdout.write("");
}
`,
    'utf8',
  );
  await chmod(join(bin, 'bd'), 0o755);
  await chmod(join(bin, 'git'), 0o755);
  return bin;
}

/** Builds a `git worktree list --porcelain` body from one or more records,
 * so tests can mix a real match in with a decoy. */
function worktreeListing(records) {
  return (
    records
      .map(
        (record) =>
          `worktree ${record.path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${record.branch}\n`,
      )
      .join('\n') + '\n'
  );
}

function workspace(id, checkoutPath, repoRoot) {
  return {
    workspace_id: id,
    label: id,
    worktree: {
      checkout_path: checkoutPath,
      is_linked_worktree: true,
      repo_key: 'repo',
      repo_name: 'repo',
      repo_root: repoRoot,
    },
  };
}

function snapshot(workspaces = []) {
  return {
    type: 'session_snapshot',
    snapshot: {
      version: '0.7.5',
      protocol: 17,
      workspaces,
      tabs: [],
      panes: [],
      layouts: [],
      agents: [],
    },
  };
}

/** Starts a fake herdr JSON-line socket server and registers its teardown
 * with `t`. `handlers` maps a method name to a function producing its
 * result; unhandled methods fail the test loudly instead of hanging. Every
 * call (method + params) is recorded in the returned `calls` array so tests
 * can assert not just that a call happened, but which arguments it carried. */
async function startHerdr(t, socketPath, handlers) {
  const calls = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      calls.push({ method: request.method, params: request.params });
      const handler = handlers[request.method];
      if (handler === undefined) {
        socket.end(
          JSON.stringify({
            id: request.id,
            error: { message: `unexpected herdr method ${request.method}` },
          }) + '\n',
        );
        return;
      }
      try {
        const result = await handler(request.params);
        socket.end(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (error) {
        // Always answer the request, even when a handler throws, so a
        // wrongly-admitted bead surfaces as a failed assertion rather than
        // hanging the test on an unanswered herdr call.
        socket.end(
          JSON.stringify({
            id: request.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }) + '\n',
        );
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return calls;
}

/** Writes a worker prompt + result pair that `currentResult` in
 * late-recovery.ts reads: the prompt names the result file and (optionally)
 * a run id, and the result file satisfies the schema for a successful run. */
async function writeSuccessfulRun(
  worktreePath,
  beadId,
  { runId = 'run-1' } = {},
) {
  const runPath = join(worktreePath, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  const prompt = [
    '# gis worker task',
    '',
    `- Bead ID: \`${beadId}\``,
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

/** Sets up a temp root, fake bd/git on PATH, and env vars recoverLateCompletions's
 * default adapters read; registers its own teardown with `t`.
 * `revCounts` maps a worktree path to the `rev-list --count` answer the fake
 * git gives for that specific `-C <path>` invocation. */
async function setupHarness(t, { blocked, worktrees, revCounts }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gis-late-recovery-')),
  );
  const bin = await writeFakeCommands(root);
  const bdLogPath = join(root, 'bd.log');
  const gitLogPath = join(root, 'git.log');
  const blockedPath = join(root, 'blocked.json');
  const worktreesPath = join(root, 'worktrees.json');
  const revCountMapPath = join(root, 'rev-counts.json');
  const socketPath = join(root, 'herdr.sock');
  await writeFile(bdLogPath, '', 'utf8');
  await writeFile(gitLogPath, '', 'utf8');
  await writeFile(blockedPath, JSON.stringify(blocked), 'utf8');
  await writeFile(worktreesPath, worktreeListing(worktrees), 'utf8');
  await writeFile(revCountMapPath, JSON.stringify(revCounts ?? {}), 'utf8');

  const previousEnv = {
    PATH: process.env.PATH,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    GIS_BD_LOG: process.env.GIS_BD_LOG,
    GIS_BD_BLOCKED: process.env.GIS_BD_BLOCKED,
    GIS_GIT_LOG: process.env.GIS_GIT_LOG,
    GIS_GIT_WORKTREES: process.env.GIS_GIT_WORKTREES,
    GIS_GIT_REV_COUNT_MAP: process.env.GIS_GIT_REV_COUNT_MAP,
  };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.GIS_BD_LOG = bdLogPath;
  process.env.GIS_BD_BLOCKED = blockedPath;
  process.env.GIS_GIT_LOG = gitLogPath;
  process.env.GIS_GIT_WORKTREES = worktreesPath;
  process.env.GIS_GIT_REV_COUNT_MAP = revCountMapPath;

  t.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  return { root, socketPath, gitLogPath, bdLogPath };
}

async function readLog(path) {
  const contents = await readFile(path, 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('recovers a late-completed bead: rebases, verifies, merges, closes it, and removes only its own worktree', async (t) => {
  const beadId = 'gis-late.1';
  const decoyId = 'gis-late.decoy';
  const bead = lateCommitBead(beadId);
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [
      // The decoy is listed first on purpose: the code must select the
      // worktree by exact branch match, not just take whatever is first.
      { path: join('worktrees', decoyId), branch: decoyId },
      { path: join('worktrees', beadId), branch: beadId },
    ],
    // The rev-count map needs the real (realpath'd) worktree path, which
    // isn't known until setupHarness returns the harness root below, so it
    // starts empty and is rewritten once that path is available.
    revCounts: {},
  });
  const worktreePath = join(harness.root, 'worktrees', beadId);
  const decoyWorktreePath = join(harness.root, 'worktrees', decoyId);
  await mkdir(worktreePath, { recursive: true });
  await mkdir(decoyWorktreePath, { recursive: true });
  await writeSuccessfulRun(worktreePath, beadId);
  // Rewrite the rev-count map now that we know the real (realpath'd) paths.
  await writeFile(
    join(harness.root, 'rev-counts.json'),
    JSON.stringify({ [worktreePath]: '1' }),
    'utf8',
  );

  const calls = await startHerdr(t, harness.socketPath, {
    'session.snapshot': () =>
      snapshot([
        // A decoy workspace pointing at an unrelated checkout path: the
        // code must select the workspace by exact checkout_path match.
        workspace(`ws-${decoyId}`, decoyWorktreePath, harness.root),
        workspace(`ws-${beadId}`, worktreePath, harness.root),
      ]),
    'worktree.remove': () => ({
      type: 'worktree_removed',
      workspace_id: `ws-${beadId}`,
      path: worktreePath,
      forced: true,
    }),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
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

  const removeCall = calls.find((call) => call.method === 'worktree.remove');
  assert.ok(removeCall, 'worktree.remove should have been called');
  assert.equal(
    removeCall.params.workspace_id,
    `ws-${beadId}`,
    'must remove the workspace matched to this bead, not the decoy',
  );
  assert.equal(
    removeCall.params.force,
    true,
    'a late-recovered worktree must be force-removed since it may still be attached to a pane',
  );

  const gitLog = await readLog(harness.gitLogPath);
  assert.deepEqual(gitLog, [
    ['worktree', 'list', '--porcelain'],
    // recoverLateCompletions's own hasCommits() gate, before it even reads
    // currentResult() or enqueues the merge.
    ['-C', worktreePath, 'rev-list', '--count', 'main..HEAD'],
    // The merge queue then re-does rebase/hasCommits/changedPaths itself.
    ['-C', worktreePath, 'rebase', 'main'],
    ['-C', worktreePath, 'rev-list', '--count', 'main..HEAD'],
    ['-C', worktreePath, 'diff', '--name-only', 'main..HEAD'],
    ['-C', harness.root, 'merge', '--ff-only', beadId],
    ['-C', harness.root, 'branch', '-d', beadId],
  ]);

  const bdLog = await readLog(harness.bdLogPath);
  assert.deepEqual(bdLog, [
    ['list', '--status=blocked', '--json'],
    ['close', beadId, '--reason=merged after rebase and verify', '--json'],
  ]);
});

test('does not recover a blocked bead whose worktree was already removed', async (t) => {
  const beadId = 'gis-late.2';
  const bead = lateCommitBead(beadId);
  // No worktree in the listing matches this bead's branch.
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [{ path: join('worktrees', 'unrelated'), branch: 'main' }],
  });

  const calls = await startHerdr(t, harness.socketPath, {
    'session.snapshot': () => snapshot([]),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
  assert.ok(
    !calls.some((call) => call.method === 'worktree.remove'),
    'no worktree should have been touched',
  );
});

test('does not recover a blocked bead when herdr has no workspace for its worktree', async (t) => {
  const beadId = 'gis-late.3';
  const bead = lateCommitBead(beadId);
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [{ path: join('worktrees', beadId), branch: beadId }],
  });
  const worktreePath = join(harness.root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  // Deliberately do not write a prompt/result: if the code incorrectly
  // proceeded past the missing-workspace check it would throw reading it,
  // and the report assertion below would catch that regression too.

  const calls = await startHerdr(t, harness.socketPath, {
    // No workspace at all references this worktree's checkout path.
    'session.snapshot': () => snapshot([]),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
  // apiSnapshot() is always fetched up front (in parallel with the
  // blocked-bead list), but nothing worktree-specific should follow it.
  assert.deepEqual(
    calls.map((call) => call.method),
    ['session.snapshot'],
  );
});

test('does not recover a blocked bead whose branch has no commit ahead of base', async (t) => {
  const beadId = 'gis-late.4';
  const bead = lateCommitBead(beadId);
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [{ path: join('worktrees', beadId), branch: beadId }],
  });
  const worktreePath = join(harness.root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(harness.root, 'rev-counts.json'),
    JSON.stringify({ [worktreePath]: '0' }),
    'utf8',
  );
  // No implement-prompt.md is written; currentResult() must never be
  // reached once hasCommits() is false, or reading it would throw ENOENT
  // and surface as a "recovery failed" report instead of silence.

  await startHerdr(t, harness.socketPath, {
    'session.snapshot': () =>
      snapshot([workspace(`ws-${beadId}`, worktreePath, harness.root)]),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
});

test('does not recover a blocked bead whose late run has no successful result yet', async (t) => {
  const beadId = 'gis-late.5';
  const bead = lateCommitBead(beadId);
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [{ path: join('worktrees', beadId), branch: beadId }],
  });
  const worktreePath = join(harness.root, 'worktrees', beadId);
  const runPath = join(worktreePath, '.gis', 'run');
  await mkdir(runPath, { recursive: true });
  await writeFile(
    join(harness.root, 'rev-counts.json'),
    JSON.stringify({ [worktreePath]: '1' }),
    'utf8',
  );
  // A prompt exists (so the branch looks like it was dispatched) but the
  // worker never wrote a result file: currentResult() must resolve to
  // undefined, not throw, and no recovery attempt should be reported.
  await writeFile(
    join(runPath, 'implement-prompt.md'),
    [
      '# gis worker task',
      '',
      `- Bead ID: \`${beadId}\``,
      `- Run ID: \`run-1\``,
      '',
      'Before finishing, write a JSON result to `.gis/run/round-1-impl.json`.',
      '',
    ].join('\n'),
    'utf8',
  );

  await startHerdr(t, harness.socketPath, {
    'session.snapshot': () =>
      snapshot([workspace(`ws-${beadId}`, worktreePath, harness.root)]),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
  });

  assert.equal(merged, 0);
  assert.deepEqual(reports, []);
});

test('does not count a bead as merged when the merge queue blocks it instead (e.g. a failing verify command)', async (t) => {
  const beadId = 'gis-late.8';
  const bead = lateCommitBead(beadId);
  const harness = await setupHarness(t, {
    blocked: [bead],
    worktrees: [{ path: join('worktrees', beadId), branch: beadId }],
  });
  const worktreePath = join(harness.root, 'worktrees', beadId);
  await mkdir(worktreePath, { recursive: true });
  await writeSuccessfulRun(worktreePath, beadId);
  await writeFile(
    join(harness.root, 'rev-counts.json'),
    JSON.stringify({ [worktreePath]: '1' }),
    'utf8',
  );

  const calls = await startHerdr(t, harness.socketPath, {
    'session.snapshot': () =>
      snapshot([workspace(`ws-${beadId}`, worktreePath, harness.root)]),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    // Rebase and hasCommits still pass (see the "recovers" test above for
    // that path); a real failing verify command drives SerialMergeQueue's
    // result to `{ status: 'blocked', phase: 'verify', ... }` instead of
    // `merged`, exercising the queue's non-merged branch through a
    // realistic failure rather than a stubbed queue result.
    config: { ...baseConfig, verify: 'exit 1' },
    report: (message) => reports.push(message),
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
    !calls.some((call) => call.method === 'worktree.remove'),
    'a blocked bead must keep its worktree instead of being cleaned up',
  );

  const bdLog = await readLog(harness.bdLogPath);
  assert.deepEqual(bdLog[0], ['list', '--status=blocked', '--json']);
  assert.equal(
    bdLog.length,
    2,
    `expected exactly one follow-up bd call, got: ${JSON.stringify(bdLog)}`,
  );
  assert.equal(bdLog[1][0], 'update');
  assert.equal(bdLog[1][1], beadId);
  assert.ok(
    bdLog[1].includes('--status=blocked'),
    `expected the bead to be re-blocked, got: ${JSON.stringify(bdLog[1])}`,
  );
  assert.ok(
    !bdLog.some((entry) => entry[0] === 'close'),
    'a blocked bead must never be closed',
  );
});

// Each case here is otherwise a full happy path identical to the "recovers"
// test above (matching worktree, matching workspace, a commit ahead of
// base, and a successful run) with exactly one field of the bead changed so
// it should NOT be treated as a late-commit candidate. If
// isLateCommitCandidate wrongly admits the bead despite the changed field,
// the loop runs all the way through and closes it, so `merged` becomes 1
// and a `close` call appears in bd.log -- these tests fail loudly rather
// than passing for the wrong reason.
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
    const harness = await setupHarness(t, {
      blocked: [bead],
      worktrees: [{ path: join('worktrees', beadId), branch: beadId }],
    });
    const worktreePath = join(harness.root, 'worktrees', beadId);
    await mkdir(worktreePath, { recursive: true });
    await writeSuccessfulRun(worktreePath, beadId);
    await writeFile(
      join(harness.root, 'rev-counts.json'),
      JSON.stringify({ [worktreePath]: '1' }),
      'utf8',
    );

    // worktree.remove is handled (not left to error/hang) so that if a
    // mutant wrongly admits this bead as a candidate, the run completes
    // normally and the assertions below fail with a clear diff instead of
    // the test hanging on an unanswered herdr request.
    await startHerdr(t, harness.socketPath, {
      'session.snapshot': () =>
        snapshot([workspace(`ws-${beadId}`, worktreePath, harness.root)]),
      'worktree.remove': () => ({
        type: 'worktree_removed',
        workspace_id: `ws-${beadId}`,
        path: worktreePath,
        forced: true,
      }),
    });

    const reports = [];
    const merged = await recoverLateCompletions({
      cwd: harness.root,
      config: baseConfig,
      report: (message) => reports.push(message),
    });

    assert.equal(merged, 0);
    assert.deepEqual(reports, []);
    const bdLog = await readLog(harness.bdLogPath);
    assert.deepEqual(
      bdLog,
      [['list', '--status=blocked', '--json']],
      'bd must never be asked to close a bead that was not a late-commit candidate',
    );
  });
}

test('reports a per-bead failure and still recovers a later bead in the same run', async (t) => {
  const brokenId = 'gis-late.broken';
  const okId = 'gis-late.ok';
  const brokenBead = lateCommitBead(brokenId);
  const okBead = lateCommitBead(okId);
  const harness = await setupHarness(t, {
    blocked: [brokenBead, okBead],
    worktrees: [
      { path: join('worktrees', brokenId), branch: brokenId },
      { path: join('worktrees', okId), branch: okId },
    ],
  });
  const brokenWorktreePath = join(harness.root, 'worktrees', brokenId);
  const okWorktreePath = join(harness.root, 'worktrees', okId);
  await mkdir(brokenWorktreePath, { recursive: true });
  await mkdir(okWorktreePath, { recursive: true });
  await writeSuccessfulRun(okWorktreePath, okId);
  await writeFile(
    join(harness.root, 'rev-counts.json'),
    JSON.stringify({
      // Not a number: git.hasCommits() throws when parsing this for the
      // first bead, which must be caught and reported without aborting the
      // rest of the loop.
      [brokenWorktreePath]: 'not-a-number',
      [okWorktreePath]: '1',
    }),
    'utf8',
  );

  await startHerdr(t, harness.socketPath, {
    'session.snapshot': () =>
      snapshot([
        workspace(`ws-${brokenId}`, brokenWorktreePath, harness.root),
        workspace(`ws-${okId}`, okWorktreePath, harness.root),
      ]),
    'worktree.remove': () => ({
      type: 'worktree_removed',
      workspace_id: `ws-${okId}`,
      path: okWorktreePath,
      forced: true,
    }),
  });

  const reports = [];
  const merged = await recoverLateCompletions({
    cwd: harness.root,
    config: baseConfig,
    report: (message) => reports.push(message),
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

  const bdLog = await readLog(harness.bdLogPath);
  assert.deepEqual(bdLog, [
    ['list', '--status=blocked', '--json'],
    ['close', okId, '--reason=merged after rebase and verify', '--json'],
  ]);
});
