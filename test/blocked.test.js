import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrApiError } from "../dist/herdr.js";
import {
  formatBlockedNotification,
  parseBlockedTimeout,
  waitForAgentWithBlockedHandling,
} from "../dist/blocked.js";

const handoff = {
  beadId: "gis-vst.9",
  target: "gis-vst.9",
  worktreePath: "/repo/.worktrees/gis-vst.9",
  roundLogPath: "/repo/.worktrees/gis-vst.9/.gis/run",
  transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
  blockedTimeout: "500ms",
  workerTimeout: "1h",
};

const blockedResult = {
  type: "wait_matched",
  event: {
    event: "pane_agent_status_changed",
    data: { type: "pane_agent_status_changed", agent_status: "blocked" },
  },
};

const doneResult = {
  type: "wait_matched",
  event: {
    event: "pane_agent_status_changed",
    data: { type: "pane_agent_status_changed", agent_status: "done" },
  },
};

test("parses blocked timeout durations and formats a human notification", () => {
  assert.equal(parseBlockedTimeout("500ms"), 500);
  assert.equal(parseBlockedTimeout("15m"), 900_000);
  assert.equal(parseBlockedTimeout("1d"), 86_400_000);
  assert.throws(() => parseBlockedTimeout("soon"), /positive duration/);

  assert.match(formatBlockedNotification(handoff), /blocked/);
  assert.match(formatBlockedNotification(handoff), /worktree \/repo\/\.worktrees\/gis-vst\.9/);
});

test("keeps the blocked pane available while a human resumes it", async () => {
  const waits = [];
  const notifications = [];
  const marked = [];
  const result = await waitForAgentWithBlockedHandling({
    ...handoff,
    herdr: {
      agentWait: async (target, options) => {
        waits.push({ target, options });
        return waits.length === 1 ? blockedResult : doneResult;
      },
    },
    beads: {
      markBlocked: async (...args) => {
        marked.push(args);
        return { id: handoff.beadId, title: "blocked", description: "", status: "blocked", priority: 2, issue_type: "task" };
      },
    },
    notify: (message) => notifications.push(message),
  });

  assert.deepEqual(result, {
    status: "done",
    wasBlocked: true,
    worktreeRetained: true,
  });
  assert.equal(notifications.length, 1);
  assert.equal(marked.length, 0);
  assert.deepEqual(waits, [
    { target: handoff.target, options: { until: ["done", "blocked"], timeoutMs: 3_600_000 } },
    { target: handoff.target, options: { until: ["done"], timeoutMs: 500 } },
  ]);
});

test("marks the bead blocked after the human wait times out and keeps handoff paths", async () => {
  const waits = [];
  const notifications = [];
  const marked = [];
  const result = await waitForAgentWithBlockedHandling({
    ...handoff,
    herdr: {
      agentWait: async (target, options) => {
        waits.push({ target, options });
        if (waits.length === 1) {
          return blockedResult;
        }
        throw new HerdrApiError("timeout", "agent wait timed out");
      },
    },
    beads: {
      markBlocked: async (issueId, locations) => {
        marked.push({ issueId, locations });
        return { id: issueId, title: "blocked", description: "", status: "blocked", priority: 2, issue_type: "task" };
      },
    },
    notify: (message) => notifications.push(message),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.worktreeRetained, true);
  assert.equal(notifications.length, 1);
  assert.deepEqual(marked, [{
    issueId: handoff.beadId,
    locations: {
      worktreePath: handoff.worktreePath,
      roundLogPath: handoff.roundLogPath,
      transcriptPath: handoff.transcriptPath,
      failurePhase: "blocked timeout",
    },
  }]);
  assert.deepEqual(waits[1], {
    target: handoff.target,
    options: { until: ["done"], timeoutMs: 500 },
  });
});

test("does not turn unrelated herdr failures into blocked beads", async () => {
  const marked = [];
  let calls = 0;
  await assert.rejects(
    waitForAgentWithBlockedHandling({
      ...handoff,
      herdr: {
        agentWait: async () => {
          calls += 1;
          if (calls === 1) {
            return blockedResult;
          }
          throw new Error("socket disconnected");
        },
      },
      beads: {
        markBlocked: async () => {
          marked.push(true);
          return { id: handoff.beadId, title: "blocked", description: "", status: "blocked", priority: 2, issue_type: "task" };
        },
      },
      notify: () => {},
    }),
    /socket disconnected/,
  );
  assert.deepEqual(marked, []);
});

test("times out a worker that never reports done or blocked", async () => {
  const marked = [];
  const result = await waitForAgentWithBlockedHandling({
    ...handoff,
    workerTimeout: "5ms",
    herdr: {
      async agentWait(_target, options) {
        assert.equal(options.timeoutMs, 5);
        throw new HerdrApiError("timeout", "agent wait timed out");
      },
    },
    beads: {
      async markBlocked(issueId, locations) {
        marked.push({ issueId, locations });
        return { id: issueId, title: "blocked", description: "", status: "blocked", priority: 2, issue_type: "task" };
      },
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.wasBlocked, false);
  assert.equal(marked[0].locations.failurePhase, "worker timeout");
});
