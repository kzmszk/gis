import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  claudeProjectDirectory,
  claudeProjectSlug,
  listClaudeTranscripts,
  listCodexTranscripts,
  resolveAgentSessionTranscript,
  resolveBeadTranscriptIndex,
  resolveTranscriptIndex,
  resolveTranscriptPath,
} from "../dist/transcripts.js";

async function withTranscriptRoots(callback) {
  const home = await mkdtemp(join(tmpdir(), "gis-transcripts-"));
  try {
    return await callback(home, {
      homeDir: home,
      maxCodexMetadataLines: 4,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("maps an absolute worktree cwd to Claude's project slug", () => {
  const cwd = "/Users/kazu/work/gis/.worktrees/gis-vst.12";
  assert.equal(claudeProjectSlug(cwd), "-Users-kazu-work-gis-.worktrees-gis-vst.12");
  assert.equal(
    claudeProjectDirectory(cwd, { claudeProjectsDir: "/home/kazu/.claude/projects" }),
    "/home/kazu/.claude/projects/-Users-kazu-work-gis-.worktrees-gis-vst.12",
  );
});

test("resolves the newest Claude transcript and matching Codex session", async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = "/repo/.worktrees/gis-vst.12";
    const claudeDirectory = claudeProjectDirectory(cwd, options);
    const codexDirectory = join(home, ".codex", "sessions", "2026", "08", "10");
    await mkdir(claudeDirectory, { recursive: true });
    await mkdir(codexDirectory, { recursive: true });

    const claudeOld = join(claudeDirectory, "old.jsonl");
    const claudeNewest = join(claudeDirectory, "newest.jsonl");
    await writeFile(claudeOld, "{}\n", "utf8");
    await writeFile(claudeNewest, "{}\n", "utf8");
    await utimes(claudeOld, new Date(1000), new Date(1000));
    await utimes(claudeNewest, new Date(2000), new Date(2000));

    const codexOther = join(codexDirectory, "other.jsonl");
    const codexMatch = join(codexDirectory, "match.jsonl");
    await writeFile(codexOther, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/other" } }) + "\n", "utf8");
    await writeFile(codexMatch, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n", "utf8");

    assert.deepEqual(await listClaudeTranscripts(cwd, options), [claudeNewest, claudeOld]);
    assert.deepEqual(
      await listClaudeTranscripts(cwd, { ...options, modifiedAfterMs: 1500 }),
      [claudeNewest],
    );
    assert.deepEqual(await listCodexTranscripts(cwd, options), [codexMatch]);
    assert.equal(await resolveTranscriptPath("claude", cwd, options), claudeNewest);
    assert.equal(await resolveTranscriptPath(cwd, "codex", options), codexMatch);

    assert.deepEqual(await resolveTranscriptIndex(cwd, options), {
      cwd: resolve(cwd),
      claude: claudeNewest,
      codex: codexMatch,
    });
  });
});

test("resolves the exact Claude session ID instead of the newest transcript", async () => {
  await withTranscriptRoots(async (_home, options) => {
    const cwd = "/repo/.worktrees/gis-vst.12";
    const directory = claudeProjectDirectory(cwd, options);
    await mkdir(directory, { recursive: true });
    const selected = join(directory, "session-selected.jsonl");
    const newer = join(directory, "session-newer.jsonl");
    await writeFile(selected, "{}\n", "utf8");
    await writeFile(newer, "{}\n", "utf8");
    await utimes(selected, new Date(1000), new Date(1000));
    await utimes(newer, new Date(2000), new Date(2000));

    assert.equal(await resolveAgentSessionTranscript({
      source: "claude-projects",
      agent: "claude",
      kind: "id",
      value: "session-selected",
    }, cwd, options), selected);
  });
});

test("resolves the exact Codex session ID and validates its cwd", async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = "/repo/.worktrees/gis-vst.12";
    const directory = join(home, ".codex", "sessions", "2026", "08", "10");
    await mkdir(directory, { recursive: true });
    const selected = join(directory, "rollout-2026-08-10-session-selected.jsonl");
    const sameCwd = join(directory, "rollout-2026-08-10-session-newer.jsonl");
    const wrongCwd = join(directory, "rollout-2026-08-10-session-wrong-cwd.jsonl");
    await writeFile(selected, JSON.stringify({
      type: "session_meta",
      payload: { id: "session-selected", cwd },
    }) + "\n", "utf8");
    await writeFile(sameCwd, JSON.stringify({
      type: "session_meta",
      payload: { id: "session-newer", cwd },
    }) + "\n", "utf8");
    await writeFile(wrongCwd, JSON.stringify({
      type: "session_meta",
      payload: { id: "session-wrong-cwd", cwd: "/repo/other" },
    }) + "\n", "utf8");

    assert.equal(await resolveAgentSessionTranscript({
      source: "codex-sessions",
      agent: "codex",
      kind: "id",
      value: "session-selected",
    }, cwd, options), selected);
    assert.equal(await resolveAgentSessionTranscript({
      source: "codex-sessions",
      agent: "codex",
      kind: "id",
      value: "session-wrong-cwd",
    }, cwd, options), undefined);
  });
});

test("uses a path session reference directly", async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = "/repo/.worktrees/gis-vst.12";
    const transcript = join(home, "custom", "session.jsonl");
    await mkdir(join(home, "custom"), { recursive: true });
    await writeFile(transcript, "{}\n", "utf8");

    assert.equal(await resolveAgentSessionTranscript({
      source: "pi",
      agent: "pi",
      kind: "path",
      value: transcript,
    }, cwd, options), transcript);
  });
});

test("associates a bead and worktree with a runner transcript without copying logs", async () => {
  await withTranscriptRoots(async (home, options) => {
    const cwd = "/repo/.worktrees/gis-vst.12";
    const sessions = join(home, ".codex", "sessions", "2026");
    const transcript = join(sessions, "rollout.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(transcript, JSON.stringify({
      type: "session_meta",
      payload: { cwd },
    }) + "\n", "utf8");

    assert.deepEqual(await resolveBeadTranscriptIndex("gis-vst.12", cwd, "codex", options), {
      beadId: "gis-vst.12",
      worktreePath: resolve(cwd),
      kind: "codex",
      transcriptPath: transcript,
    });
  });
});

test("returns no index when the official transcript roots have no matching file", async () => {
  await withTranscriptRoots(async (_home, options) => {
    assert.deepEqual(await resolveTranscriptIndex("/repo/.worktrees/missing", options), {
      cwd: "/repo/.worktrees/missing",
      claude: undefined,
      codex: undefined,
    });
    assert.equal(
      await resolveBeadTranscriptIndex("gis-vst.12", "/repo/.worktrees/missing", "claude", options),
      undefined,
    );
  });
});
