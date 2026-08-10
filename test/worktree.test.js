import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBeadWorktree,
  removeBeadWorktree,
  withBeadWorktree,
} from "../dist/worktree.js";

async function withWorktreeRoots(callback) {
  const root = await mkdtemp(join(tmpdir(), "gis-worktree-"));
  const created = [];
  const removed = [];
  const herdr = {
    async worktreeCreate(options) {
      const path = join(root, options.branch);
      created.push(options);
      return {
        type: "worktree_created",
        workspace: { workspace_id: `workspace-${options.branch}`, label: options.branch },
        tab: { tab_id: `tab-${options.branch}`, workspace_id: `workspace-${options.branch}` },
        root_pane: {
          pane_id: `pane-${options.branch}`,
          workspace_id: `workspace-${options.branch}`,
          tab_id: `tab-${options.branch}`,
          agent_status: "idle",
        },
        worktree: { path, label: options.branch },
      };
    },
    async worktreeRemove(workspaceId, options) {
      removed.push({ workspaceId, options });
      return {
        type: "worktree_removed",
        workspace_id: workspaceId,
        path: root,
        forced: options.force,
      };
    },
  };

  try {
    return await callback({ root, herdr, created, removed });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("creates an independent worktree and its .gis/run directory for each bead", async () => {
  await withWorktreeRoots(async ({ root, herdr, created, removed }) => {
    const first = await createBeadWorktree({
      bead: { id: "gis-vst.5" },
      config: { base: "main" },
      cwd: root,
      herdr,
    });
    const second = await createBeadWorktree({
      bead: { id: "gis-vst.6" },
      config: { base: "main" },
      cwd: root,
      herdr,
    });

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.equal(first.runPath, join(root, "gis-vst.5", ".gis", "run"));
    assert.equal(second.runPath, join(root, "gis-vst.6", ".gis", "run"));
    await access(first.runPath);
    await access(second.runPath);
    assert.deepEqual(created, [
      { branch: "gis-vst.5", base: "main" },
      { branch: "gis-vst.6", base: "main" },
    ]);
    assert.deepEqual(removed, []);
  });
});
test("keeps the worktree and pane when the bead operation fails", async () => {
  await withWorktreeRoots(async ({ herdr, removed }) => {
    await assert.rejects(
      withBeadWorktree(
        { bead: { id: "gis-vst.5" }, config: { base: "main" }, herdr },
        async (worktree) => {
          await access(worktree.runPath);
          throw new Error("verify failed");
        },
      ),
      /verify failed/,
    );

    assert.deepEqual(removed, []);
  });
});

test("removes the worktree and pane only after successful completion", async () => {
  await withWorktreeRoots(async ({ herdr, removed }) => {
    const result = await withBeadWorktree(
      { bead: { id: "gis-vst.5" }, config: { base: "develop" }, herdr },
      async (worktree) => {
        await writeFile(join(worktree.runPath, "result.json"), "{}\n", "utf8");
        return worktree.beadId;
      },
    );

    assert.equal(result, "gis-vst.5");
    assert.deepEqual(removed, [{
      workspaceId: "workspace-gis-vst.5",
      options: { force: true },
    }]);
  });
});

test("removal is idempotent for an explicitly completed worktree", async () => {
  await withWorktreeRoots(async ({ herdr, removed }) => {
    const worktree = await createBeadWorktree({
      bead: { id: "gis-vst.5" },
      config: { base: "main" },
      herdr,
    });

    await removeBeadWorktree(worktree);
    await removeBeadWorktree(worktree);
    assert.equal(removed.length, 1);
  });
});
