import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const enabled = process.env.GIS_AGY_E2E === '1';

test(
  'starts agy and returns its current directory from a real model prompt',
  { skip: enabled ? false : 'set GIS_AGY_E2E=1 to call the real agy model' },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'gis-agy-e2e-'));
    try {
      const model = process.env.GIS_AGY_E2E_MODEL ?? 'gemini-3.7-flash-high';
      const { stdout, stderr } = await execFileAsync(
        'agy',
        [
          '--output-format',
          'json',
          '--print-timeout',
          '2m',
          '--model',
          model,
          '--effort',
          'high',
          '--mode',
          'accept-edits',
          '--sandbox',
          '--dangerously-skip-permissions',
          '--new-project',
          '--add-dir',
          '.',
          '--print=カレントディレクトリを教えて',
        ],
        { cwd, timeout: 150_000, maxBuffer: 1024 * 1024 },
      );

      const result = JSON.parse(stdout);
      assert.equal(result.status, 'SUCCESS', result.error ?? stderr);
      assert.equal(typeof result.conversation_id, 'string');
      assert.ok(result.conversation_id.length > 0);
      assert.equal(typeof result.response, 'string');
      assert.ok(
        result.response.includes(cwd),
        `agy response did not contain cwd ${cwd}: ${result.response}`,
      );
      t.diagnostic(`agy response: ${result.response.trim()}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
