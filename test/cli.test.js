import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

test("importing the CLI module does not execute gis run", async () => {
  const moduleUrl = pathToFileURL(resolve("dist/cli.js")).href;
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)})`,
  ]);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

const bead = {
  id: "gis-vst.cli",
  title: "CLI integration",
  description: "exercise the default adapters",
  acceptance_criteria: "run the full CLI path",
  status: "open",
  priority: 1,
  issue_type: "task",
};

async function writeFakeCommands(root, statePath, bdLogPath, gitLogPath) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "bd"), `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
await appendFile(process.env.GIS_BD_LOG, JSON.stringify(args) + "\\n");
const state = JSON.parse(await readFile(process.env.GIS_BD_STATE, "utf8"));
const outputBead = () => ({ ...${JSON.stringify(bead)}, status: state.status });

if (args[0] === "ready") {
  process.stdout.write(JSON.stringify(state.status === "open" ? [outputBead()] : []) + "\\n");
} else if (args[0] === "list" && args.includes("--status=in_progress")) {
  process.stdout.write(JSON.stringify(state.status === "in_progress" ? [outputBead()] : []) + "\\n");
} else if (args[0] === "list" && args.includes("--label=human")) {
  process.stdout.write("[]\\n");
} else if (args[0] === "update" && args.includes("--status=in_progress")) {
  state.status = "in_progress";
  await writeFile(process.env.GIS_BD_STATE, JSON.stringify(state), "utf8");
  process.stdout.write(JSON.stringify([outputBead()]) + "\\n");
} else if (args[0] === "close") {
  state.status = "closed";
  await writeFile(process.env.GIS_BD_STATE, JSON.stringify(state), "utf8");
  process.stdout.write(JSON.stringify([outputBead()]) + "\\n");
} else {
  process.stdout.write("[]\\n");
}
`, "utf8");
  await writeFile(join(bin, "git"), `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.GIS_GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "worktree" && args[1] === "list") {
  process.stdout.write("worktree " + process.env.GIS_BASE_PATH + "\\nHEAD base\\nbranch refs/heads/main\\n");
} else if (args.includes("rev-list")) {
  process.stdout.write("1\\n");
}
`, "utf8");
  await chmod(join(bin, "bd"), 0o755);
  await chmod(join(bin, "git"), 0o755);
  return bin;
}

function snapshot() {
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
}

test("gis run connects default bd, herdr, and git adapters through merge cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "gis-cli-integration-"));
  const statePath = join(root, "state.json");
  const bdLogPath = join(root, "bd.log");
  const gitLogPath = join(root, "git.log");
  const socketPath = join(root, "herdr.sock");
  const worktreePath = join(root, "worktrees", bead.id);
  const baseCwd = await realpath(root);
  const herdrEvents = [];
  await mkdir(join(root, ".gis"), { recursive: true });
  await writeFile(statePath, JSON.stringify({ status: "open" }), "utf8");
  await writeFile(join(root, ".gis", "config.toml"), [
    "concurrency = 1",
    "base = \"main\"",
    "verify = \"true\"",
    "kinds = [\"codex\"]",
    "blocked_timeout = \"1s\"",
  ].join("\n") + "\n", "utf8");
  const bin = await writeFakeCommands(root, statePath, bdLogPath, gitLogPath);

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      const request = JSON.parse(buffer.slice(0, newline));
      herdrEvents.push(request.method);
      let result;
      if (request.method === "session.snapshot") {
        result = snapshot();
      } else if (request.method === "worktree.create") {
        await mkdir(join(root, "worktrees", bead.id, ".gis", "run"), { recursive: true });
        result = {
          type: "worktree_created",
          workspace: { workspace_id: `ws-${bead.id}`, label: bead.id },
          tab: { tab_id: `tab-${bead.id}`, workspace_id: `ws-${bead.id}` },
          root_pane: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: "idle",
          },
          worktree: { path: worktreePath, label: bead.id },
        };
      } else if (request.method === "agent.start") {
        result = {
          type: "agent_started",
          agent: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: "working",
          },
          argv: request.params.args ?? [],
        };
      } else if (request.method === "agent.prompt") {
        await Promise.all([
          writeFile(
            join(worktreePath, ".gis", "run", "round-1-impl.json"),
            '{"status":"done","summary":"CLI worker completed"}',
            "utf8",
          ),
          writeFile(join(worktreePath, ".gis", "run", "worker.jsonl"), "{}\n", "utf8"),
        ]);
        result = {
          type: "agent_prompted",
          agent: {
            pane_id: `pane-${bead.id}`,
            workspace_id: `ws-${bead.id}`,
            tab_id: `tab-${bead.id}`,
            agent_status: "working",
            agent_session: {
              source: "integration-test",
              agent: "codex",
              kind: "path",
              value: join(worktreePath, ".gis", "run", "worker.jsonl"),
            },
          },
        };
      } else if (request.method === "agent.wait") {
        result = {
          type: "wait_matched",
          event: { event: "agent.done", data: { type: "agent.done", agent_status: "done" } },
        };
      } else if (request.method === "worktree.remove") {
        result = {
          type: "worktree_removed",
          workspace_id: `ws-${bead.id}`,
          path: worktreePath,
          forced: true,
        };
      } else {
        throw new Error(`unexpected herdr method ${request.method}`);
      }

      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });

  try {
    const result = await execFileAsync(process.execPath, [resolve("dist/cli.js"), "run"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HERDR_SOCKET_PATH: socketPath,
        GIS_BD_STATE: statePath,
        GIS_BD_LOG: bdLogPath,
        GIS_GIT_LOG: gitLogPath,
        GIS_BASE_PATH: root,
      },
    });

    assert.match(result.stdout, /1件マージ \/ 0件 blocked \/ 0件が人間の確認待ち/);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status, "closed");
    assert.deepEqual(herdrEvents, [
      "session.snapshot",
      "worktree.create",
      "agent.start",
      "agent.prompt",
      "agent.wait",
      "worktree.remove",
    ]);
    assert.deepEqual(
      (await readFile(gitLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
      [
        ["worktree", "list", "--porcelain"],
        ["-C", worktreePath, "rebase", "main"],
        ["-C", worktreePath, "rev-list", "--count", "main..HEAD"],
        ["-C", baseCwd, "merge", "--ff-only", bead.id],
        ["-C", baseCwd, "branch", "-d", bead.id],
      ],
    );
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
