import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  GitCommandError,
  GitProtocolError,
  createGitAdapter,
  classifyRecoveryObservation,
  parseGitWorktreeList,
  reconcileStartup,
} from '../dist/recovery.js';
import {
  containedRecoveryPath,
  parseRecoveryMetadata,
} from '../dist/recovery-manifest.js';
import { herdrAgentName } from '../dist/worker.js';

const execFileAsync = promisify(execFile);

const bead = (id, status = 'in_progress') => ({
  id,
  title: id,
  description: 'test bead',
  status,
  priority: 2,
  issue_type: 'task',
});

const snapshot = ({ workspaces = [], panes = [], agents = [] } = {}) => ({
  type: 'session_snapshot',
  snapshot: {
    version: '0.7.5',
    protocol: 17,
    workspaces,
    tabs: [],
    panes,
    layouts: [],
    agents,
  },
});

async function fakeGitScript(t, source, options = {}) {
  const ownsDirectory = options.directory === undefined;
  const directory =
    options.directory ??
    (await mkdtemp(join(tmpdir(), 'gis-recovery-git-error-')));
  const command = join(directory, options.name ?? 'git-fake');
  await writeFile(command, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  await chmod(command, 0o755);
  if (ownsDirectory) {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
  return command;
}

test('converts a git non-zero exit into GitCommandError with command context', async (t) => {
  const command = await fakeGitScript(
    t,
    "process.stderr.write('fatal: worktree unavailable\\n'); process.exit(23);",
  );

  await assert.rejects(createGitAdapter(command).listWorktrees(), (error) => {
    assert.ok(error instanceof GitCommandError);
    assert.deepEqual(error.args, ['worktree', 'list', '--porcelain']);
    assert.equal(error.code, 23);
    assert.equal(error.signal, undefined);
    assert.equal(error.stderr, 'fatal: worktree unavailable\n');
    assert.match(
      error.message,
      /git command failed \(worktree list --porcelain\)/,
    );
    const details = error.message.replace(
      'git command failed (worktree list --porcelain): ',
      '',
    );
    assert.ok(details.length > 0);
    return true;
  });
});

test('converts a non-Error command rejection into GitCommandError', async () => {
  await assert.rejects(
    createGitAdapter({
      command: 'git-test',
      runCommand: async () => {
        throw { code: 42, stderr: 'runner failure' };
      },
    }).listWorktrees(),
    (error) => {
      assert.ok(error instanceof GitCommandError);
      assert.deepEqual(error.args, ['worktree', 'list', '--porcelain']);
      assert.equal(error.code, 42);
      assert.equal(error.signal, undefined);
      assert.equal(error.stderr, 'runner failure');
      assert.match(
        error.message,
        /git command failed \(worktree list --porcelain\)/,
      );
      assert.match(error.message, /\[object Object\]/);
      return true;
    },
  );
});

test('retains a signal termination as typed git command context', async (t) => {
  const command = await fakeGitScript(
    t,
    "process.kill(process.pid, 'SIGTERM');",
  );

  await assert.rejects(createGitAdapter(command).listWorktrees(), (error) => {
    assert.ok(error instanceof GitCommandError);
    assert.deepEqual(error.args, ['worktree', 'list', '--porcelain']);
    assert.equal(error.code, undefined);
    assert.equal(error.signal, 'SIGTERM');
    assert.equal(error.stderr, '');
    return true;
  });
});

test('converts an unavailable git executable into a typed string-code error', async () => {
  await assert.rejects(
    createGitAdapter('/definitely/missing/gis-git').listWorktrees(),
    (error) => {
      assert.ok(error instanceof GitCommandError);
      assert.deepEqual(error.args, ['worktree', 'list', '--porcelain']);
      assert.equal(error.code, 'ENOENT');
      assert.equal(error.signal, undefined);
      assert.equal(error.stderr, '');
      return true;
    },
  );
});

test('does not wrap malformed git worktree output as a command error', async (t) => {
  const command = await fakeGitScript(
    t,
    "process.stdout.write('not porcelain');",
  );

  await assert.rejects(createGitAdapter(command).listWorktrees(), (error) => {
    assert.ok(error instanceof GitProtocolError);
    assert.equal(error.name, 'GitProtocolError');
    assert.match(error.message, /record 0 did not contain a worktree path/);
    return true;
  });
});

test('normalizes optional command error fields without losing stderr bytes', () => {
  const error = new GitCommandError(
    ['worktree', 'list', '--porcelain'],
    Object.assign(new Error(''), {
      code: true,
      signal: 9,
      stderr: Buffer.from('fatal: bytes\n', 'utf8'),
    }),
  );

  assert.equal(
    error.message,
    'git command failed (worktree list --porcelain): git command failed',
  );
  assert.equal(error.code, undefined);
  assert.equal(error.signal, undefined);
  assert.equal(error.stderr, 'fatal: bytes\n');
});

test('validates versioned recovery metadata and rejects worktree traversal', () => {
  const valid = {
    version: 1,
    beadId: 'gis-vst.14',
    agentName: 'gis-vst-14',
    runId: 'run-1',
    resultPath: '.gis/run/round-1-impl.json',
    failureCode: 'commit',
    role: 'implement',
  };
  assert.deepEqual(parseRecoveryMetadata(valid), valid);
  assert.throws(
    () => parseRecoveryMetadata({ ...valid, version: 2 }),
    /unsupported recovery metadata version/,
  );
  assert.throws(
    () => parseRecoveryMetadata({ ...valid, runId: '' }),
    /runId must be a non-empty string/,
  );
  assert.throws(
    () => parseRecoveryMetadata({ ...valid, failureCode: 'made-up' }),
    /failureCode is invalid/,
  );
  assert.throws(
    () => parseRecoveryMetadata({ ...valid, role: 'review' }),
    /role must be implement/,
  );
  assert.equal(
    containedRecoveryPath('/repo/worktree', valid.resultPath),
    '/repo/worktree/.gis/run/round-1-impl.json',
  );
  assert.throws(
    () => containedRecoveryPath('/repo/worktree', '../outside.json'),
    /escapes worktree/,
  );
});

test('contains existing, missing, absolute, and symlinked recovery paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gis-recovery-containment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.gis', 'run'), { recursive: true });
  const external = await mkdtemp(join(tmpdir(), 'gis-recovery-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(root, '.gis', 'run', 'existing.json'), '{}', 'utf8');
  await symlink(external, join(root, 'link'), 'dir');

  assert.equal(
    containedRecoveryPath(root, '.gis/run/existing.json'),
    join(root, '.gis', 'run', 'existing.json'),
  );
  assert.equal(
    containedRecoveryPath(root, '.gis/run/missing.json'),
    join(root, '.gis', 'run', 'missing.json'),
  );
  assert.equal(
    containedRecoveryPath(root, join(root, '.gis', 'run', 'absolute.json')),
    join(root, '.gis', 'run', 'absolute.json'),
  );
  assert.throws(
    () => containedRecoveryPath(root, join(external, 'outside.json')),
    /escapes worktree/,
  );
  assert.throws(
    () => containedRecoveryPath(root, 'link/existing.json'),
    /escapes worktree/,
  );
  assert.throws(
    () => containedRecoveryPath(root, 'link/missing.json'),
    /escapes worktree/,
  );
});

test('blocks an in-progress bead when its retained worktree has no live pane', async () => {
  const updates = [];
  const result = await reconcileStartup({
    cwd: '/repo',
    beads: {
      listInProgress: async () => [bead('gis-vst.14')],
      update: async (id, update) => {
        updates.push({ id, update });
        return bead(id, update.status);
      },
      markBlocked: async (id, locations) => {
        updates.push({ id, locations });
        return bead(id, 'blocked');
      },
    },
    herdr: { apiSnapshot: async () => snapshot() },
    git: {
      listWorktrees: async () => [
        {
          path: '/repo/.worktrees/gis-vst.14',
          branch: 'gis-vst.14',
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ],
    },
  });

  assert.deepEqual(result.reopenedIssueIds, []);
  assert.deepEqual(result.blockedIssueIds, ['gis-vst.14']);
  assert.equal(updates[0].id, 'gis-vst.14');
  assert.equal(
    updates[0].locations.worktreePath,
    '/repo/.worktrees/gis-vst.14',
  );
  assert.equal(updates[0].locations.failurePhase, 'startup recovery');
  assert.deepEqual(result.orphanedWorktrees, []);
});

test('classifies worker observations by bead identity, session, and status', () => {
  const beadId = 'gis-vst.14';
  const worktreePath = '/repo/.worktrees/gis-vst.14';
  const workspace = {
    workspace_id: 'ws-worker',
    label: beadId,
    worktree: {
      checkout_path: worktreePath,
      is_linked_worktree: true,
      repo_key: 'repo',
      repo_name: 'gis',
      repo_root: '/repo',
    },
  };
  const agent = (status, overrides = {}) => ({
    name: herdrAgentName(beadId),
    pane_id: 'pane-worker',
    workspace_id: 'ws-worker',
    tab_id: 'tab-worker',
    agent_status: status,
    agent_session: {
      source: 'test',
      agent: 'codex',
      kind: 'path',
      value: '/repo/.gis/run/worker.jsonl',
    },
    ...overrides,
  });
  const statuses = [
    ['working', 'live'],
    ['done', 'completed'],
    ['idle', 'stale'],
    ['blocked', 'stale'],
    ['unknown', 'unknown'],
  ];
  for (const [status, expected] of statuses) {
    const result = classifyRecoveryObservation(
      beadId,
      worktreePath,
      snapshot({
        workspaces: [workspace],
        panes: [agent(status)],
      }).snapshot,
    );
    assert.equal(result.classification, expected, status);
  }
  assert.equal(
    classifyRecoveryObservation(
      beadId,
      worktreePath,
      snapshot({ workspaces: [workspace], panes: [] }).snapshot,
    ).classification,
    'unknown',
  );
  assert.equal(
    classifyRecoveryObservation(
      beadId,
      worktreePath,
      snapshot({
        workspaces: [workspace],
        panes: [agent('working', { name: herdrAgentName('other-bead') })],
      }).snapshot,
    ).classification,
    'unknown',
  );
  assert.equal(
    classifyRecoveryObservation(
      beadId,
      worktreePath,
      snapshot({
        workspaces: [workspace],
        panes: [agent('working', { agent_session: null })],
      }).snapshot,
    ).classification,
    'unknown',
  );
});

test('uses agents fallback only for matching worktrees and complete sessions', async () => {
  const beadId = 'gis-vst.agents-fallback';
  const worktree = '/repo/.worktrees/agents-fallback';
  const workspace = {
    workspace_id: 'ws-worker',
    label: beadId,
    worktree: { checkout_path: worktree },
  };
  const baseAgent = {
    name: herdrAgentName(beadId),
    pane_id: 'pane-worker',
    workspace_id: 'ws-worker',
    tab_id: 'tab-worker',
    agent_status: 'working',
    agent_session: {
      source: 'test',
      agent: 'codex',
      kind: 'path',
      value: '/repo/.gis/run/worker.jsonl',
    },
  };
  const run = async (agents, panes = [], workspaces = [workspace]) => {
    const updates = [];
    const result = await reconcileStartup({
      cwd: '/repo',
      beads: {
        listInProgress: async () => [bead(beadId)],
        update: async (id, update) => {
          updates.push({ id, update });
          return bead(id, update.status);
        },
        markBlocked: async (id, locations) => {
          updates.push({ id, locations });
          return bead(id, 'blocked');
        },
      },
      herdr: {
        apiSnapshot: async () => snapshot({ workspaces, panes, agents }),
      },
      git: {
        listWorktrees: async () => [
          {
            path: worktree,
            branch: beadId,
            isBare: false,
            isDetached: false,
            isPrunable: false,
          },
        ],
      },
    });
    return { result, updates };
  };

  const fallback = await run([baseAgent]);
  assert.deepEqual(fallback.result.blockedIssueIds, []);
  assert.equal(fallback.result.classifications[0].classification, 'live');

  const differentWorktree = await run(
    [],
    [
      {
        ...baseAgent,
        workspace_id: 'ws-other',
      },
    ],
    [
      workspace,
      {
        workspace_id: 'ws-other',
        label: 'other',
        worktree: { checkout_path: '/repo/.worktrees/other' },
      },
    ],
  );
  assert.deepEqual(differentWorktree.result.blockedIssueIds, [beadId]);
  assert.match(
    differentWorktree.updates[0].locations.failureDetail,
    /different worktree/,
  );

  for (const session of [
    { ...baseAgent.agent_session, agent: '' },
    { ...baseAgent.agent_session, agent: '   ' },
    { ...baseAgent.agent_session, value: '' },
    { ...baseAgent.agent_session, value: '   ' },
  ]) {
    const emptySession = await run([{ ...baseAgent, agent_session: session }]);
    assert.deepEqual(emptySession.result.blockedIssueIds, [beadId]);
    assert.match(
      emptySession.updates[0].locations.failureDetail,
      /no session identity/,
    );
  }
});

test('hands off completed workers to late recovery and blocks stale or unknown workers', async () => {
  for (const [status, expected] of [
    ['done', 'blocked'],
    ['idle', 'blocked'],
    ['unknown', 'blocked'],
  ]) {
    const beadId = `gis-vst.${status}`;
    const worktree = `/repo/.worktrees/${beadId}`;
    const updates = [];
    const result = await reconcileStartup({
      cwd: '/repo',
      beads: {
        listInProgress: async () => [bead(beadId)],
        update: async (id, update) => {
          updates.push({ id, update });
          return bead(id, update.status);
        },
        markBlocked: async (id, locations) => {
          updates.push({ id, locations });
          return bead(id, 'blocked');
        },
      },
      herdr: {
        apiSnapshot: async () =>
          snapshot({
            workspaces: [
              {
                workspace_id: 'ws-worker',
                label: beadId,
                worktree: {
                  checkout_path: worktree,
                  is_linked_worktree: true,
                  repo_key: 'repo',
                  repo_name: 'gis',
                  repo_root: '/repo',
                },
              },
            ],
            panes: [
              {
                pane_id: 'pane-worker',
                workspace_id: 'ws-worker',
                tab_id: 'tab-worker',
                name: herdrAgentName(beadId),
                agent_status: status,
                agent_session: {
                  source: 'test',
                  agent: 'codex',
                  kind: 'path',
                  value: '/repo/.gis/run/worker.jsonl',
                },
              },
            ],
          }),
      },
      git: {
        listWorktrees: async () => [
          {
            path: worktree,
            branch: beadId,
            isBare: false,
            isDetached: false,
            isPrunable: false,
          },
        ],
      },
    });
    assert.equal(
      result[
        expected === 'reopened' ? 'reopenedIssueIds' : 'blockedIssueIds'
      ][0],
      beadId,
    );
    assert.equal(updates.length, 1);
  }
});

test('keeps a live worker and reports a live worktree with no active bead', async () => {
  const warnings = [];
  const updates = [];
  const worktree = '/repo/.worktrees/orphan';
  const result = await reconcileStartup({
    cwd: '/repo',
    beads: {
      listInProgress: async () => [bead('gis-vst.14')],
      update: async (id, update) => {
        updates.push({ id, update });
        return bead(id, update.status);
      },
    },
    herdr: {
      apiSnapshot: async () =>
        snapshot({
          workspaces: [
            {
              workspace_id: 'ws-orphan',
              label: 'orphan',
              worktree: {
                checkout_path: worktree,
                is_linked_worktree: true,
                repo_key: 'repo',
                repo_name: 'gis',
                repo_root: '/repo',
              },
            },
          ],
          panes: [
            {
              pane_id: 'pane-orphan',
              workspace_id: 'ws-orphan',
              tab_id: 'tab-orphan',
              agent_status: 'working',
              name: herdrAgentName('unknown-bead'),
              agent_session: {
                source: 'test',
                agent: 'codex',
                kind: 'path',
                value: join(worktree, '.gis', 'run', 'worker.jsonl'),
              },
            },
          ],
        }),
    },
    git: {
      listWorktrees: async () => [
        {
          path: worktree,
          branch: 'unknown-bead',
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ],
    },
    report: (message) => warnings.push(message),
  });

  assert.deepEqual(result.reopenedIssueIds, ['gis-vst.14']);
  assert.deepEqual(updates, [{ id: 'gis-vst.14', update: { status: 'open' } }]);
  assert.deepEqual(result.orphanedWorktrees, [
    { path: worktree, branch: 'unknown-bead' },
  ]);
  assert.match(warnings[0], /unknown-bead/);
});

test('does not reopen an in-progress bead whose pane is tied to its worktree', async () => {
  const worktree = '/repo/.worktrees/gis-vst.14';
  const updates = [];
  const result = await reconcileStartup({
    cwd: '/repo',
    beads: {
      listInProgress: async () => [bead('gis-vst.14')],
      update: async (id, update) => {
        updates.push({ id, update });
        return bead(id, update.status);
      },
    },
    herdr: {
      apiSnapshot: async () =>
        snapshot({
          workspaces: [
            {
              workspace_id: 'ws-worker',
              label: 'gis-vst.14',
              worktree: {
                checkout_path: worktree,
                is_linked_worktree: true,
                repo_key: 'repo',
                repo_name: 'gis',
                repo_root: '/repo',
              },
            },
          ],
          panes: [
            {
              pane_id: 'pane-worker',
              workspace_id: 'ws-worker',
              tab_id: 'tab-worker',
              agent_status: 'working',
              name: herdrAgentName('gis-vst.14'),
              agent_session: {
                source: 'test',
                agent: 'codex',
                kind: 'path',
                value: join(worktree, '.gis', 'run', 'worker.jsonl'),
              },
            },
          ],
        }),
    },
    git: {
      listWorktrees: async () => [
        {
          path: worktree,
          branch: 'gis-vst.14',
          isBare: false,
          isDetached: false,
          isPrunable: false,
        },
      ],
    },
  });

  assert.deepEqual(result.reopenedIssueIds, []);
  assert.deepEqual(result.orphanedWorktrees, []);
  assert.deepEqual(updates, []);
});

test('parses porcelain git worktree output', () => {
  assert.deepEqual(
    parseGitWorktreeList(`worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo/.worktrees/gis-vst.14
HEAD def
branch refs/heads/gis-vst.14
`),
    [
      {
        path: '/repo',
        branch: 'main',
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
      {
        path: '/repo/.worktrees/gis-vst.14',
        branch: 'gis-vst.14',
        isBare: false,
        isDetached: false,
        isPrunable: false,
      },
    ],
  );
});

test('gis run performs startup reconciliation before dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gis-recovery-cli-'));
  const binDirectory = join(directory, 'bin');
  const logPath = join(directory, 'bd.log');
  const socketPath = join(directory, 'herdr.sock');
  const worktreePath = join(directory, 'worktrees', 'gis-vst.14');
  await mkdir(join(directory, '.gis'));
  await mkdir(binDirectory);
  await writeFile(
    join(directory, '.gis', 'config.toml'),
    'base = "main"\n',
    'utf8',
  );
  await writeFile(
    join(binDirectory, 'bd'),
    `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
const bead = {
  id: "gis-vst.14",
  title: "recovery",
  description: "recovery",
  status: args[0] === "update" ? "open" : "in_progress",
  priority: 2,
  issue_type: "task"
};
if (args[0] === "update") {
  await appendFile(process.env.GIS_RECOVERY_LOG, JSON.stringify(args) + "\\n");
}
process.stdout.write(JSON.stringify([bead]) + "\\n");
`,
    'utf8',
  );
  await fakeGitScript(
    t,
    `process.stdout.write(\`worktree \${process.env.GIS_WORKTREE_PATH}
HEAD abc
branch refs/heads/gis-vst.14
\`);
`,
    { directory: binDirectory, name: 'git' },
  );
  await chmod(join(binDirectory, 'bd'), 0o755);

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newline));
      socket.end(
        JSON.stringify({
          id: request.id,
          result: {
            type: 'session_snapshot',
            snapshot: {
              version: '0.7.5',
              protocol: 17,
              workspaces: [],
              tabs: [],
              panes: [],
              layouts: [],
              agents: [],
            },
          },
        }) + '\n',
      );
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });

  try {
    await execFileAsync(process.execPath, [resolve('dist/cli.js'), 'run'], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
        HERDR_SOCKET_PATH: socketPath,
        GIS_RECOVERY_LOG: logPath,
        GIS_WORKTREE_PATH: worktreePath,
      },
    });

    const requests = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(requests[0][0], 'update');
    assert.equal(requests[0][1], 'gis-vst.14');
    assert.equal(requests[0][2], '--status=blocked');
    assert.match(
      requests[0][3],
      /--append-notes=.*failure phase: startup recovery/s,
    );
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
