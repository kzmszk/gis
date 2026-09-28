import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
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
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { herdrAgentName } from '../dist/worker.js';
import { parseSlopOptions } from '../dist/cli.js';

test('parses slop base overrides and rejects invalid thresholds before Git access', () => {
  assert.deepEqual(parseSlopOptions(['--base', 'develop', '--report']), {
    base: 'develop',
    maxDelta: 0.02,
    reportOnly: true,
  });
  assert.throws(
    () => parseSlopOptions(['--max-delta', 'not-a-number']),
    /slop max delta must be a non-negative number/,
  );
});

const execFileAsync = promisify(execFile);

test('importing the CLI module does not execute gis run', async () => {
  const moduleUrl = pathToFileURL(resolve('dist/cli.js')).href;
  const result = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(moduleUrl)})`,
  ]);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

const bead = {
  id: 'gis-vst.cli',
  title: 'CLI integration',
  description: 'exercise the default adapters',
  acceptance_criteria: 'run the full CLI path',
  status: 'open',
  priority: 1,
  issue_type: 'task',
};
const agentName = herdrAgentName(bead.id);

/** A late-recovery candidate whose worktree has an unparseable rev-list
 * count. Exercises the real `GitMergeAdapter.hasCommits()` guard (and its
 * exact error message) through `recoverLateCompletions`'s default adapters,
 * instead of a fake that merely re-throws a hand-authored string. */
const lateBrokenBead = {
  id: 'gis-vst.late-broken',
  title: 'late recovery: broken',
  description:
    'late-recovery integration fixture with an invalid rev-list count',
  status: 'blocked',
  priority: 2,
  issue_type: 'task',
  notes: 'failure phase: commit\nno commit ahead of base',
};

/** A late-recovery candidate that completes a full real-adapter merge:
 * `mergeGit.hasCommits`, `SerialMergeQueue.enqueue`, and
 * `herdr.worktreeRemove` receiving the workspace id resolved from the
 * snapshot -- the loop body `recoverLateCompletions` runs through default
 * (non-DI) adapters, which the in-memory-fake tests in
 * test/late-recovery.test.js do not exercise. */
const lateOkBead = {
  id: 'gis-vst.late-ok',
  title: 'late recovery: ok',
  description: 'late-recovery integration fixture that fully merges',
  status: 'blocked',
  priority: 2,
  issue_type: 'task',
  notes: 'failure phase: commit\nno commit ahead of base',
};

async function writeFakeCommands(root) {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'bd'),
    `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
await appendFile(process.env.GIS_BD_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(await readFile(process.env.GIS_BD_STATE, "utf8"));
const outputBead = () => ({ ...${JSON.stringify(bead)}, status: state.status });

if (args[0] === "ready") {
  process.stdout.write(JSON.stringify(state.status === "open" ? [outputBead()] : []) + "\\n");
} else if (args[0] === "list" && args.includes("--status=in_progress")) {
  process.stdout.write(JSON.stringify(state.status === "in_progress" ? [outputBead()] : []) + "\\n");
} else if (args[0] === "list" && args.includes("--status=blocked")) {
  process.stdout.write(JSON.stringify([${JSON.stringify(lateBrokenBead)}, ${JSON.stringify(lateOkBead)}]) + "\\n");
} else if (args[0] === "list" && args.includes("--label=human")) {
  process.stdout.write("[]\\n");
} else if (args[0] === "update" && args.includes("--status=in_progress")) {
  state.status = "in_progress";
  await writeFile(process.env.GIS_BD_STATE, JSON.stringify(state), "utf8");
  process.stdout.write(JSON.stringify([outputBead()]) + "\\n");
} else if (args[0] === "close") {
  const id = args[1];
  if (id === ${JSON.stringify(lateOkBead.id)}) {
    process.stdout.write(JSON.stringify([{ ...${JSON.stringify(lateOkBead)}, status: "closed" }]) + "\\n");
  } else {
    state.status = "closed";
    await writeFile(process.env.GIS_BD_STATE, JSON.stringify(state), "utf8");
    process.stdout.write(JSON.stringify([outputBead()]) + "\\n");
  }
} else {
  process.stdout.write("[]\\n");
}
`,
    'utf8',
  );
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.GIS_GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "worktree" && args[1] === "list") {
  process.stdout.write(
    "worktree " + process.env.GIS_BASE_PATH + "\\nHEAD base\\nbranch refs/heads/main\\n\\n" +
    "worktree " + process.env.GIS_LATE_BROKEN_PATH + "\\nHEAD 0000000000000000000000000000000000000000\\nbranch refs/heads/${lateBrokenBead.id}\\n\\n" +
    "worktree " + process.env.GIS_LATE_OK_PATH + "\\nHEAD 0000000000000000000000000000000000000000\\nbranch refs/heads/${lateOkBead.id}\\n\\n"
  );
} else if (args.includes("rev-list")) {
  // args = ["-C", "<path>", "rev-list", "--count", "main..HEAD"]
  const path = args[1];
  process.stdout.write(path === process.env.GIS_LATE_BROKEN_PATH ? "not-a-number\\n" : "1\\n");
}
`,
    'utf8',
  );
  await chmod(join(bin, 'bd'), 0o755);
  await chmod(join(bin, 'git'), 0o755);
  return bin;
}

function snapshot(agents = [], workspaces = []) {
  return {
    type: 'session_snapshot',
    snapshot: {
      version: '0.7.5',
      protocol: 17,
      workspaces,
      tabs: [],
      panes: [],
      layouts: [],
      agents,
    },
  };
}

test('gis run connects default bd, herdr, and git adapters through merge cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-cli-integration-'));
  const statePath = join(root, 'state.json');
  const bdLogPath = join(root, 'bd.log');
  const gitLogPath = join(root, 'git.log');
  const socketPath = join(root, 'herdr.sock');
  const worktreePath = join(root, 'worktrees', bead.id);
  const lateBrokenWorktreePath = join(root, 'worktrees', lateBrokenBead.id);
  const lateOkWorktreePath = join(root, 'worktrees', lateOkBead.id);
  const baseCwd = await realpath(root);
  const herdrEvents = [];
  let agentStarted = false;
  let launchSnapshots = 0;
  let agentSessionReported = false;
  await mkdir(join(root, '.gis'), { recursive: true });
  await writeFile(statePath, JSON.stringify({ status: 'open' }), 'utf8');
  // The broken late-recovery candidate's worktree only needs to exist as a
  // directory: its real GitMergeAdapter.hasCommits() call fails on the
  // unparseable rev-list count before any file inside it is read.
  await mkdir(lateBrokenWorktreePath, { recursive: true });
  // The ok late-recovery candidate needs a real prompt + result pair on
  // disk, since currentResult() in late-recovery.ts reads them directly
  // (it is not behind an injectable seam).
  await mkdir(join(lateOkWorktreePath, '.gis', 'run'), { recursive: true });
  await writeFile(
    join(lateOkWorktreePath, '.gis', 'run', 'implement-prompt.md'),
    [
      '# gis worker task',
      '',
      '- Run ID: `cli-late-ok-1`',
      '',
      '## Result file',
      '',
      'Before finishing, write a JSON result to `.gis/run/round-1-impl.json`.',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(lateOkWorktreePath, '.gis', 'run', 'round-1-impl.json'),
    JSON.stringify({
      run_id: 'cli-late-ok-1',
      status: 'done',
      summary: 'late completion recovered via cli integration',
    }),
    'utf8',
  );
  await writeFile(
    join(root, '.gis', 'config.toml'),
    [
      'concurrency = 1',
      'base = "main"',
      'verify = "true"',
      'kinds = ["codex"]',
      'blocked_timeout = "1s"',
    ].join('\n') + '\n',
    'utf8',
  );
  const bin = await writeFakeCommands(root);

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const request = JSON.parse(buffer.slice(0, newline));
      herdrEvents.push(request.method);
      let result;
      if (request.method === 'session.snapshot') {
        if (agentStarted && !agentSessionReported) launchSnapshots += 1;
        result = snapshot(
          agentStarted
            ? [
                {
                  agent: 'codex',
                  name: agentName,
                  pane_id: `pane-${bead.id}`,
                  workspace_id: `ws-${bead.id}`,
                  tab_id: `tab-${bead.id}`,
                  agent_status: agentSessionReported
                    ? 'done'
                    : launchSnapshots >= 2
                      ? 'done'
                      : 'working',
                  interactive_ready: true,
                  state_change_seq: 2,
                  agent_session: agentSessionReported
                    ? {
                        source: 'integration-test',
                        agent: 'codex',
                        kind: 'path',
                        value: join(
                          worktreePath,
                          '.gis',
                          'run',
                          'worker.jsonl',
                        ),
                      }
                    : undefined,
                },
              ]
            : [],
          // Always present, from the very first snapshot on: this is what
          // lets recoverLateCompletions's default (non-DI) herdr adapter
          // resolve a workspace id for each late-recovery candidate's
          // worktree.
          [
            {
              workspace_id: `ws-${lateBrokenBead.id}`,
              worktree: { checkout_path: lateBrokenWorktreePath },
            },
            {
              workspace_id: `ws-${lateOkBead.id}`,
              worktree: { checkout_path: lateOkWorktreePath },
            },
          ],
        );
      } else if (request.method === 'worktree.create') {
        await mkdir(join(root, 'worktrees', bead.id, '.gis', 'run'), {
          recursive: true,
        });
        result = {
          type: 'worktree_created',
          workspace: { workspace_id: `ws-${bead.id}`, label: bead.id },
          tab: { tab_id: `tab-${bead.id}`, workspace_id: `ws-${bead.id}` },
          root_pane: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: 'idle',
          },
          worktree: { path: worktreePath, label: bead.id },
        };
      } else if (request.method === 'agent.start') {
        agentStarted = true;
        result = {
          type: 'agent_started',
          agent: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: 'working',
            agent: agentName,
          },
          argv: request.params.args ?? [],
        };
      } else if (request.method === 'agent.prompt') {
        agentSessionReported = true;
        const promptContents = await readFile(
          join(worktreePath, '.gis', 'run', 'implement-prompt.md'),
          'utf8',
        );
        const runId = /Run ID: `([^`]+)`/.exec(promptContents)?.[1];
        assert.ok(runId);
        await Promise.all([
          writeFile(
            join(worktreePath, '.gis', 'run', 'round-1-impl.json'),
            JSON.stringify({
              run_id: runId,
              status: 'done',
              summary: 'CLI worker completed',
            }),
            'utf8',
          ),
          writeFile(
            join(worktreePath, '.gis', 'run', 'worker.jsonl'),
            '{}\n',
            'utf8',
          ),
        ]);
        result = {
          type: 'agent_prompted',
          agent: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: 'working',
            agent: agentName,
            agent_session: {
              source: 'integration-test',
              agent: 'codex',
              kind: 'path',
              value: join(worktreePath, '.gis', 'run', 'worker.jsonl'),
            },
          },
        };
      } else if (request.method === 'agent.wait') {
        result = {
          type: 'wait_matched',
          event: {
            event: 'agent.done',
            data: { type: 'agent.done', agent_status: 'done' },
          },
        };
      } else if (request.method === 'worktree.remove') {
        const workspaceId = request.params.workspace_id;
        result = {
          type: 'worktree_removed',
          workspace_id: workspaceId,
          path:
            workspaceId === `ws-${lateOkBead.id}`
              ? lateOkWorktreePath
              : worktreePath,
          forced: request.params.force === true,
        };
      } else {
        throw new Error(`unexpected herdr method ${request.method}`);
      }

      socket.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });

  try {
    const result = await execFileAsync(
      process.execPath,
      [resolve('dist/cli.js'), 'run'],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          HERDR_SOCKET_PATH: socketPath,
          GIS_BD_STATE: statePath,
          GIS_BD_LOG: bdLogPath,
          GIS_GIT_LOG: gitLogPath,
          GIS_BASE_PATH: root,
          GIS_LATE_BROKEN_PATH: lateBrokenWorktreePath,
          GIS_LATE_OK_PATH: lateOkWorktreePath,
        },
      },
    );

    // 2 = the late-ok candidate recovered by recoverLateCompletions's
    // default (real) adapters at startup, plus the 1 the run loop merges
    // afterwards.
    assert.match(
      result.stdout,
      /2件マージ \/ 0件 blocked \/ 0件が人間の確認待ち/,
    );
    // The late-broken candidate's failure report is only produced if the
    // real GitMergeAdapter.hasCommits() guard actually throws on the
    // unparseable rev-list count (instead of silently treating it as "no
    // commits ahead"); this is what keeps the guard and its message honest
    // through the default (non-DI) adapter path, since the fake used by the
    // "reports a per-bead failure" test in late-recovery.test.js re-throws
    // a hand-authored copy of this string rather than the real one.
    assert.match(
      result.stderr,
      /late completion recovery failed for gis-vst\.late-broken.*invalid count/,
    );
    assert.equal(
      JSON.parse(await readFile(statePath, 'utf8')).status,
      'closed',
    );
    assert.deepEqual(herdrEvents, [
      'session.snapshot',
      'session.snapshot',
      // The late-ok candidate's cleanup: herdr.worktreeRemove receiving the
      // workspace id resolved from the startup snapshot, driven entirely by
      // recoverLateCompletions's default adapters (no DI fakes).
      'worktree.remove',
      'worktree.create',
      'session.snapshot',
      'agent.start',
      'session.snapshot',
      'session.snapshot',
      'agent.prompt',
      'agent.wait',
      'session.snapshot',
      'session.snapshot',
      'worktree.remove',
    ]);
    assert.deepEqual(
      (await readFile(gitLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        ['worktree', 'list', '--porcelain'],
        ['worktree', 'list', '--porcelain'],
        // recoverLateCompletions's own hasCommits() gate for each
        // late-recovery candidate, in blocked-list order. The broken
        // candidate's real GitMergeAdapter.hasCommits() throws here (an
        // unparseable rev-list count), which is caught and reported without
        // aborting the rest of the loop -- so no further git calls for it.
        ['-C', lateBrokenWorktreePath, 'rev-list', '--count', 'main..HEAD'],
        ['-C', lateOkWorktreePath, 'rev-list', '--count', 'main..HEAD'],
        // The merge queue then re-does rebase/hasCommits/changedPaths for
        // the late-ok candidate itself.
        ['-C', lateOkWorktreePath, 'rebase', 'main'],
        ['-C', lateOkWorktreePath, 'rev-list', '--count', 'main..HEAD'],
        ['-C', lateOkWorktreePath, 'diff', '--name-only', 'main..HEAD'],
        ['-C', baseCwd, 'merge', '--ff-only', lateOkBead.id],
        ['-C', baseCwd, 'branch', '-d', lateOkBead.id],
        // The normal run-loop path for the main bead, unchanged.
        ['-C', worktreePath, 'rebase', 'main'],
        ['-C', worktreePath, 'rev-list', '--count', 'main..HEAD'],
        ['-C', worktreePath, 'diff', '--name-only', 'main..HEAD'],
        ['-C', baseCwd, 'merge', '--ff-only', bead.id],
        ['-C', baseCwd, 'branch', '-d', bead.id],
      ],
    );
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
