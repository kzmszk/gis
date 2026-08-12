import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { compareSlop, measureSlop, measureWorktreeSlop } from '../dist/slop.js';

const execFileAsync = promisify(execFile);

async function withGitRepo(callback) {
  const root = await mkdtemp(join(tmpdir(), 'gis-slop-'));
  try {
    await execFileAsync('git', ['init', '--initial-branch=main'], {
      cwd: root,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: root,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('counts repeated source blocks as verbosity', () => {
  const score = measureSlop(
    new Map([
      ['one.ts', 'const one = 1;\nconst two = 2;\nreturn one + two;'],
      ['two.ts', 'const one = 1;\nconst two = 2;\nreturn one + two;'],
    ]),
  );
  assert.equal(score.loc, 6);
  assert.equal(score.duplicateLines, 6);
  assert.equal(score.verbosity, 1);
});

test('does not strip URL content from string literals while matching duplicates', () => {
  const score = measureSlop(
    new Map([
      [
        'first.ts',
        "const url = 'https://example.com/x';\nconst v = 1;\nconst w = 2;",
      ],
      [
        'second.ts',
        "const url = 'https://other.example/y';\nconst v = 1;\nconst w = 2;",
      ],
    ]),
  );
  assert.equal(score.duplicateLines, 0);
});

test('ignores trailing comments without treating string content as comments', () => {
  const score = measureSlop(
    new Map([
      ['first.ts', 'foo(1); // step one\nbar(2);\nbaz(3);'],
      ['second.ts', 'foo(1); // step 1\nbar(2);\nbaz(3);'],
    ]),
  );
  assert.equal(score.duplicateLines, 6);
});

test('concentrates erosion in functions above complexity ten', () => {
  const conditions = Array.from(
    { length: 10 },
    (_, index) => `if (value === ${index}) return ${index};`,
  ).join('\n');
  const score = measureSlop(
    new Map([
      [
        'complex.ts',
        `function choose(value: number) {\n${conditions}\nreturn -1;\n}`,
      ],
    ]),
  );
  assert.equal(score.functions, 1);
  assert.ok(score.totalMass > 0);
  assert.equal(score.erosion, 1);
});

test('excludes nested function lines from the enclosing function mass', () => {
  const outerOnly = measureSlop(
    new Map([
      ['outer.ts', 'function outer() {\n  if (a) return 1;\n  return 0;\n}'],
    ]),
  );
  const nested = measureSlop(
    new Map([
      [
        'nested.ts',
        'function outer() {\n  if (a) return 1;\n  function inner() {\n    if (b) return 2;\n    return 3;\n  }\n  return inner();\n}',
      ],
    ]),
  );
  assert.equal(nested.functions, 2);
  assert.ok(nested.totalMass < outerOnly.totalMass + 2 * Math.sqrt(7));
});

test('reports signed quality deltas from baseline to current', () => {
  const base = measureSlop(
    new Map([['base.ts', 'function simple() { return 1; }']]),
  );
  const current = measureSlop(
    new Map([
      ['current.ts', 'function simple() { if (true) return 1; return 0; }'],
    ]),
  );
  const comparison = compareSlop(base, current);
  assert.equal(comparison.base, base);
  assert.equal(comparison.current, current);
  assert.ok(comparison.verbosityDelta >= 0);
  assert.equal(comparison.erosionDelta, 0);
});

test('includes files removed from the worktree in the base measurement', async () => {
  await withGitRepo(async (root) => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'removed.ts'),
      'const x = 1;\nconst y = 2;\nconst z = 3;\n',
    );
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    await rm(join(root, 'src', 'removed.ts'));

    const comparison = await measureWorktreeSlop(root, 'main');
    assert.equal(comparison.base.loc, 3);
    assert.equal(comparison.current.loc, 0);
  });
});

test('measures only tracked current files and retains Unicode base paths', async () => {
  await withGitRepo(async (root) => {
    await mkdir(join(root, 'src', 'node_modules', 'package'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'src', '日本語.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    );
    await writeFile(join(root, '.gitignore'), 'node_modules/\n*.gen.ts\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    await writeFile(
      join(root, 'src', 'node_modules', 'package', 'index.ts'),
      'const ignored = 1;\nconst x = 2;\nconst y = 3;\n',
    );
    await writeFile(
      join(root, 'src', 'generated.gen.ts'),
      'const generated = 1;\nconst x = 2;\nconst y = 3;\n',
    );

    const comparison = await measureWorktreeSlop(root, 'main');
    assert.equal(comparison.base.loc, 3);
    assert.equal(comparison.current.loc, 3);
  });
});

test('explains when the worktree has no src directory', async () => {
  await withGitRepo(async (root) => {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'base'], {
      cwd: root,
    });
    await assert.rejects(
      measureWorktreeSlop(root, 'main'),
      /gis slop requires a src directory/,
    );
  });
});
