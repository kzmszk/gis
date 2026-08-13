import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const guard = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'beads-sync-guard.sh',
);

async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), 'gis-sync-guard-'));
  try {
    await mkdir(join(root, '.beads'), { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The guard is invoked from git hooks, which run from wherever the user is, so
// it resolves its own root rather than trusting the working directory.
function invoke(root, args) {
  return run('sh', [guard, ...args], {
    env: { ...process.env, BEADS_SYNC_GUARD_ROOT: root },
  });
}

async function readState(root) {
  return JSON.parse(
    await readFile(join(root, '.beads', 'push-state.json'), 'utf8'),
  );
}

test('failure count accumulates and a success clears it', async () => {
  await withRoot(async (root) => {
    assert.equal((await invoke(root, ['failure', 'boom'])).stdout.trim(), '1');
    assert.equal((await invoke(root, ['failure', 'boom'])).stdout.trim(), '2');
    assert.equal((await readState(root)).consecutive_failures, 2);

    await invoke(root, ['success']);
    const state = await readState(root);
    assert.equal(state.consecutive_failures, 0);
    assert.equal(state.last_outcome, 'success');
    assert.equal((await invoke(root, ['failure', 'boom'])).stdout.trim(), '1');
  });
});

test('push output stays valid JSON however it is shaped', async () => {
  await withRoot(async (root) => {
    const hostile = `hint: "quoted" and \\backslashed\nsecond line\ttabbed${'x'.repeat(2000)}`;
    await invoke(root, ['failure', hostile]);

    // Parsing is the assertion: an unescaped quote or newline would throw here,
    // and a corrupt state file is exactly what would silence the guard.
    const state = await readState(root);
    assert.equal(state.consecutive_failures, 1);
    assert.ok(!state.last_error.includes('\n'));
    assert.ok(state.last_error.length <= 600);
    assert.ok(state.last_error.startsWith('hint:'));
  });
});

test('check is silent when synced and loud when not', async () => {
  await withRoot(async (root) => {
    assert.equal((await invoke(root, ['check'])).stdout, '');

    await invoke(root, ['success']);
    assert.equal((await invoke(root, ['check'])).stdout, '');

    await invoke(root, ['failure', 'non-fast-forward']);
    const { stdout } = await invoke(root, ['check']);
    assert.match(stdout, /has not reached the remote/);
    assert.match(stdout, /failed 1 time\(s\)/);
    assert.match(stdout, /non-fast-forward/);
    assert.match(stdout, /bd dolt pull/);
  });
});

test('a corrupt state file reports zero rather than blocking a push', async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, '.beads', 'push-state.json'),
      'not json at all',
      'utf8',
    );
    assert.equal((await invoke(root, ['count'])).stdout.trim(), '0');
    assert.equal((await invoke(root, ['check'])).stdout, '');
    assert.equal((await invoke(root, ['failure', 'boom'])).stdout.trim(), '1');
  });
});

test('an unknown subcommand fails instead of silently doing nothing', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      () => invoke(root, ['synchronise']),
      (error) => error.code === 2,
    );
  });
});
