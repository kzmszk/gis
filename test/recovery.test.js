import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseGitWorktreeList, reconcileStartup } from '../dist/recovery.js';

const execFileAsync = promisify(execFile);

const bead = (id, status = 'in_progress') => ({
  id,
  title: id,
  description: 'test bead',
  status,
  priority: 2,
  issue_type: 'task',
});

const snapshot = ({ workspaces = [], panes = [] } = {}) => ({
  type: 'session_snapshot',
  snapshot: {
    version: '0.7.5',
    protocol: 17,
    workspaces,
    tabs: [],
    panes,
    layouts: [],
    agents: [],
  },
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

test('gis run performs startup reconciliation before dispatch', async () => {
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
  await writeFile(
    join(binDirectory, 'git'),
    `#!/usr/bin/env node
process.stdout.write(\`worktree \${process.env.GIS_WORKTREE_PATH}
HEAD abc
branch refs/heads/gis-vst.14
\`);
`,
    'utf8',
  );
  await chmod(join(binDirectory, 'bd'), 0o755);
  await chmod(join(binDirectory, 'git'), 0o755);

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
