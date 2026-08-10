import assert from "node:assert/strict";
import { test } from "node:test";
import { SerialMergeQueue, runMergeQueue } from "../dist/merge.js";

const bead = (id) => ({ id });

function item(id, events) {
  return {
    bead: bead(id),
    worktree: {
      path: `/repo/.worktrees/${id}`,
      runPath: `/repo/.worktrees/${id}/.gis/run`,
      async remove() {
        events.push(`${id}:remove`);
      },
    },
    transcriptPath: `/home/kazu/.codex/sessions/${id}.jsonl`,
  };
}

function options(events, overrides = {}) {
  return {
    repositoryPath: "/repo",
    baseBranch: "main",
    verifyCommand: "npm test",
    git: {
      async rebase(worktreePath, baseBranch) {
        events.push(`rebase:${worktreePath}:${baseBranch}`);
      },
      async merge(repositoryPath, branch) {
        events.push(`merge:${repositoryPath}:${branch}`);
      },
    },
    runVerify: async (command, cwd) => {
      events.push(`verify:${command}:${cwd}`);
      return { passed: true, stdout: "ok" };
    },
    beads: {
      async markMerged(issueId, reason) {
        events.push(`close:${issueId}:${reason}`);
        return { ...bead(issueId), title: issueId, description: "", status: "closed", priority: 1, issue_type: "task" };
      },
      async markBlocked(issueId, locations) {
        events.push(`blocked:${issueId}:${locations.worktreePath}`);
        return { ...bead(issueId), title: issueId, description: "", status: "blocked", priority: 1, issue_type: "task" };
      },
    },
    ...overrides,
  };
}

test("runs each merge lifecycle in order and removes only after bd close", async () => {
  const events = [];
  const queue = new SerialMergeQueue(options(events));
  const result = await queue.enqueue(item("gis-vst.10", events));

  assert.equal(result.status, "merged");
  assert.deepEqual(events, [
    "rebase:/repo/.worktrees/gis-vst.10:main",
    "verify:npm test:/repo/.worktrees/gis-vst.10",
    "merge:/repo:gis-vst.10",
    "close:gis-vst.10:merged after rebase and verify",
    "gis-vst.10:remove",
  ]);
});

test("does not re-block a closed bead when cleanup fails after merge", async () => {
  const events = [];
  const result = await new SerialMergeQueue(options(events)).enqueue({
    ...item("gis-vst.10", events),
    worktree: {
      path: "/repo/.worktrees/gis-vst.10",
      runPath: "/repo/.worktrees/gis-vst.10/.gis/run",
      async remove() {
        events.push("gis-vst.10:remove-failed");
        throw new Error("herdr unavailable");
      },
    },
  });

  assert.equal(result.status, "merged");
  assert.match(String(result.cleanupError), /herdr unavailable/);
  assert.deepEqual(events, [
    "rebase:/repo/.worktrees/gis-vst.10:main",
    "verify:npm test:/repo/.worktrees/gis-vst.10",
    "merge:/repo:gis-vst.10",
    "close:gis-vst.10:merged after rebase and verify",
    "gis-vst.10:remove-failed",
    "gis-vst.10:remove-failed",
  ]);
});

test("serializes concurrent enqueue calls and continues after a blocked item", async () => {
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const git = {
    async rebase(worktreePath) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      events.push(`rebase:${worktreePath}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
    async merge(repositoryPath, branch) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      events.push(`merge:${repositoryPath}:${branch}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  };
  const verifyCalls = [];
  const queue = new SerialMergeQueue(options(events, {
    git,
    runVerify: async (_command, cwd) => {
      verifyCalls.push(cwd);
      return cwd.endsWith("gis-vst.10")
        ? { passed: false, stderr: "conflict after rebase" }
        : { passed: true };
    },
  }));

  const first = item("gis-vst.10", events);
  const second = item("gis-vst.12", events);
  const results = await Promise.all([queue.enqueue(first), queue.enqueue(second)]);

  assert.deepEqual(results.map(({ status }) => status), ["blocked", "merged"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(verifyCalls, [
    "/repo/.worktrees/gis-vst.10",
    "/repo/.worktrees/gis-vst.12",
  ]);
  assert.deepEqual(events, [
    "rebase:/repo/.worktrees/gis-vst.10",
    "blocked:gis-vst.10:/repo/.worktrees/gis-vst.10",
    "rebase:/repo/.worktrees/gis-vst.12",
    "merge:/repo:gis-vst.12",
    "close:gis-vst.12:merged after rebase and verify",
    "gis-vst.12:remove",
  ]);
});

test("does not merge, close, or remove before a successful post-rebase verify", async () => {
  const events = [];
  const result = await runMergeQueue(
    [item("gis-vst.10", events)],
    options(events, {
      runVerify: async () => ({ passed: false, exitCode: 1, stderr: "still failing" }),
    }),
  );

  assert.equal(result[0].status, "blocked");
  assert.equal(result[0].phase, "verify");
  assert.deepEqual(result[0].handoff, {
    worktreePath: "/repo/.worktrees/gis-vst.10",
    roundLogPath: "/repo/.worktrees/gis-vst.10/.gis/run",
    transcriptPath: "/home/kazu/.codex/sessions/gis-vst.10.jsonl",
  });
  assert.deepEqual(events, [
    "rebase:/repo/.worktrees/gis-vst.10:main",
    "blocked:gis-vst.10:/repo/.worktrees/gis-vst.10",
  ]);
});

test("blocks a verification runner exception without cleanup", async () => {
  const events = [];
  const result = await new SerialMergeQueue(options(events, {
    runVerify: async () => {
      throw new Error("verification process could not start");
    },
  })).enqueue(item("gis-vst.10", events));

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "verify");
  assert.match(String(result.error), /verification process could not start/);
  assert.deepEqual(events, [
    "rebase:/repo/.worktrees/gis-vst.10:main",
    "blocked:gis-vst.10:/repo/.worktrees/gis-vst.10",
  ]);
});

test("blocks and retains the worktree when rebase fails", async () => {
  const events = [];
  const result = await new SerialMergeQueue(options(events, {
    git: {
      async rebase() {
        throw new Error("rebase conflict");
      },
      async merge() {
        events.push("merge");
      },
    },
  })).enqueue(item("gis-vst.10", events));

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "rebase");
  assert.match(String(result.error), /rebase conflict/);
  assert.deepEqual(events, ["blocked:gis-vst.10:/repo/.worktrees/gis-vst.10"]);
});
