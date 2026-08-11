import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseWorkerResult, readWorkerResult } from '../dist/result.js';

test('classifies successful and failed worker results', () => {
  assert.deepEqual(
    parseWorkerResult('{"status":"done","summary":"implemented"}'),
    {
      kind: 'success',
      result: { status: 'done', summary: 'implemented' },
    },
  );
  assert.deepEqual(
    parseWorkerResult('{"status":"failed","summary":"tests failed"}'),
    {
      kind: 'failure',
      result: { status: 'failed', summary: 'tests failed' },
    },
  );
});
test('classifies needs_human separately from worker success or failure', () => {
  const state = parseWorkerResult(
    '{"status":"failed","summary":"blocked on credentials","needs_human":"provide credentials"}',
  );

  assert.deepEqual(state, {
    kind: 'needs_human',
    result: {
      status: 'failed',
      summary: 'blocked on credentials',
      needs_human: 'provide credentials',
    },
    reason: 'provide credentials',
  });
});

test('distinguishes a missing result file from malformed JSON and invalid schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-result-'));
  const missingPath = join(root, 'missing.json');
  const malformedPath = join(root, 'malformed.json');
  const schemaPath = join(root, 'schema.json');

  try {
    assert.deepEqual(await readWorkerResult(missingPath), {
      kind: 'missing',
      path: missingPath,
    });

    await writeFile(malformedPath, '{"status":"done",', 'utf8');
    const malformed = await readWorkerResult(malformedPath);
    assert.equal(malformed.kind, 'invalid_json');
    assert.equal(malformed.path, malformedPath);
    assert.equal(typeof malformed.message, 'string');

    await writeFile(schemaPath, '{"status":"unknown","summary":42}', 'utf8');
    assert.deepEqual(await readWorkerResult(schemaPath), {
      kind: 'invalid_schema',
      path: schemaPath,
      issues: [
        'status must be "done" or "failed"',
        'summary must be a non-empty string',
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires a non-empty summary and human reason', () => {
  assert.deepEqual(
    parseWorkerResult('{"status":"done"}', '.gis/run/round-1-impl.json'),
    {
      kind: 'invalid_schema',
      path: '.gis/run/round-1-impl.json',
      issues: ['summary must be a non-empty string'],
    },
  );
  assert.deepEqual(
    parseWorkerResult(
      '{"status":"done","summary":"finished","needs_human":true}',
      '.gis/run/round-1-impl.json',
    ),
    {
      kind: 'invalid_schema',
      path: '.gis/run/round-1-impl.json',
      issues: ['needs_human must be a non-empty string when present'],
    },
  );
});

test('parseWorkerResult preserves valid extra fields for later protocol extensions', () => {
  const state = parseWorkerResult(
    '{"status":"done","summary":"finished","verdict":"pass"}',
  );

  assert.equal(state.kind, 'success');
  assert.equal(state.result.verdict, 'pass');
});

test('rejects a result from another worker run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gis-result-stale-'));
  const path = join(root, 'result.json');
  try {
    await writeFile(
      path,
      '{"run_id":"old-run","status":"done","summary":"old"}',
      'utf8',
    );
    assert.deepEqual(await readWorkerResult(path, 'current-run'), {
      kind: 'stale',
      path,
      expectedRunId: 'current-run',
      actualRunId: 'old-run',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
