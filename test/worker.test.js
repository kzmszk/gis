import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { WORKER_PROMPT, startWorker, writeWorkerPrompt } from "../dist/worker.js";

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts the worker after writing prompt.md and injects exactly one TUI line", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-worker-start-"));
  const calls = [];
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
        async agentPrompt(target, text) {
          calls.push({ type: "prompt", target, text });
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
    assert.deepEqual(calls, [
      {
        type: "start",
        options: {
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
        },
      },
      { type: "prompt", target: "gis-vst.6", text: WORKER_PROMPT },
    ]);
    assert.equal(WORKER_PROMPT, "Read .gis/run/prompt.md and execute it.");
    assert.equal(calls.filter((call) => call.type === "prompt").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
