# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files
- **Never pass `--parent` to `bd create`.** It allocates a sequential `parent.N` id from a
  local counter, so two sites that are out of sync hand out the same id and the next
  `bd dolt pull` stops on a merge conflict. Create the issue on its own, then attach it:
  `ID=$(bd create --title=... --silent)` followed by `bd update $ID --parent=<epic>`.
  The id is no longer hierarchical, but the issue still shows under CHILDREN and in
  `bd ready` with its parent. A PreToolUse hook in `.claude/settings.json` enforces this
  for Claude Code; other agents have to follow it by reading this. See gis-y2h.
- **Always run `bd dolt push` with `DOLT_REMOTE_INFO_BRANCH=` set to empty.** Otherwise dolt
  also force-pushes a marker branch to `refs/heads/__dolt_remote_info__`, which GitHub counts
  as a real branch and turns into a "had recent pushes" banner on every visit. The empty value
  disables that push; the issue data at `refs/dolt/data` is unaffected. `.husky/pre-push`
  already exports it — set it in your shell profile (and in any cloud routine or second
  machine) so manual pushes match. See gis-v3t.
- **Check the exit code every time you run `bd dolt push` yourself.** It does not overwrite
  the remote: like git, it rejects a non-fast-forward and leaves your changes stranded
  locally. A cloud session already lost three issues this way — the push was refused, nobody
  read the message, and the environment was gone before anyone noticed. On failure run
  `bd dolt pull`, then push again. If the pull reports a merge conflict, **stop and report
  it**; do not work around it. The pre-push hook counts consecutive failures in
  `.beads/push-state.json` and blocks the git push once they reach `BEADS_PUSH_FAIL_LIMIT`
  (default 3), and `scripts/beads-sync-guard.sh check` replays that state at session start —
  but neither sees a `bd dolt push` you invoke directly, so check it yourself. See gis-apr.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.

<!-- END BEADS INTEGRATION -->

## Build & Test

```bash
corepack enable
pnpm install
pnpm check
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
