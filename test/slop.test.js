import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSlop, measureSlop } from '../dist/slop.js';

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
