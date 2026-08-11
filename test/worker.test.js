import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../dist/config.js";
import {
  WORKER_PROMPT,
  WorkerStartupError,
  startWorker,
  writeWorkerPrompt,
} from "../dist/worker.js";

const bead = {
  id: "gis-vst.6",
  description: "Implement the worker dispatch path without putting long instructions in the TUI.",
  acceptance_criteria: "The prompt file contains the task and the TUI receives one line.",
};

test("writes the detailed worker instructions and result protocol to prompt.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-prompt-"));
  try {
    const prompt = await writeWorkerPrompt({
      bead,
      runPath: join(root, ".gis", "run"),
      verifyCommand: "npm test && npm run lint",
      round: 2,
    });

    assert.equal(prompt.path, join(root, ".gis", "run", "prompt.md"));
    assert.equal(prompt.resultPath, join(root, ".gis", "run", "round-2-impl.json"));
    assert.equal(await readFile(prompt.path, "utf8"), prompt.content);
    assert.match(prompt.content, /gis-vst\.6/);
    assert.match(prompt.content, /The prompt file contains the task/);
    assert.match(prompt.content, /npm test && npm run lint/);
    assert.match(prompt.content, /\.gis\/run\/round-2-impl\.json/);
    assert.match(prompt.content, /status.*done.*failed/s);
    assert.match(prompt.content, /Commit all intended implementation changes/);
    assert.match(prompt.content, /explicitly authorizes one task commit/);
    assert.match(prompt.content, /overrides any conservative or no-git default/);
    assert.match(prompt.content, /Do not push the branch/);
    assert.match(prompt.content, /GIS owns task-state transitions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts the worker after writing prompt.md and injects exactly one TUI line", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-start-"));
  const calls = [];
  let agentStarted = false;
  try {
    const result = await startWorker({
      bead,
      runPath: join(root, ".gis", "run"),
      verifyCommand: "npm test",
      paneId: "pane-gis-vst.6",
      candidate: DEFAULT_CONFIG.profiles.implement[0],
      config: DEFAULT_CONFIG,
      herdr: {
        async agentStart(options) {
          calls.push({ type: "start", options });
          agentStarted = true;
          return {
            type: "agent_started",
            agent: {
              pane_id: options.paneId,
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
            argv: [options.kind, ...(options.args ?? [])],
          };
        },
        async apiSnapshot() {
          calls.push({ type: "snapshot" });
          return {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.5",
              protocol: 17,
              workspaces: [],
              tabs: [],
              panes: [],
              layouts: [],
              agents: agentStarted ? [{
                agent: "codex",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "working",
                interactive_ready: true,
                state_change_seq: 2,
              }] : [],
            },
          };
        },
        async agentPrompt(target, text, options) {
          calls.push({ type: "prompt", target, text, options });
          return {
            type: "agent_prompted",
            agent: {
              pane_id: "pane-gis-vst.6",
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
          };
        },
      },
    });

    assert.equal(await readFile(result.prompt.path, "utf8"), result.prompt.content);
    assert.deepEqual(calls.map(({ type }) => type), [
      "snapshot",
      "start",
      "snapshot",
      "prompt",
    ]);
    assert.deepEqual(calls[1].options, {
      name: "gis-vst.6",
      kind: "codex",
      paneId: "pane-gis-vst.6",
      args: [
        "-m",
        "gpt-5.6-luna",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-a",
        "on-request",
        "-s",
        "workspace-write",
      ],
      timeoutMs: calls[1].options.timeoutMs,
    });
    assert.ok(calls[1].options.timeoutMs >= 299_000);
    assert.ok(calls[1].options.timeoutMs <= 300_000);
    assert.equal(calls[3].target, "gis-vst.6");
    assert.equal(calls[3].text, WORKER_PROMPT);
    assert.deepEqual(calls[3].options.wait.until, ["working"]);
    assert.ok(calls[3].options.wait.timeoutMs >= 299_000);
    assert.ok(calls[3].options.wait.timeoutMs <= 300_000);
    assert.equal(WORKER_PROMPT, "Read .gis/run/prompt.md and execute it.");
    assert.equal(calls.filter((call) => call.type === "prompt").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waits for the named agent in the target pane to become interactive-ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-ready-"));
  const calls = [];
  let snapshots = 0;
  try {
    await startWorker({
      bead,
      runPath: join(root, ".gis", "run"),
      verifyCommand: "npm test",
      paneId: "pane-gis-vst.6",
      candidate: DEFAULT_CONFIG.profiles.implement[0],
      config: DEFAULT_CONFIG,
      herdr: {
        async agentStart(options) {
          calls.push("start");
          return {
            type: "agent_started",
            agent: {
              pane_id: options.paneId,
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
            argv: [],
          };
        },
        async apiSnapshot() {
          calls.push("snapshot");
          snapshots += 1;
          return {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.5",
              protocol: 17,
              workspaces: [],
              tabs: [],
              panes: [],
              layouts: [],
              agents: snapshots === 1 ? [{
                agent: "codex",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "working",
                interactive_ready: true,
                state_change_seq: 10,
              }] : snapshots === 2 ? [{
                agent: "claude",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "working",
                interactive_ready: true,
                state_change_seq: 11,
              }] : [{
                agent: "codex",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "working",
                interactive_ready: true,
                state_change_seq: 11,
              }],
            },
          };
        },
        async agentPrompt() {
          calls.push("prompt");
          return {
            type: "agent_prompted",
            agent: {
              pane_id: "pane-gis-vst.6",
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
          };
        },
      },
    });

    assert.deepEqual(calls, ["snapshot", "start", "snapshot", "snapshot", "prompt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back after the exact launch-pending agent stays idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-idle-ready-"));
  const calls = [];
  let started = false;
  try {
    await startWorker({
      bead,
      runPath: join(root, ".gis", "run"),
      verifyCommand: "npm test",
      paneId: "pane-gis-vst.6",
      candidate: DEFAULT_CONFIG.profiles.implement[0],
      config: DEFAULT_CONFIG,
      idleReadinessFallbackMs: 1,
      herdr: {
        async agentStart(options) {
          calls.push("start");
          started = true;
          return {
            type: "agent_started",
            agent: {
              pane_id: options.paneId,
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "idle",
            },
            argv: [],
          };
        },
        async apiSnapshot() {
          calls.push("snapshot");
          return {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.5",
              protocol: 17,
              workspaces: [],
              tabs: [],
              panes: [],
              layouts: [],
              agents: started ? [{
                agent: "codex",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "idle",
                launch_pending: true,
                state_change_seq: 11,
              }] : [],
            },
          };
        },
        async agentPrompt() {
          calls.push("prompt");
          return {
            type: "agent_prompted",
            agent: {
              pane_id: "pane-gis-vst.6",
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
          };
        },
      },
    });

    assert.deepEqual(calls, ["snapshot", "start", "snapshot", "snapshot", "prompt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restarts the idle fallback window when the agent state sequence changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-idle-sequence-"));
  const calls = [];
  let started = false;
  let readySnapshots = 0;
  try {
    await startWorker({
      bead,
      runPath: join(root, ".gis", "run"),
      verifyCommand: "npm test",
      paneId: "pane-gis-vst.6",
      candidate: DEFAULT_CONFIG.profiles.implement[0],
      config: DEFAULT_CONFIG,
      idleReadinessFallbackMs: 1,
      herdr: {
        async agentStart(options) {
          calls.push("start");
          started = true;
          return {
            type: "agent_started",
            agent: {
              pane_id: options.paneId,
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "idle",
            },
            argv: [],
          };
        },
        async apiSnapshot() {
          calls.push("snapshot");
          if (started) readySnapshots += 1;
          return {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.5",
              protocol: 17,
              workspaces: [],
              tabs: [],
              panes: [],
              layouts: [],
              agents: started ? [{
                agent: "codex",
                name: bead.id,
                pane_id: "pane-gis-vst.6",
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "idle",
                launch_pending: true,
                state_change_seq: readySnapshots === 1 ? 11 : 12,
              }] : [],
            },
          };
        },
        async agentPrompt() {
          calls.push("prompt");
          return {
            type: "agent_prompted",
            agent: {
              pane_id: "pane-gis-vst.6",
              workspace_id: "workspace-gis-vst.6",
              tab_id: "tab-gis-vst.6",
              agent_status: "working",
            },
          };
        },
      },
    });

    assert.deepEqual(calls, [
      "snapshot",
      "start",
      "snapshot",
      "snapshot",
      "snapshot",
      "prompt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not prompt or classify readiness snapshot failure as start failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-ready-failure-"));
  let prompted = false;
  let snapshots = 0;
  try {
    await assert.rejects(
      startWorker({
        bead,
        runPath: join(root, ".gis", "run"),
        verifyCommand: "npm test",
        paneId: "pane-gis-vst.6",
        candidate: DEFAULT_CONFIG.profiles.implement[0],
        config: DEFAULT_CONFIG,
        herdr: {
          async agentStart(options) {
            return {
              type: "agent_started",
              agent: {
                pane_id: options.paneId,
                workspace_id: "workspace-gis-vst.6",
                tab_id: "tab-gis-vst.6",
                agent_status: "working",
              },
              argv: [],
            };
          },
          async apiSnapshot() {
            snapshots += 1;
            if (snapshots > 1) {
              throw new Error("snapshot unavailable");
            }
            return {
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
            };
          },
          async agentPrompt() {
            prompted = true;
            throw new Error("must not be called");
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof WorkerStartupError);
        assert.equal(error.phase, "readiness");
        assert.match(error.message, /snapshot unavailable/);
        return true;
      },
    );
    assert.equal(prompted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a worker timeout that herdr agent.start cannot accept", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-invalid-timeout-"));
  try {
    await assert.rejects(
      startWorker({
        bead,
        runPath: join(root, ".gis", "run"),
        verifyCommand: "npm test",
        paneId: "pane-gis-vst.6",
        candidate: DEFAULT_CONFIG.profiles.implement[0],
        config: { ...DEFAULT_CONFIG, worker_timeout: "3000ms" },
        herdr: {
          async agentStart() { throw new Error("must not be called"); },
          async apiSnapshot() { throw new Error("must not be called"); },
          async agentPrompt() { throw new Error("must not be called"); },
        },
      }),
      /worker_timeout must be greater than 3000ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
