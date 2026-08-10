import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatRunSummary, runForegroundLoop } from "../dist/run.js";
import { WorkerStartupError } from "../dist/worker.js";

const bead = (id, priority = 2, issueType = "task") => ({
  id,
  title: id,
  description: `implement ${id}`,
  status: "open",
  priority,
  issue_type: issueType,
});

function config(overrides = {}) {
  return {
    concurrency: 2,
    base: "main",
    verify: "npm test",
    kinds: ["codex"],
    review: false,
    verify_max: 2,
    review_max: 1,
    blocked_timeout: "1s",
    claude_permission_mode: "auto",
    profiles: {
      plan: [{ kind: "codex", model: "plan", effort: "low" }],
      implement: [{ kind: "codex", model: "implement", effort: "low" }],
      review: [{ kind: "codex", model: "review", effort: "low" }],
    },
    ...overrides,
  };
}

function dependencies(resultRoot) {
  const events = [];
  const worktrees = {
    async create({ bead: issue }) {
      events.push(`worktree:${issue.id}`);
      return {
        beadId: issue.id,
        path: `/repo/.worktrees/${issue.id}`,
        runPath: `/repo/.worktrees/${issue.id}/.gis/run`,
        workspaceId: `ws-${issue.id}`,
        paneId: `pane-${issue.id}`,
        async remove() {
          events.push(`remove:${issue.id}`);
        },
      };
    },
  };
  const workers = {
    async start({ bead: issue }) {
      events.push(`start:${issue.id}`);
      return {
        prompt: { resultPath: join(resultRoot, `${issue.id}.json`) },
        started: {},
        prompted: {},
      };
    },
  };
  return { events, worktrees, workers };
}

test("dispatches ready work within concurrency and refetches newly unblocked work", async () => {
  const first = bead("gis-vst.20", 2);
  const second = bead("gis-vst.19", 1);
  const dependent = bead("gis-vst.21", 3);
  const readyResponses = [
    [first, second, bead("gis-vst", 0, "epic")],
    [dependent],
    [],
  ];
  const events = [];
  const dispatched = [];
  const resultRoot = await mkdtemp(join(tmpdir(), "gis-run-results-"));
  const { worktrees, workers } = dependencies(resultRoot);
  const beads = {
    async ready() {
      events.push("ready");
      return readyResponses.shift() ?? [];
    },
    async dispatch(id, kind) {
      dispatched.push({ id, kind });
      events.push(`dispatch:${id}`);
      return { ...bead(id), status: "in_progress" };
    },
    async markBlocked(id) {
      events.push(`blocked:${id}`);
      return { ...bead(id), status: "blocked" };
    },
    async listHuman() {
      return [];
    },
  };
  const merge = {
    async enqueue({ bead: issue }) {
      events.push(`merge:${issue.id}`);
      return { status: "merged", bead: { ...issue, status: "closed" } };
    },
  };
  const wait = {
    async wait({ beadId }) {
      events.push(`wait:${beadId}`);
      return { status: "done", wasBlocked: false, worktreeRetained: false };
    },
  };
  const verify = {
    async verify({ bead: issue }) {
      events.push(`verify:${issue.id}`);
      return { status: "verified", attempts: 1, result: { passed: true } };
    },
  };
  await Promise.all([writeFile(join(resultRoot, "gis-vst.20.json"), '{"status":"done","summary":"ok"}'),
    writeFile(join(resultRoot, "gis-vst.19.json"), '{"status":"done","summary":"ok"}'),
    writeFile(join(resultRoot, "gis-vst.21.json"), '{"status":"done","summary":"ok"}')]);
  try {
    const result = await runForegroundLoop({
      config: config(),
      beads,
      worktrees,
      workers,
      blocked: wait,
      verify,
      merge,
      report: (message) => events.push(`summary:${message}`),
      herdr: { agentWait: async () => { throw new Error("unused"); } },
    });

    assert.equal(result.merged, 3);
    assert.equal(result.blocked, 0);
    assert.deepEqual(dispatched.map(({ id }) => id), ["gis-vst.19", "gis-vst.20", "gis-vst.21"]);
    assert.equal(events.filter((event) => event === "ready").length, 4);
    assert.match(result.text, /3件マージ \/ 0件 blocked \/ 0件が人間の確認待ち/);
  } finally {
    await rm(resultRoot, { recursive: true, force: true });
  }
});

test("blocks a bead when worktree creation fails without rejecting the run", async () => {
  const source = bead("gis-vst.worktree-failure");
  const blocked = [];
  let firstReady = true;
  const result = await runForegroundLoop({
    cwd: "/repo",
    config: config({ concurrency: 1 }),
    beads: {
      async ready() {
        if (firstReady) {
          firstReady = false;
          return [source];
        }
        return [];
      },
      async dispatch() {
        throw new Error("dispatch must not run without a worktree");
      },
      async markBlocked(id, locations) {
        blocked.push({ id, locations });
        return { ...source, id, status: "blocked" };
      },
      async createHumanGate() {
        throw new Error("human gate must not be created");
      },
    },
    worktrees: {
      async create() {
        throw new Error("worktree create failed");
      },
    },
    report: () => undefined,
  });

  assert.equal(result.merged, 0);
  assert.equal(result.blocked, 1);
  assert.deepEqual(blocked, [{
    id: source.id,
    locations: {
      worktreePath: "/repo/.worktrees/gis-vst.worktree-failure",
      roundLogPath: "/repo/.worktrees/gis-vst.worktree-failure/.gis/run",
      transcriptPath: "/repo/.worktrees/gis-vst.worktree-failure/.gis/run/transcript-unknown.unresolved",
    },
  }]);
});

test("falls back only after a runner start failure and records the selected kind", async () => {
  const resultRoot = await mkdtemp(join(tmpdir(), "gis-run-fallback-"));
  const source = bead("gis-vst.fallback");
  const dispatched = [];
  const started = [];
  let ready = true;
  await writeFile(join(resultRoot, `${source.id}.json`), '{"status":"done","summary":"ok"}');

  try {
    const result = await runForegroundLoop({
      config: config({
        kinds: ["codex", "claude"],
        profiles: {
          plan: [{ kind: "codex", model: "plan", effort: "low" }],
          implement: [
            { kind: "codex", model: "implement", effort: "low" },
            { kind: "claude", model: "implement", effort: "low" },
          ],
          review: [{ kind: "codex", model: "review", effort: "low" }],
        },
      }),
      beads: {
        async ready() {
          if (!ready) return [];
          ready = false;
          return [source];
        },
        async dispatch(id, kind) {
          dispatched.push({ id, kind });
          return { ...source, status: "in_progress" };
        },
        async markBlocked() {
          throw new Error("fallback bead must not block");
        },
        async createHumanGate() {
          throw new Error("human gate must not be created");
        },
      },
      worktrees: dependencies(resultRoot).worktrees,
      workers: {
        async start({ candidate }) {
          started.push(candidate.kind);
          if (candidate.kind === "codex") {
            throw new WorkerStartupError("start", new Error("codex unavailable"));
          }
          return {
            prompt: { resultPath: join(resultRoot, `${source.id}.json`) },
            started: {},
            prompted: {},
          };
        },
      },
      blocked: {
        async wait() {
          return { status: "done", wasBlocked: false, worktreeRetained: false };
        },
      },
      verify: {
        async verify() {
          return { status: "verified", attempts: 1, result: { passed: true } };
        },
      },
      merge: {
        async enqueue({ bead: issue }) {
          return { status: "merged", bead: { ...issue, status: "closed" } };
        },
      },
      report: () => undefined,
    });

    assert.equal(result.merged, 1);
    assert.deepEqual(started, ["codex", "claude"]);
    assert.deepEqual(dispatched, [
      { id: source.id, kind: "codex" },
      { id: source.id, kind: "claude" },
    ]);
  } finally {
    await rm(resultRoot, { recursive: true, force: true });
  }
});

test("does not dispatch an epic and reports existing human gates", async () => {
  const calls = [];
  const human = { ...bead("gis-vst.human"), labels: ["human"] };
  const result = await runForegroundLoop({
    config: config({ concurrency: 1 }),
    beads: {
      async ready() {
        calls.push("ready");
        return [bead("gis-vst", 1, "epic")];
      },
      async dispatch(id) {
        calls.push(`dispatch:${id}`);
        throw new Error("epic must not be dispatched");
      },
      async markBlocked() {
        throw new Error("no bead should be blocked");
      },
      async listHuman() {
        return [human];
      },
    },
    report: (message) => calls.push(`summary:${message}`),
  });

  assert.equal(result.merged, 0);
  assert.equal(result.blocked, 0);
  assert.equal(result.humanWaiting, 1);
  assert.deepEqual(calls, ["ready", "summary:0件マージ / 0件 blocked / 1件が人間の確認待ち"]);
});

test("creates a human gate in the run loop when the worker requests confirmation", async () => {
  const resultRoot = await mkdtemp(join(tmpdir(), "gis-run-human-"));
  const { worktrees, workers } = dependencies(resultRoot);
  const source = bead("gis-vst.22");
  const gate = { ...bead("gis-vst.human-22"), labels: ["human"] };
  const gates = [];
  const calls = [];
  await writeFile(join(resultRoot, "gis-vst.22.json"), JSON.stringify({
    status: "failed",
    summary: "waiting for a decision",
    needs_human: "approve the migration plan",
  }));

  try {
    const result = await runForegroundLoop({
      config: config({ concurrency: 1 }),
      beads: {
        async ready() {
          return gates.length === 0 ? [source] : [];
        },
        async dispatch(id, kind) {
          calls.push(["dispatch", id, kind]);
          return { ...source, status: "in_progress" };
        },
        async markBlocked(id, locations) {
          calls.push(["blocked", id, locations]);
          return { ...source, status: "blocked" };
        },
        async createHumanGate(request) {
          calls.push(["gate", request]);
          gates.push(gate);
          return gate;
        },
        async listHuman() {
          return gates;
        },
      },
      worktrees,
      workers,
      blocked: {
        async wait() {
          return { status: "done", wasBlocked: false, worktreeRetained: true };
        },
      },
      report: (message) => calls.push(["summary", message]),
    });

    assert.equal(result.merged, 0);
    assert.equal(result.blocked, 0);
    assert.equal(result.humanWaiting, 1);
    assert.equal(calls[0][0], "dispatch");
    assert.equal(calls[1][0], "blocked");
    assert.equal(calls[2][0], "gate");
    assert.equal(calls[2][1].issueId, source.id);
    assert.equal(calls[2][1].reason, "approve the migration plan");
    assert.match(calls.at(-1)[1], /1件が人間の確認待ち/);
  } finally {
    await rm(resultRoot, { recursive: true, force: true });
  }
});

test("allows a human response to release rewired dependents while the source stays blocked", async () => {
  const resultRoot = await mkdtemp(join(tmpdir(), "gis-run-human-release-"));
  const { worktrees, workers } = dependencies(resultRoot);
  const source = bead("gis-vst.24");
  const dependent = bead("gis-vst.25");
  const gate = { ...bead("gis-vst.human-24"), labels: ["human"] };
  let gateOpen = false;
  let firstRun = true;
  let dependentMerged = false;
  const dispatched = [];

  await Promise.all([
    writeFile(join(resultRoot, "gis-vst.24.json"), JSON.stringify({
      status: "failed",
      summary: "waiting for approval",
      needs_human: "approve the migration plan",
    })),
    writeFile(join(resultRoot, "gis-vst.25.json"), '{"status":"done","summary":"ok"}'),
  ]);

  const beads = {
    async ready() {
      if (firstRun) {
        firstRun = false;
        return [source];
      }
      return gateOpen || dependentMerged ? [] : [dependent];
    },
    async dispatch(id, kind) {
      dispatched.push({ id, kind });
      return { ...dependent, id, status: "in_progress" };
    },
    async markBlocked(id) {
      return { ...source, id, status: "blocked" };
    },
    async createHumanGate() {
      gateOpen = true;
      return gate;
    },
    async listHuman() {
      return gateOpen ? [gate] : [];
    },
  };

  try {
    const waiting = await runForegroundLoop({
      config: config({ concurrency: 1 }),
      beads,
      worktrees,
      workers,
      blocked: {
        async wait() {
          return { status: "done", wasBlocked: false, worktreeRetained: true };
        },
      },
      report: () => undefined,
    });

    assert.equal(waiting.merged, 0);
    assert.equal(waiting.blocked, 0);
    assert.equal(waiting.humanWaiting, 1);

    // This is the state change performed by `bd human respond`: the gate is
    // closed, while the source remains blocked with its handoff worktree.
    gateOpen = false;
    const resumed = await runForegroundLoop({
      config: config({ concurrency: 1 }),
      beads,
      worktrees,
      workers,
      blocked: {
        async wait() {
          return { status: "done", wasBlocked: false, worktreeRetained: true };
        },
      },
      verify: {
        async verify() {
          return { status: "verified", attempts: 1, result: { passed: true } };
        },
      },
      merge: {
        async enqueue({ bead: issue }) {
          dependentMerged = true;
          return { status: "merged", bead: { ...issue, status: "closed" } };
        },
      },
      report: () => undefined,
    });

    assert.equal(resumed.merged, 1);
    assert.equal(resumed.blocked, 0);
    assert.equal(resumed.humanWaiting, 0);
    assert.deepEqual(dispatched.map(({ id }) => id), [source.id, dependent.id]);
  } finally {
    await rm(resultRoot, { recursive: true, force: true });
  }
});

test("does not dispatch a human-labelled bead even if a source returns it", async () => {
  const calls = [];
  const gate = { ...bead("gis-vst.human-23"), labels: ["human"] };
  const result = await runForegroundLoop({
    config: config({ concurrency: 1 }),
    beads: {
      async ready() {
        return [gate];
      },
      async dispatch(id) {
        calls.push(id);
        throw new Error("human gate must not be dispatched");
      },
      async markBlocked() {
        throw new Error("human gate must not be blocked");
      },
      async createHumanGate() {
        throw new Error("human gate must not create another gate");
      },
      async listHuman() {
        return [gate];
      },
    },
  });

  assert.equal(result.humanWaiting, 1);
  assert.deepEqual(calls, []);
});

test("formats the required completion summary", () => {
  assert.equal(formatRunSummary({ merged: 2, blocked: 1, humanWaiting: 3 }),
    "2件マージ / 1件 blocked / 3件が人間の確認待ち");
});
