import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { main } from '../dist/cli.js';
import { initializeProject, serializeConfig } from '../dist/init.js';

const execFileAsync = promisify(execFile);

async function temporaryProject(name, callback) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts every default and creates a complete usable setup', async () => {
  await temporaryProject('gis-init-default', async (root) => {
    await Promise.all([
      writeFile(
        join(root, 'package.json'),
        JSON.stringify({ scripts: { check: 'node --test' } }),
        'utf8',
      ),
      writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8'),
      writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8'),
    ]);
    const commands = [];
    const reports = [];
    const result = await initializeProject({
      cwd: root,
      ask: async () => '',
      report: (message) => reports.push(message),
      async runCommand(command, args) {
        commands.push([command, ...args]);
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.equal(result.status, 'initialized');
    assert.equal(result.gitInitialized, true);
    assert.equal(result.beadsInitialized, true);
    assert.match(commands[0].join(' '), /^git rev-parse/);
    assert.deepEqual(commands[1], ['git', 'init', '-b', 'main']);
    assert.equal(commands[2][0], 'bd');
    assert.deepEqual(commands[2].slice(1, 4), [
      'init',
      '--non-interactive',
      '--prefix',
    ]);
    const config = await loadConfig(root);
    assert.equal(config.base, 'main');
    assert.equal(config.verify, 'pnpm check');
    assert.equal(config.concurrency, 1);
    assert.deepEqual(config.kinds, ['claude', 'codex']);
    assert.match(
      await readFile(join(root, '.gitignore'), 'utf8'),
      /node_modules\/\n\n# gis runtime artifacts\n\.gis\/run\/\n$/,
    );
    assert.match(reports.join('\n'), /次の手順/);
  });
});

test('retries invalid customized answers and preserves existing Git and Beads', async () => {
  await temporaryProject('gis-init-custom', async (root) => {
    await mkdir(join(root, '.beads'));
    const answers = ['release', 'cargo test --all', 'zero', '4', 'codex', ''];
    const questions = [];
    const commands = [];
    const reports = [];
    const result = await initializeProject({
      cwd: root,
      ask: async (question) => {
        questions.push(question);
        return answers.shift() ?? '';
      },
      report: (message) => reports.push(message),
      async runCommand(command, args) {
        commands.push([command, ...args]);
        if (args[0] === 'rev-parse') return { stdout: `${root}\n` };
        if (args[0] === 'branch') return { stdout: 'develop\n' };
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.equal(result.status, 'initialized');
    assert.equal(result.gitInitialized, false);
    assert.equal(result.beadsInitialized, false);
    assert.equal(commands.length, 2);
    assert.equal(
      questions.filter((question) => question.startsWith('並列タスク数'))
        .length,
      2,
    );
    assert.match(reports.join('\n'), /正の整数/);
    const config = await loadConfig(root);
    assert.equal(config.base, 'release');
    assert.equal(config.verify, 'cargo test --all');
    assert.equal(config.concurrency, 4);
    assert.deepEqual(config.kinds, ['codex']);
  });
});

test('does not overwrite existing configuration on the default answer', async () => {
  await temporaryProject('gis-init-existing', async (root) => {
    await mkdir(join(root, '.gis'));
    const original = 'base = "protected"\n';
    await writeFile(join(root, '.gis', 'config.toml'), original, 'utf8');
    const result = await initializeProject({
      cwd: root,
      ask: async () => '',
      report: () => undefined,
      async runCommand() {
        throw new Error('must not inspect or mutate after cancellation');
      },
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.equal(
      await readFile(join(root, '.gis', 'config.toml'), 'utf8'),
      original,
    );
  });
});

test('requires an interactive terminal unless --defaults behavior is requested', async () => {
  await temporaryProject('gis-init-noninteractive', async (root) => {
    await assert.rejects(
      initializeProject({ cwd: root, report: () => undefined }),
      /gis init --defaults/,
    );

    const commands = [];
    const result = await initializeProject({
      cwd: root,
      defaults: true,
      report: () => undefined,
      async runCommand(command, args) {
        commands.push([command, ...args]);
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });
    assert.equal(result.status, 'initialized');
    assert.deepEqual(commands[1], ['git', 'init', '-b', 'main']);
  });
});

test('serializes a config accepted by the config parser', async () => {
  await temporaryProject('gis-init-serialize', async (root) => {
    await mkdir(join(root, '.gis'));
    await writeFile(
      join(root, '.gis', 'config.toml'),
      serializeConfig({
        concurrency: 2,
        base: 'develop',
        verify: 'npm run check',
        kinds: ['codex'],
        review: false,
        verify_max: 3,
        review_max: 2,
        blocked_timeout: '10m',
        worker_timeout: '2h',
        verify_timeout: '20m',
        claude_permission_mode: 'auto',
        profiles: {
          plan: [{ kind: 'codex', model: 'plan', effort: 'high' }],
          implement: [{ kind: 'codex', model: 'impl', effort: 'xhigh' }],
          review: [{ kind: 'claude', model: 'review', effort: 'max' }],
        },
      }),
      'utf8',
    );
    const config = await loadConfig(root);
    assert.equal(config.base, 'develop');
    assert.equal(config.profiles.review[0].effort, 'max');
  });
});

test('rejects unsupported gis init arguments before changing the project', async () => {
  await assert.rejects(main(['init', '--force']), /gis init \[--defaults\]/);
});

test('falls back to the real git and bd executables when no runCommand is supplied', async () => {
  await temporaryProject('gis-init-default-run-command', async (root) => {
    await mkdir(join(root, '.beads'));
    const result = await initializeProject({
      cwd: root,
      defaults: true,
      report: () => undefined,
    });

    assert.equal(result.status, 'initialized');
    assert.equal(result.gitInitialized, true);
    assert.equal(result.beadsInitialized, false);
    assert.match(
      (
        await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
          cwd: root,
        })
      ).stdout.trim(),
      /gis-init-default-run-command/,
    );
  });
});

test('refuses to run outside a Git repository root when Git already exists', async () => {
  await temporaryProject('gis-init-nested-root', async (root) => {
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    await assert.rejects(
      initializeProject({
        cwd: nested,
        defaults: true,
        report: () => undefined,
      }),
      /gis init はGitリポジトリのルートで実行してください/,
    );
  });
});

test('falls back to the default verify command when package.json is malformed', async () => {
  await temporaryProject('gis-init-malformed-package-json', async (root) => {
    await writeFile(join(root, 'package.json'), '{ not valid json', 'utf8');
    const result = await initializeProject({
      cwd: root,
      defaults: true,
      report: () => undefined,
      async runCommand(command, args) {
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.equal(result.status, 'initialized');
    const config = await loadConfig(root);
    assert.equal(config.verify, 'npm test');
  });
});

test('retries after an unparseable yes/no answer and reports the guidance message', async () => {
  await temporaryProject('gis-init-invalid-yes-no', async (root) => {
    await mkdir(join(root, '.beads'));
    const answers = ['maybe', 'y', '', '', '', '', ''];
    const reports = [];
    const commands = [];
    const result = await initializeProject({
      cwd: root,
      ask: async () => answers.shift() ?? '',
      report: (message) => reports.push(message),
      async runCommand(command, args) {
        commands.push([command, ...args]);
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.equal(result.status, 'initialized');
    assert.equal(result.gitInitialized, true);
    assert.equal(result.beadsInitialized, false);
    assert.equal(
      reports.filter(
        (message) => message === 'gis: y または n で答えてください',
      ).length,
      1,
    );
  });
});

test('leaves an existing runtime-ignore entry in .gitignore untouched', async () => {
  await temporaryProject('gis-init-gitignore-exists', async (root) => {
    await mkdir(join(root, '.beads'));
    const original = 'node_modules/\n.gis/run/\n';
    await writeFile(join(root, '.gitignore'), original, 'utf8');
    const result = await initializeProject({
      cwd: root,
      defaults: true,
      report: () => undefined,
      async runCommand(command, args) {
        if (args[0] === 'rev-parse') return { stdout: `${root}\n` };
        if (args[0] === 'branch') return { stdout: 'main\n' };
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.equal(result.status, 'initialized');
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), original);
  });
});

test('refuses to overwrite an existing config in --defaults mode', async () => {
  await temporaryProject('gis-init-defaults-existing-config', async (root) => {
    await mkdir(join(root, '.gis'));
    await writeFile(
      join(root, '.gis', 'config.toml'),
      'base = "protected"\n',
      'utf8',
    );

    await assert.rejects(
      initializeProject({ cwd: root, defaults: true, report: () => undefined }),
      /対話モードで上書きを確認してください/,
    );
  });
});

test('asks about Git initialization before Beads initialization', async () => {
  await temporaryProject('gis-init-question-order', async (root) => {
    const questions = [];
    const result = await initializeProject({
      cwd: root,
      ask: async (question) => {
        questions.push(question);
        return '';
      },
      report: () => undefined,
      async runCommand(command, args) {
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.equal(result.status, 'initialized');
    assert.match(questions[0], /^Gitリポジトリを初期化しますか/);
    assert.match(questions[1], /^Beadsを初期化しますか/);
  });
});

test('overwrites an existing configuration when the user confirms', async () => {
  await temporaryProject('gis-init-overwrite-confirmed', async (root) => {
    await mkdir(join(root, '.gis'));
    await mkdir(join(root, '.beads'));
    await writeFile(
      join(root, '.gis', 'config.toml'),
      'base = "protected"\n',
      'utf8',
    );
    const answers = ['y', 'y', '', '', '', '', ''];
    const result = await initializeProject({
      cwd: root,
      ask: async () => answers.shift() ?? '',
      report: () => undefined,
      async runCommand(command, args) {
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.equal(result.status, 'initialized');
    const config = await loadConfig(root);
    assert.equal(config.base, 'main');
  });
});

test('cancels initialization when the final confirmation is declined', async () => {
  await temporaryProject('gis-init-final-cancel', async (root) => {
    await mkdir(join(root, '.beads'));
    const answers = ['y', '', '', '', '', 'n'];
    const reports = [];
    const commands = [];
    const result = await initializeProject({
      cwd: root,
      ask: async () => answers.shift() ?? '',
      report: (message) => reports.push(message),
      async runCommand(command, args) {
        commands.push([command, ...args]);
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.equal(commands.length, 1);
    assert.match(reports.join('\n'), /初期化をキャンセルしました/);
    await assert.rejects(access(join(root, '.gis', 'config.toml')));
  });
});

test('rejects a collected answer that serializeConfig cannot round-trip through the TOML parser', async () => {
  await temporaryProject('gis-init-self-check', async (root) => {
    await mkdir(join(root, '.beads'));
    // U+007F (DEL) survives JSON.stringify's escaping (quote() in serializeConfig)
    // unescaped, but @iarna/toml's parser rejects raw C0/DEL control characters.
    // applyDecisions's own `parseConfig(contents)` self-check is what catches this
    // before anything is written to disk; deleting that call lets a broken
    // .gis/config.toml be written silently instead of rejecting here.
    const answers = ['y', `release\x7f`, '', '', '', ''];
    const result = initializeProject({
      cwd: root,
      ask: async () => answers.shift() ?? '',
      report: () => undefined,
      async runCommand(command, args) {
        if (command === 'git' && args[0] === 'rev-parse') {
          throw new Error('not a repository');
        }
        return { stdout: '' };
      },
    });

    await assert.rejects(result, /Control characters/);
    await assert.rejects(access(join(root, '.gis', 'config.toml')));
  });
});

test('closes the readline interface it opens even when detectGit throws before any question', async () => {
  // Reaches the createInterface()/close() lifecycle in createRunContext
  // (src/init.ts:259-262) without ever calling terminal.question(), so it
  // cannot hang on real stdin: cwd is a non-root subdirectory of a real Git
  // repo, so detectGit's "run at the repository root" check throws before
  // the first askYesNo. The `finally { ctx.close() }` still runs.
  //
  // Verified (manually, against a mutated dist/init.js with the ctx.close()
  // call removed from `finally`) that this test's assertion still passes --
  // detectGit throws either way -- but the `node --test` process then never
  // exits: a readline Interface bound to a resumed process.stdin keeps the
  // event loop alive until .close() is called, so an un-closed interface
  // hangs the run instead of producing a clean assertion failure. That hang
  // is the kill signal for this mutation; there was no InitOptions seam
  // available to observe close() being invoked more directly without
  // changing the public API.
  await temporaryProject('gis-init-close-lifecycle', async (root) => {
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    const originalStdinTTY = process.stdin.isTTY;
    const originalStdoutTTY = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    try {
      await assert.rejects(
        initializeProject({ cwd: nested, report: () => undefined }),
        /gis init はGitリポジトリのルートで実行してください/,
      );
    } finally {
      process.stdin.isTTY = originalStdinTTY;
      process.stdout.isTTY = originalStdoutTTY;
    }
  });
});
