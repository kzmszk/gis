import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const HIGH_COMPLEXITY = 10;
const DUPLICATE_WINDOW_LINES = 3;

export interface SlopScore {
  readonly loc: number;
  readonly duplicateLines: number;
  /** Duplicate source lines divided by source lines. Lower is better. */
  readonly verbosity: number;
  readonly functions: number;
  readonly totalMass: number;
  readonly highComplexityMass: number;
  /** High-complexity mass divided by total complexity mass. Lower is better. */
  readonly erosion: number;
}

export interface SlopComparison {
  readonly base: SlopScore;
  readonly current: SlopScore;
  readonly verbosityDelta: number;
  readonly erosionDelta: number;
}

export const SLOP_REPORT_PREFIX = 'GIS_SLOP_REPORT=';

function commentFreeLines(source: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  let result = '';
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    const text = scanner.getTokenText();
    result +=
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
        ? text.replace(/[^\r\n]/g, ' ')
        : text;
  }
  return result.split(/\r?\n/);
}

function sourceLines(source: string): string[] {
  return commentFreeLines(source).filter((line) => line.trim().length > 0);
}

function duplicateLineCount(sources: ReadonlyMap<string, string>): number {
  const windows = new Map<string, number[][]>();
  let offset = 0;
  for (const source of sources.values()) {
    const lines = sourceLines(source).map((line) =>
      line.replace(/\s+/g, ' ').trim(),
    );
    for (
      let start = 0;
      start + DUPLICATE_WINDOW_LINES <= lines.length;
      start += 1
    ) {
      const key = lines.slice(start, start + DUPLICATE_WINDOW_LINES).join('\n');
      if (key.length === 0) continue;
      const matches = windows.get(key) ?? [];
      matches.push(
        Array.from(
          { length: DUPLICATE_WINDOW_LINES },
          (_, index) => offset + start + index,
        ),
      );
      windows.set(key, matches);
    }
    offset += lines.length;
  }
  const duplicated = new Set<number>();
  for (const matches of windows.values()) {
    if (matches.length < 2) continue;
    for (const match of matches) for (const line of match) duplicated.add(line);
  }
  return duplicated.size;
}

function sourceLineNumbers(source: string): Set<number> {
  const result = new Set<number>();
  for (const [index, line] of commentFreeLines(source).entries()) {
    if (line.trim().length > 0) result.add(index);
  }
  return result;
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function cyclomaticComplexity(
  functionNode: ts.FunctionLikeDeclaration,
): number {
  let complexity = 1;
  const visit = (node: ts.Node): void => {
    if (node !== functionNode && isFunction(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node)
    ) {
      complexity += 1;
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      complexity += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode, visit);
  return complexity;
}

/** Count a function's own SLOC, excluding nested function declarations. */
function ownFunctionSloc(
  file: ts.SourceFile,
  functionNode: ts.FunctionLikeDeclaration,
  sourceLines: ReadonlySet<number>,
): number {
  const body = functionNode.body;
  if (body === undefined) return 0;
  const start = file.getLineAndCharacterOfPosition(body.getStart(file)).line;
  const end = file.getLineAndCharacterOfPosition(body.end).line;
  const ownLines = new Set<number>();
  for (let line = start; line <= end; line += 1) {
    if (sourceLines.has(line)) ownLines.add(line);
  }
  const removeNested = (node: ts.Node): void => {
    if (node !== functionNode && isFunction(node)) {
      const nestedStart = file.getLineAndCharacterOfPosition(
        node.getStart(file),
      ).line;
      const nestedEnd = file.getLineAndCharacterOfPosition(node.end).line;
      for (let line = nestedStart; line <= nestedEnd; line += 1)
        ownLines.delete(line);
      return;
    }
    ts.forEachChild(node, removeNested);
  };
  ts.forEachChild(body, removeNested);
  return Math.max(1, ownLines.size);
}

/** Measure SCBench-inspired duplication and complexity concentration for TypeScript sources. */
export function measureSlop(sources: ReadonlyMap<string, string>): SlopScore {
  let loc = 0;
  let functions = 0;
  let totalMass = 0;
  let highComplexityMass = 0;
  for (const [path, source] of sources) {
    loc += sourceLines(source).length;
    const lines = sourceLineNumbers(source);
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (isFunction(node) && node.body !== undefined) {
        functions += 1;
        const complexity = cyclomaticComplexity(node);
        const mass = complexity * Math.sqrt(ownFunctionSloc(file, node, lines));
        totalMass += mass;
        if (complexity > HIGH_COMPLEXITY) highComplexityMass += mass;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const duplicateLines = duplicateLineCount(sources);
  return {
    loc,
    duplicateLines,
    verbosity: loc === 0 ? 0 : duplicateLines / loc,
    functions,
    totalMass,
    highComplexityMass,
    erosion: totalMass === 0 ? 0 : highComplexityMass / totalMass,
  };
}

export function compareSlop(
  base: SlopScore,
  current: SlopScore,
): SlopComparison {
  return {
    base,
    current,
    verbosityDelta: current.verbosity - base.verbosity,
    erosionDelta: current.erosion - base.erosion,
  };
}

export function serializeSlopReport(comparison: SlopComparison): string {
  return `${SLOP_REPORT_PREFIX}${JSON.stringify(comparison)}`;
}

function typeScriptPaths(output: string): string[] {
  return output
    .split('\0')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
}

async function baseTypeScriptPaths(
  cwd: string,
  ref: string,
): Promise<string[]> {
  return typeScriptPaths(
    await git(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'src']),
  );
}

async function currentTypeScriptPaths(cwd: string): Promise<string[]> {
  return typeScriptPaths(
    await git(cwd, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src',
    ]),
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout;
}

async function sourceAtRef(
  cwd: string,
  ref: string,
  path: string,
): Promise<string> {
  return git(cwd, ['show', `${ref}:${path}`]);
}

/** Compare the current src tree with its merge-base against a Git ref. */
export async function measureWorktreeSlop(
  cwd: string,
  baseRef: string,
): Promise<SlopComparison> {
  const baseRefResolved = (
    await git(cwd, ['merge-base', baseRef, 'HEAD'])
  ).trim();
  const sourceRoot = join(cwd, 'src');
  try {
    if (!(await stat(sourceRoot)).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error(`gis slop requires a src directory: ${sourceRoot}`);
  }
  const current = new Map<string, string>();
  const base = new Map<string, string>();
  for (const path of await currentTypeScriptPaths(cwd)) {
    try {
      current.set(path, await readFile(join(cwd, path), 'utf8'));
    } catch (error: unknown) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }
  for (const path of await baseTypeScriptPaths(cwd, baseRefResolved)) {
    base.set(path, await sourceAtRef(cwd, baseRefResolved, path));
  }
  return compareSlop(measureSlop(base), measureSlop(current));
}
