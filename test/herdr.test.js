import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HerdrAdapter,
  HerdrApiError,
  HerdrConnectionError,
  HerdrProtocolError,
} from '../dist/herdr.js';

async function withHerdrSocket(handler, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'gis-herdr-'));
  const socketPath = join(directory, 'herdr.sock');
  const requests = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        requests.push(request);
        await handler(request, socket);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  try {
    return await callback(socketPath, requests);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
}

function reply(socket, request, result) {
  socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
}

async function rejectsInvalidResult(invoke, result, detail) {
  await withHerdrSocket(
    async (request, socket) => reply(socket, request, result),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        invoke(herdr),
        (error) =>
          error instanceof HerdrProtocolError &&
          (detail === undefined || error.message.includes(detail)),
      );
    },
  );
}

test("runs the worktree and agent lifecycle over herdr's socket API", async () => {
  await withHerdrSocket(
    async (request, socket) => {
      switch (request.method) {
        case 'worktree.create':
          reply(socket, request, {
            type: 'worktree_created',
            workspace: { workspace_id: 'ws-1', label: 'gis-vst.4' },
            tab: { tab_id: 'tab-1', workspace_id: 'ws-1' },
            root_pane: {
              pane_id: 'pane-1',
              workspace_id: 'ws-1',
              tab_id: 'tab-1',
              agent_status: 'unknown',
            },
            worktree: { path: '/tmp/gis-vst.4', label: 'gis-vst.4' },
            extension_field: { protocol_revision: 2 },
          });
          break;
        case 'worktree.remove':
          reply(socket, request, {
            type: 'worktree_removed',
            workspace_id: 'ws-1',
            path: '/tmp/gis-vst.4',
            forced: true,
          });
          break;
        case 'agent.start':
          reply(socket, request, {
            type: 'agent_started',
            agent: {
              pane_id: 'pane-1',
              workspace_id: 'ws-1',
              tab_id: 'tab-1',
              agent_status: 'idle',
              agent: 'gis-vst.4',
            },
            argv: ['codex', '-m', 'gpt-5.6-luna'],
          });
          break;
        case 'agent.prompt':
          reply(socket, request, {
            type: 'agent_prompted',
            agent: {
              pane_id: 'pane-1',
              workspace_id: 'ws-1',
              tab_id: 'tab-1',
              agent_status: 'working',
              agent: 'gis-vst.4',
            },
          });
          break;
        case 'agent.wait':
          reply(socket, request, {
            type: 'wait_matched',
            event: {
              event: 'pane_agent_status_changed',
              data: {
                type: 'pane_agent_status_changed',
                pane_id: 'pane-1',
                agent_status: 'done',
              },
            },
          });
          break;
        case 'agent.read':
          reply(socket, request, {
            type: 'pane_read',
            read: {
              pane_id: 'pane-1',
              source: 'recent',
              format: 'text',
              text: 'done',
              revision: 1,
              truncated: false,
            },
          });
          break;
        case 'session.snapshot':
          reply(socket, request, {
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
          });
          break;
        default:
          throw new Error(`unexpected method: ${request.method}`);
      }
    },
    async (socketPath, requests) => {
      const herdr = new HerdrAdapter({ socketPath, requestIdPrefix: 'test' });
      const worktree = await herdr.worktreeCreate({
        branch: 'gis-vst.4',
        base: 'main',
      });
      assert.equal(worktree.worktree.path, '/tmp/gis-vst.4');
      assert.deepEqual(worktree.extension_field, { protocol_revision: 2 });

      await herdr.agentStart({
        name: 'gis-vst.4',
        kind: 'codex',
        paneId: worktree.root_pane.pane_id,
        args: ['-m', 'gpt-5.6-luna'],
        timeoutMs: 30_000,
      });
      await herdr.agentPrompt(
        'gis-vst.4',
        'Read .gis/run/implement-prompt.md and execute it.',
        { wait: { until: ['working'], timeoutMs: 10_000 } },
      );
      const wait = await herdr.agentWait('gis-vst.4');
      assert.equal(wait.event.data.agent_status, 'done');

      const read = await herdr.agentRead('gis-vst.4');
      assert.equal(read.read.text, 'done');
      const snapshot = await herdr.apiSnapshot();
      assert.equal(snapshot.snapshot.protocol, 17);
      await herdr.worktreeRemove('ws-1', { force: true });

      assert.deepEqual(
        requests.map(({ method }) => method),
        [
          'worktree.create',
          'agent.start',
          'agent.prompt',
          'agent.wait',
          'agent.read',
          'session.snapshot',
          'worktree.remove',
        ],
      );
      assert.deepEqual(requests[0].params, {
        branch: 'gis-vst.4',
        base: 'main',
      });
      assert.deepEqual(requests[1].params, {
        name: 'gis-vst.4',
        kind: 'codex',
        pane_id: 'pane-1',
        args: ['-m', 'gpt-5.6-luna'],
        timeout_ms: 30_000,
      });
      assert.deepEqual(requests[2].params, {
        target: 'gis-vst.4',
        text: 'Read .gis/run/implement-prompt.md and execute it.',
        wait: { until: ['working'], timeout_ms: 10_000 },
      });
      assert.deepEqual(requests[3].params, {
        target: 'gis-vst.4',
        until: ['done', 'blocked'],
      });
      assert.deepEqual(requests[4].params, {
        target: 'gis-vst.4',
        source: 'recent',
        format: 'text',
        strip_ansi: true,
      });
    },
  );
});

test('surfaces herdr API errors with their machine-readable code', async () => {
  await withHerdrSocket(
    async (request, socket) => {
      socket.end(
        JSON.stringify({
          id: request.id,
          error: { code: 'not_git_worktree', message: 'not a git worktree' },
        }) + '\n',
      );
    },
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.worktreeCreate({ branch: 'gis-vst.4' }),
        (error) =>
          error instanceof HerdrApiError &&
          error.code === 'not_git_worktree' &&
          error.data === undefined &&
          error.message.includes('not a git worktree'),
      );
    },
  );
});

test('preserves API error data and rejects malformed error envelopes', async (t) => {
  await withHerdrSocket(
    async (request, socket) =>
      socket.end(
        JSON.stringify({
          id: request.id,
          error: {
            code: 'invalid_request',
            message: 'bad request',
            data: { field: 'branch', extension: true },
          },
        }) + '\n',
      ),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.worktreeCreate({ branch: 'gis-vst.4' }),
        (error) =>
          error instanceof HerdrApiError &&
          error.code === 'invalid_request' &&
          error.data?.field === 'branch' &&
          error.data?.extension === true,
      );
    },
  );

  for (const [field, value] of [
    ['code', undefined],
    ['code', 42],
    ['message', undefined],
    ['message', { text: 'bad' }],
  ]) {
    await t.test(`rejects malformed error ${field}`, async () => {
      await withHerdrSocket(
        async (request, socket) => {
          const error = { code: 'invalid_request', message: 'bad request' };
          error[field] = value;
          socket.end(JSON.stringify({ id: request.id, error }) + '\n');
        },
        async (socketPath) => {
          const herdr = new HerdrAdapter(socketPath);
          await assert.rejects(
            herdr.worktreeCreate({ branch: 'gis-vst.4' }),
            (error) =>
              error instanceof HerdrProtocolError &&
              error.message.includes(`response.error.${field}`),
          );
        },
      );
    });
  }
});

test('validates every successful Herdr method result at the API boundary', async (t) => {
  const pane = {
    pane_id: 'pane-1',
    workspace_id: 'ws-1',
    tab_id: 'tab-1',
    agent_status: 'idle',
  };
  const snapshot = {
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
  };

  await t.test(
    'worktree.create requires path and workspace identity',
    async () => {
      await rejectsInvalidResult(
        (herdr) => herdr.worktreeCreate({ branch: 'gis-vst.4' }),
        {
          type: 'worktree_created',
          workspace: { workspace_id: 'ws-1', label: 'gis-vst.4' },
          tab: { tab_id: 'tab-1', workspace_id: 'ws-1' },
          root_pane: pane,
          worktree: { label: 'gis-vst.4' },
        },
        'worktree.create result.worktree.path',
      );
    },
  );

  await t.test(
    'worktree.create validates workspace independently',
    async () => {
      await rejectsInvalidResult(
        (herdr) => herdr.worktreeCreate({ branch: 'gis-vst.4' }),
        {
          type: 'worktree_created',
          workspace: { label: 'gis-vst.4' },
          tab: { tab_id: 'tab-1', workspace_id: 'ws-1' },
          root_pane: pane,
          worktree: { path: '/tmp/gis-vst.4' },
        },
        'worktree.create result.workspace.workspace_id',
      );
    },
  );

  await t.test('worktree.remove requires a workspace id', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.worktreeRemove('ws-1'),
      {
        type: 'worktree_removed',
        workspace_id: 7,
        path: '/tmp/gis-vst.4',
        forced: false,
      },
      'worktree.remove result.workspace_id',
    );
  });

  await t.test('pane.split requires its discriminant and pane id', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.paneSplit(),
      { type: 'pane_info', extension_field: true },
      'pane.split result.pane must be an object',
    );
  });

  await t.test(
    'pane.split accepts the current pane_info response shape',
    async () => {
      await withHerdrSocket(
        async (request, socket) =>
          reply(socket, request, {
            type: 'pane_info',
            pane: { pane_id: 'review-pane', extension_field: 'allowed' },
          }),
        async (socketPath) => {
          const herdr = new HerdrAdapter(socketPath);
          const result = await herdr.paneSplit();
          assert.equal(result.type, 'pane_info');
          assert.equal(result.pane.pane_id, 'review-pane');
          assert.equal(result.pane.extension_field, 'allowed');
        },
      );
    },
  );

  await t.test('agent.start validates identity and status', async () => {
    await rejectsInvalidResult(
      (herdr) =>
        herdr.agentStart({
          name: 'gis-vst.4',
          kind: 'codex',
          paneId: 'pane-1',
        }),
      {
        type: 'agent_started',
        agent: { pane_id: 'pane-1', workspace_id: 'ws-1', tab_id: 'tab-1' },
        argv: [],
      },
      'agent.start result.agent.agent_status',
    );
  });

  await t.test('agent.prompt validates agent identity', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.agentPrompt('gis-vst.4', 'hello'),
      { type: 'agent_prompted', agent: pane },
      'agent.prompt result.agent.agent',
    );
  });

  await t.test(
    'agent.start accepts empty arguments but rejects non-strings',
    async () => {
      const result = {
        type: 'agent_started',
        agent: { ...pane, agent: 'gis-vst.4' },
        argv: ['codex', '', ' '],
      };
      const start = (herdr) =>
        herdr.agentStart({
          name: 'gis-vst.4',
          kind: 'codex',
          paneId: 'pane-1',
        });
      await withHerdrSocket(
        async (request, socket) => reply(socket, request, result),
        async (socketPath) => {
          const response = await start(new HerdrAdapter(socketPath));
          assert.deepEqual(response.argv, result.argv);
        },
      );
      await rejectsInvalidResult(
        start,
        { ...result, argv: ['codex', 42] },
        'agent.start result.argv[1]',
      );
    },
  );

  await t.test('agent.wait validates event payload', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.agentWait('gis-vst.4'),
      {
        type: 'wait_matched',
        event: { event: 'pane_agent_status_changed', data: { type: 4 } },
      },
      'agent.wait result.event.data.type',
    );
  });

  await t.test(
    'agent.wait accepts the already-matched agent_info variant',
    async () => {
      await withHerdrSocket(
        async (request, socket) =>
          reply(socket, request, {
            type: 'agent_info',
            agent: { ...pane, agent: 'gis-vst.4' },
          }),
        async (socketPath) => {
          const herdr = new HerdrAdapter(socketPath);
          const result = await herdr.agentWait('gis-vst.4');
          assert.equal(result.type, 'agent_info');
          assert.equal(result.agent.agent, 'gis-vst.4');
        },
      );
    },
  );

  await t.test('agent.read validates pane id and read fields', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.agentRead('gis-vst.4'),
      {
        type: 'pane_read',
        read: {
          source: 'recent',
          format: 'text',
          text: 'done',
          revision: 1,
          truncated: false,
        },
      },
      'agent.read result.read.pane_id',
    );
  });

  await t.test('agent.read validates fields beyond pane id', async () => {
    await rejectsInvalidResult(
      (herdr) => herdr.agentRead('gis-vst.4'),
      {
        type: 'pane_read',
        read: {
          pane_id: 'pane-1',
          source: 'recent',
          format: 'text',
          text: 'done',
          revision: '1',
          truncated: false,
        },
      },
      'agent.read result.read.revision',
    );
  });

  await t.test('session.snapshot validates every required array', async () => {
    for (const field of ['workspaces', 'tabs', 'panes', 'layouts', 'agents']) {
      const withoutField = { ...snapshot.snapshot };
      delete withoutField[field];
      await rejectsInvalidResult(
        (herdr) => herdr.apiSnapshot(),
        { ...snapshot, snapshot: withoutField },
        `session.snapshot result.snapshot.${field}`,
      );
    }
  });
});

test('rejects a wrong result discriminant for every Herdr method', async () => {
  const cases = [
    ['worktree.create', (herdr) => herdr.worktreeCreate({ branch: 'b' })],
    ['worktree.remove', (herdr) => herdr.worktreeRemove('ws')],
    ['pane.split', (herdr) => herdr.paneSplit()],
    [
      'agent.start',
      (herdr) =>
        herdr.agentStart({ name: 'agent', kind: 'codex', paneId: 'pane' }),
    ],
    ['agent.prompt', (herdr) => herdr.agentPrompt('agent', 'hello')],
    ['agent.wait', (herdr) => herdr.agentWait('agent')],
    ['agent.read', (herdr) => herdr.agentRead('agent')],
    ['session.snapshot', (herdr) => herdr.apiSnapshot()],
  ];
  for (const [method, invoke] of cases) {
    await rejectsInvalidResult(
      invoke,
      { type: 'unexpected_result_type' },
      `${method} result.type`,
    );
  }
});

test('classifies malformed Herdr envelopes as typed protocol errors', async () => {
  const missingSocket = join(
    tmpdir(),
    `gis-herdr-missing-${process.pid}-${Date.now()}.sock`,
  );
  await assert.rejects(
    new HerdrAdapter(missingSocket).apiSnapshot(),
    (error) => error instanceof HerdrConnectionError,
  );

  await withHerdrSocket(
    async (request, socket) => socket.end('\n'),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.apiSnapshot(),
        (error) => error instanceof HerdrProtocolError,
      );
    },
  );

  await withHerdrSocket(
    async (request, socket) => socket.end('null\n'),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.apiSnapshot(),
        (error) => error instanceof HerdrProtocolError,
      );
    },
  );

  for (const response of ['[]', '"text"', '7']) {
    await withHerdrSocket(
      async (request, socket) => socket.end(`${response}\n`),
      async (socketPath) => {
        const herdr = new HerdrAdapter(socketPath);
        await assert.rejects(
          herdr.apiSnapshot(),
          (error) => error instanceof HerdrProtocolError,
        );
      },
    );
  }

  await withHerdrSocket(
    async (request, socket) => socket.end('{"id":\n'),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.apiSnapshot(),
        (error) => error instanceof HerdrProtocolError,
      );
    },
  );

  await withHerdrSocket(
    async (request, socket) =>
      socket.end(
        JSON.stringify({ id: `${request.id}-other`, result: {} }) + '\n',
      ),
    async (socketPath) => {
      const herdr = new HerdrAdapter(socketPath);
      await assert.rejects(
        herdr.apiSnapshot(),
        (error) =>
          error instanceof HerdrProtocolError &&
          error.message.includes('does not match request'),
      );
    },
  );
});

test('destroys an unresponsive per-request socket at its deadline', async () => {
  await withHerdrSocket(
    async () => {
      // Deliberately leave the request unanswered. The client must close it.
    },
    async (socketPath) => {
      const herdr = new HerdrAdapter({ socketPath });
      await assert.rejects(
        herdr.apiSnapshot(10),
        (error) =>
          error instanceof HerdrConnectionError &&
          error.message.includes('timed out after 10ms'),
      );
    },
  );
});

test('destroys an unresponsive agent.wait socket at its requested deadline', async () => {
  await withHerdrSocket(
    async () => {
      // Deliberately leave the wait unanswered. Both Herdr and the client use this deadline.
    },
    async (socketPath, requests) => {
      const herdr = new HerdrAdapter({ socketPath });
      await assert.rejects(
        herdr.agentWait('gis-vst.4', { until: ['done'], timeoutMs: 10 }),
        (error) =>
          error instanceof HerdrConnectionError &&
          error.message.includes('timed out after 10ms'),
      );
      assert.deepEqual(requests[0].params, {
        target: 'gis-vst.4',
        until: ['done'],
        timeout_ms: 10,
      });
    },
  );
});
