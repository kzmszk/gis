import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runVerificationLoop } from "../dist/verify.js";

const bead = {
  id: "gis-vst.8",
  description: "Run the configured verification loop.",
  acceptance_criteria: "Retry verification in the same implementation pane.",
};

async function withRunPath(callback) {
  const root = await mkdtemp(join(tmpdir(), "gis-verify-"));
  const runPath = join(root, ".gis", "run");
  try {
    return await callback({ root, runPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function options(overrides = {}) {
  return {
    bead,
    worktreePath: "/repo/.worktrees/gis-vst.8",
    runPath: "/repo/.worktrees/gis-vst.8/.gis/run",
    transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
    config: { verify: "npm test", verify_max: 3, verify_timeout: "15m" },
    beads: {
      async markBlocked(issueId, locations) {
        return {
          ...bead,
          id: issueId,
          status: "blocked",
          priority: 2,
          issue_type: "task",
          locations,
        };
      },
    },
    ...overrides,
  };
}

test("returns after the first passing verify without prompting the pane", async () => {
  const calls = [];
  const result = await runVerificationLoop(options({
    runVerify: async (...args) => {
      calls.push(args);
      return { passed: true, stdout: "ok" };
    },
    herdr: {
      async agentPrompt(...args) {
        calls.push(args);
        return {};
      },
    },
  }));

  assert.equal(result.status, "verified");
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls, [["npm test", "/repo/.worktrees/gis-vst.8", 900_000]]);
});

test("retries in the same pane and records verification feedback in the next round prompt", async () => {
  await withRunPath(async ({ root, runPath }) => {
    const verifies = [];
    const prompts = [];
    const waits = [];
    let attempt = 0;
    const result = await runVerificationLoop(options({
      worktreePath: root,
      runPath,
      runVerify: async (...args) => {
        verifies.push(args);
        attempt += 1;
        return attempt === 1
          ? { passed: false, stdout: "1 failing test", stderr: "AssertionError" }
          : { passed: true, stdout: "ok" };
      },
      herdr: {
        async agentPrompt(target, text, promptOptions) {
          prompts.push({ target, text, promptOptions });
          return {};
        },
      },
      waitForWorker: async () => {
        waits.push(true);
      },
    }));

    assert.equal(result.status, "verified");
    assert.equal(result.attempts, 2);
    assert.deepEqual(verifies, [["npm test", root, 900_000], ["npm test", root, 900_000]]);
    assert.deepEqual(prompts, [{
      target: bead.id,
      text: "Read .gis/run/prompt.md and execute it.",
      promptOptions: { wait: { until: ["working"], timeoutMs: 10_000 } },
    }]);
    assert.deepEqual(waits, [true]);
    const prompt = await readFile(join(runPath, "prompt.md"), "utf8");
    assert.match(prompt, /Previous verification failure/);
    assert.match(prompt, /1 failing test/);
    assert.match(prompt, /AssertionError/);
    assert.match(prompt, /round-2-impl\.json/);
  });
});

test("blocks exactly at verify_max without an extra retry and keeps all three handoff paths", async () => {
  await withRunPath(async ({ root, runPath }) => {
    const verifies = [];
    const prompts = [];
    const waits = [];
    const marked = [];
    const result = await runVerificationLoop(options({
      worktreePath: root,
      runPath,
      config: { verify: "npm test", verify_max: 2, verify_timeout: "15m" },
      runVerify: async (...args) => {
        verifies.push(args);
        return { passed: false, stderr: "still failing" };
      },
      herdr: {
        async agentPrompt(...args) {
          prompts.push(args);
          return {};
        },
      },
      waitForWorker: async () => {
        waits.push(true);
      },
      beads: {
        async markBlocked(issueId, locations) {
          marked.push({ issueId, locations });
          return { ...bead, id: issueId, status: "blocked", priority: 2, issue_type: "task" };
        },
      },
    }));

    assert.equal(result.status, "blocked");
    assert.equal(result.attempts, 2);
    assert.equal(verifies.length, 2);
    assert.equal(prompts.length, 1);
    assert.deepEqual(waits, [true]);
    assert.deepEqual(marked, [{
      issueId: bead.id,
      locations: {
        worktreePath: root,
        roundLogPath: runPath,
        transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
      },
    }]);
  });
});

test("refreshes the transcript before a final verification handoff", async () => {
  const marked = [];
  const result = await runVerificationLoop(options({
    config: { verify: "npm test", verify_max: 1, verify_timeout: "15m" },
    runVerify: async () => ({ passed: false, stderr: "still failing" }),
    resolveTranscriptPath: async () => "/home/kazu/.codex/sessions/live-session.jsonl",
    beads: {
      async markBlocked(issueId, locations) {
        marked.push({ issueId, locations });
        return { ...bead, id: issueId, status: "blocked", priority: 2, issue_type: "task" };
      },
    },
  }));

  assert.equal(result.status, "blocked");
  assert.equal(marked[0].locations.transcriptPath,
    "/home/kazu/.codex/sessions/live-session.jsonl");
});

test("rejects a non-positive verify_max before running a command", async () => {
  await assert.rejects(
    runVerificationLoop(options({ config: { verify: "npm test", verify_max: 0 } })),
    /config\.verify_max must be a positive integer/,
  );
});
