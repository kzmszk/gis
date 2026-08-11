import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BeadsAdapter,
  BeadsCommandError,
  BeadsProtocolError,
  formatBlockedNotes,
} from "../dist/beads.js";

const issue = (status = "open") => ({
  id: "gis-vst.3",
  title: "beads adapter",
  description: "typed bd wrapper",
  status,
  priority: 1,
  issue_type: "task",
});

async function withFakeBd(callback, { dependents = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gis-beads-"));
  const command = join(directory, "bd");
  const log = join(directory, "requests.log");
  const script = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
await appendFile(process.env.GIS_BEADS_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "dep" && args[1] === "list") {
  process.stdout.write(process.env.GIS_BEADS_DEPENDENTS + "\\n");
  process.exit(0);
}
const status = args[0] === "close"
  ? "closed"
  : args.includes("--status=blocked")
    ? "blocked"
    : args.includes("--status=in_progress") || args.includes("--claim")
      ? "in_progress"
      : "open";
const result = ${JSON.stringify(issue())};
result.status = status;
process.stdout.write(JSON.stringify(args[0] === "ready" ? [result] : [result]) + "\\n");
`;
  await writeFile(command, script, "utf8");
  await chmod(command, 0o755);

  try {
  return await callback(new BeadsAdapter({
      command,
      env: {
        ...process.env,
        GIS_BEADS_LOG: log,
        GIS_BEADS_DEPENDENTS: JSON.stringify(dependents),
      },
    }), log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function requestsFrom(log) {
  const contents = await readFile(log, "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("retrieves ready beads and shows a bead through bd JSON", async () => {
  await withFakeBd(async (bd, log) => {
    const ready = await bd.ready();
    const shown = await bd.show("gis-vst.3");
    const human = await bd.listHuman();

    assert.equal(ready[0].id, "gis-vst.3");
    assert.equal(shown.status, "open");
    assert.equal(human[0].id, "gis-vst.3");
    assert.deepEqual(await requestsFrom(log), [
      ["ready", "--exclude-label", "human", "--json"],
      ["show", "gis-vst.3", "--json"],
      ["list", "--label=human", "--status=open", "--json"],
    ]);
  });
});

test("lists in-progress beads and can reopen one", async () => {
  await withFakeBd(async (bd, log) => {
    const inProgress = await bd.listInProgress();
    const reopened = await bd.update("gis-vst.3", { status: "open" });

    assert.equal(inProgress[0].status, "in_progress");
    assert.equal(reopened.status, "open");
    assert.deepEqual(await requestsFrom(log), [
      ["list", "--status=in_progress", "--json"],
      ["update", "gis-vst.3", "--status=open", "--json"],
    ]);
  });
});

test("performs typed in_progress, blocked, and closed transitions", async () => {
  await withFakeBd(async (bd, log) => {
    const inProgress = await bd.update("gis-vst.3", {
      status: "in_progress",
      assignee: "codex",
    });
    const blocked = await bd.transition("gis-vst.3", {
      status: "blocked",
      notes: "worktree: /tmp/gis-vst.3; rounds: .gis/run; transcript: ~/.codex/sessions",
    });
    const closed = await bd.close("gis-vst.3", "verified");

    assert.equal(inProgress.status, "in_progress");
    assert.equal(blocked.status, "blocked");
    assert.equal(closed.status, "closed");
    assert.deepEqual(await requestsFrom(log), [
      ["update", "gis-vst.3", "--status=in_progress", "--assignee=codex", "--json"],
      ["update", "gis-vst.3", "--status=blocked", "--append-notes=worktree: /tmp/gis-vst.3; rounds: .gis/run; transcript: ~/.codex/sessions", "--json"],
      ["close", "gis-vst.3", "--reason=verified", "--json"],
    ]);
  });
});

test("supports bd's atomic claim operation", async () => {
  await withFakeBd(async (bd, log) => {
    const claimed = await bd.claim("gis-vst.3");

    assert.equal(claimed.status, "in_progress");
    assert.deepEqual(await requestsFrom(log), [
      ["update", "gis-vst.3", "--claim", "--json"],
    ]);
  });
});

test("writes dispatch, merge, and escalation states back to bd", async () => {
  await withFakeBd(async (bd, log) => {
    const dispatched = await bd.dispatch("gis-vst.11", "codex");
    const merged = await bd.markMerged("gis-vst.11", "merged after verify");
    const blocked = await bd.markBlocked("gis-vst.11", {
      worktreePath: "/repo/.worktrees/gis-vst.11",
      roundLogPath: "/repo/.worktrees/gis-vst.11/.gis/run",
      transcriptPath: "/home/kazu/.codex/sessions/2026/08/10/session.jsonl",
    });

    assert.equal(dispatched.status, "in_progress");
    assert.equal(merged.status, "closed");
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(await requestsFrom(log), [
      ["update", "gis-vst.11", "--status=in_progress", "--assignee=codex", "--json"],
      ["close", "gis-vst.11", "--reason=merged after verify", "--json"],
      [
        "update",
        "gis-vst.11",
        "--status=blocked",
        "--append-notes=worktree: /repo/.worktrees/gis-vst.11\nrounds: /repo/.worktrees/gis-vst.11/.gis/run\ntranscript: /home/kazu/.codex/sessions/2026/08/10/session.jsonl",
        "--json",
      ],
    ]);
  });
});

test("creates a human gate and replaces source blockers without a blocked-source edge", async () => {
  await withFakeBd(async (bd, log) => {
    const gate = await bd.createHumanGate({
      issueId: "gis-vst.20",
      reason: "credentials are required",
      locations: {
        worktreePath: "/repo/.worktrees/gis-vst.20",
        roundLogPath: "/repo/.worktrees/gis-vst.20/.gis/run",
        transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
      },
    });

    assert.equal(gate.id, "gis-vst.3");
    assert.deepEqual(await requestsFrom(log), [
      ["dep", "list", "gis-vst.20", "--direction=up", "--json"],
      [
        "create",
        "--title",
        "Human confirmation required for gis-vst.20",
        "--description",
        "Human confirmation is required for gis-vst.20.\n\nReason: credentials are required\n\nworktree: /repo/.worktrees/gis-vst.20\nrounds: /repo/.worktrees/gis-vst.20/.gis/run\ntranscript: /home/kazu/.codex/sessions/session.jsonl",
        "--labels",
        "human",
        "--json",
      ],
    ]);
  }, { dependents: [] });
});

test("rewires existing blocking dependents through the human gate", async () => {
  await withFakeBd(async (bd, log) => {
    await bd.createHumanGate({ issueId: "gis-vst.20", reason: "approval" });

    assert.deepEqual(await requestsFrom(log), [
      ["dep", "list", "gis-vst.20", "--direction=up", "--json"],
      [
        "create",
        "--title",
        "Human confirmation required for gis-vst.20",
        "--description",
        "Human confirmation is required for gis-vst.20.\n\nReason: approval",
        "--labels",
        "human",
        "--json",
      ],
      ["dep", "add", "gis-vst.24", "gis-vst.3", "--json"],
      ["dep", "remove", "gis-vst.24", "gis-vst.20", "--json"],
    ]);
  }, { dependents: [{ id: "gis-vst.24", dependency_type: "blocks" }] });
});

test("requires all three blocked-bead handoff locations", () => {
  assert.equal(
    formatBlockedNotes({
      worktreePath: "/repo/.worktrees/gis-vst.11",
      roundLogPath: "/repo/.worktrees/gis-vst.11/.gis/run",
      transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
    }),
    "worktree: /repo/.worktrees/gis-vst.11\nrounds: /repo/.worktrees/gis-vst.11/.gis/run\ntranscript: /home/kazu/.codex/sessions/session.jsonl",
  );

  assert.throws(
    () => formatBlockedNotes({
      worktreePath: "/repo/.worktrees/gis-vst.11",
      roundLogPath: "",
      transcriptPath: "/home/kazu/.codex/sessions/session.jsonl",
    }),
    /roundLogPath must not be empty/,
  );
});

test("surfaces command and JSON protocol failures", async () => {
  const missing = new BeadsAdapter({ command: "/definitely/missing/bd" });
  await assert.rejects(
    missing.ready(),
    (error) => error instanceof BeadsCommandError && error.args[0] === "ready",
  );

  const malformed = new BeadsAdapter({ command: "/bin/echo" });
  await assert.rejects(
    malformed.ready(),
    (error) => error instanceof BeadsProtocolError,
  );

  assert.throws(
    () => new BeadsAdapter({ timeoutMs: 0 }),
    /timeoutMs must be a positive finite number/,
  );
});
