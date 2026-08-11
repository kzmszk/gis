import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
} from '../dist/config.js';

const execFileAsync = promisify(execFile);

async function withConfig(contents, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'gis-config-'));
  await mkdir(join(directory, '.gis'));
  await writeFile(join(directory, '.gis', 'config.toml'), contents, 'utf8');
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('uses defaults for omitted settings', () => {
  const config = parseConfig('');

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config.kinds, DEFAULT_CONFIG.kinds);
  assert.notEqual(config.profiles, DEFAULT_CONFIG.profiles);
});

test('loads settings and preserves ordered profile candidates', () => {
  const config = parseConfig(`
concurrency = 2
base = "develop"
verify = "npm run check"
kinds = ["custom-agent"]
review = false
verify_max = 4
review_max = 2
blocked_timeout = "500ms"
worker_timeout = "2h"
verify_timeout = "30m"
claude_permission_mode = "acceptEdits"

[[profiles.implement]]
kind = "custom-agent"
model = "future-model-that-is-not-known-to-gis"
effort = "high"

[[profiles.implement]]
kind = "custom-agent"
model = "another-model"
effort = "max"
`);

  assert.equal(config.concurrency, 2);
  assert.equal(config.base, 'develop');
  assert.equal(config.verify, 'npm run check');
  assert.deepEqual(config.kinds, ['custom-agent']);
  assert.equal(config.verify_max, 4);
  assert.equal(config.review_max, 2);
  assert.equal(config.blocked_timeout, '500ms');
  assert.equal(config.worker_timeout, '2h');
  assert.equal(config.verify_timeout, '30m');
  assert.equal(config.claude_permission_mode, 'acceptEdits');
  assert.deepEqual(config.profiles.implement, [
    {
      kind: 'custom-agent',
      model: 'future-model-that-is-not-known-to-gis',
      effort: 'high',
    },
    { kind: 'custom-agent', model: 'another-model', effort: 'max' },
  ]);
  assert.deepEqual(config.profiles.plan, DEFAULT_CONFIG.profiles.plan);
});

test('rejects malformed TOML and invalid settings', () => {
  const invalidConfigs = [
    'concurrency = 0',
    'review = "true"',
    'blocked_timeout = "soon"',
    'worker_timeout = "soon"',
    'worker_timeout = "3000ms"',
    'verify_timeout = "soon"',
    'unknown_setting = true',
    '[[profiles.implement]]\nkind = "codex"\nmodel = 42\neffort = "high"',
    '[[profiles.implement]]\nkind = "codex"\nmodel = "gpt"\neffort = "fast"',
    'concurrency = [',
  ];

  for (const contents of invalidConfigs) {
    assert.throws(
      () => parseConfig(contents),
      (error) => error instanceof ConfigError,
    );
  }
});

test('loads review mode without the old not-implemented warning', async () => {
  await withConfig('review = true\n', async (directory) => {
    const config = await loadConfig(directory);
    assert.equal(config.review, true);
  });
});

test('fails the gis run startup when the config is invalid', async () => {
  await withConfig('concurrency = 0\n', async (directory) => {
    await assert.rejects(
      execFileAsync(process.execPath, [resolve('dist/cli.js'), 'run'], {
        cwd: directory,
      }),
      (error) =>
        error &&
        error.code === 1 &&
        error.stderr.includes('concurrency must be a positive integer'),
    );
  });
});
