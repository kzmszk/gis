import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { main } from '../dist/cli.js';
import { initializeProject, serializeConfig } from '../dist/init.js';

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
