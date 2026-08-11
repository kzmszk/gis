import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HerdrAdapter, HerdrApiError } from "../dist/herdr.js";

async function withHerdrSocket(handler, callback) {
  const directory = await mkdtemp(join(tmpdir(), "gis-herdr-"));
  const socketPath = join(directory, "herdr.sock");
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        requests.push(request);
        await handler(request, socket);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    return await callback(socketPath, requests);
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
}

function reply(socket, request, result) {
  socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
}

test("runs the worktree and agent lifecycle over herdr's socket API", async () => {
  await withHerdrSocket(async (request, socket) => {
    switch (request.method) {
      case "worktree.create":
        reply(socket, request, {
          type: "worktree_created",
          workspace: { workspace_id: "ws-1", label: "gis-vst.4" },
          tab: { tab_id: "tab-1", workspace_id: "ws-1" },
          root_pane: {
            pane_id: "pane-1",
            workspace_id: "ws-1",
            tab_id: "tab-1",
            agent_status: "unknown",
          },
          worktree: { path: "/tmp/gis-vst.4", label: "gis-vst.4" },
        });
        break;
      case "worktree.remove":
        reply(socket, request, {
          type: "worktree_removed",
          workspace_id: "ws-1",
          path: "/tmp/gis-vst.4",
          forced: true,
        });
        break;
      case "agent.start":
        reply(socket, request, {
          type: "agent_started",
          agent: { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1", agent_status: "idle" },
          argv: ["codex", "-m", "gpt-5.6-luna"],
        });
        break;
      case "agent.prompt":
        reply(socket, request, {
          type: "agent_prompted",
          agent: { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1", agent_status: "working" },
        });
        break;
      case "agent.wait":
        reply(socket, request, {
          type: "wait_matched",
          event: {
            event: "pane_agent_status_changed",
            data: { type: "pane_agent_status_changed", pane_id: "pane-1", agent_status: "done" },
          },
        });
        break;
      case "agent.read":
        reply(socket, request, {
          type: "pane_read",
          read: {
            pane_id: "pane-1",
            source: "recent",
            format: "text",
            text: "done",
            revision: 1,
            truncated: false,
          },
        });
        break;
      case "session.snapshot":
        reply(socket, request, {
          type: "session_snapshot",
          snapshot: {
            version: "0.7.5",
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
  }, async (socketPath, requests) => {
    const herdr = new HerdrAdapter({ socketPath, requestIdPrefix: "test" });
    const worktree = await herdr.worktreeCreate({ branch: "gis-vst.4", base: "main" });
    assert.equal(worktree.worktree.path, "/tmp/gis-vst.4");

    await herdr.agentStart({
      name: "gis-vst.4",
      kind: "codex",
      paneId: worktree.root_pane.pane_id,
      args: ["-m", "gpt-5.6-luna"],
      timeoutMs: 30_000,
    });
    await herdr.agentPrompt("gis-vst.4", "Read .gis/run/prompt.md and execute it.");
    const wait = await herdr.agentWait("gis-vst.4");
    assert.equal(wait.event.data.agent_status, "done");

    const read = await herdr.agentRead("gis-vst.4");
    assert.equal(read.read.text, "done");
    const snapshot = await herdr.apiSnapshot();
    assert.equal(snapshot.snapshot.protocol, 17);
    await herdr.worktreeRemove("ws-1", { force: true });

    assert.deepEqual(requests.map(({ method }) => method), [
      "worktree.create",
      "agent.start",
      "agent.prompt",
      "agent.wait",
      "agent.read",
      "session.snapshot",
      "worktree.remove",
    ]);
    assert.deepEqual(requests[0].params, { branch: "gis-vst.4", base: "main" });
    assert.deepEqual(requests[1].params, {
      name: "gis-vst.4",
      kind: "codex",
      pane_id: "pane-1",
      args: ["-m", "gpt-5.6-luna"],
      timeout_ms: 30_000,
    });
    assert.deepEqual(requests[3].params, { target: "gis-vst.4", until: ["done", "blocked"] });
    assert.deepEqual(requests[4].params, {
      target: "gis-vst.4",
      source: "recent",
      format: "text",
      strip_ansi: true,
    });
  });
});

test("surfaces herdr API errors with their machine-readable code", async () => {
  await withHerdrSocket(async (request, socket) => {
    socket.end(JSON.stringify({
      id: request.id,
      error: { code: "not_git_worktree", message: "not a git worktree" },
    }) + "\n");
  }, async (socketPath) => {
    const herdr = new HerdrAdapter(socketPath);
    await assert.rejects(
      herdr.worktreeCreate({ branch: "gis-vst.4" }),
      (error) => error instanceof HerdrApiError &&
        error.code === "not_git_worktree" &&
        error.message.includes("not a git worktree"),
    );
  });
});
