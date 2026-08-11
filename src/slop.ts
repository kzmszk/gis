import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

function sourceLines(source: string): string[] {
  let inBlockComment = false;
  return source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return false;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return false;
    }
    return (
      trimmed.length > 0 &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*')
    );
  });
}

function duplicateLineCount(sources: ReadonlyMap<string, string>): number {
  const windows = new Map<string, number[][]>();
  let offset = 0;
  for (const source of sources.values()) {
    const lines = sourceLines(source).map((line) =>
      line
        .replace(/\/\/.*$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
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

/** Measure SCBench-inspired duplication and complexity concentration for TypeScript sources. */
export function measureSlop(sources: ReadonlyMap<string, string>): SlopScore {
  let loc = 0;
  let functions = 0;
  let totalMass = 0;
  let highComplexityMass = 0;
  for (const [path, source] of sources) {
    loc += sourceLines(source).length;
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (isFunction(node) && node.body !== undefined) {
        functions += 1;
        const start = file.getLineAndCharacterOfPosition(
          node.body.getStart(file),
        ).line;
        const end = file.getLineAndCharacterOfPosition(node.body.end).line;
        const mass =
          cyclomaticComplexity(node) * Math.sqrt(Math.max(1, end - start + 1));
        totalMass += mass;
        if (cyclomaticComplexity(node) > HIGH_COMPLEXITY)
          highComplexityMass += mass;
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

async function walkTypeScript(
  root: string,
  directory = root,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walkTypeScript(root, path)));
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    )
      paths.push(relative(root, path));
  }
  return paths;
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
): Promise<string | undefined> {
  try {
    return await git(cwd, ['show', `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Compare the current src tree with its merge-base against a Git ref. */
export async function measureWorktreeSlop(
  cwd: string,
  baseRef: string,
): Promise<SlopComparison> {
  const baseRefResolved = (
    await git(cwd, ['merge-base', baseRef, 'HEAD'])
  ).trim();
  const paths = await walkTypeScript(join(cwd, 'src'));
  const current = new Map<string, string>();
  const base = new Map<string, string>();
  for (const path of paths) {
    const repoPath = `src/${path}`;
    current.set(repoPath, await readFile(join(cwd, repoPath), 'utf8'));
    const source = await sourceAtRef(cwd, baseRefResolved, repoPath);
    if (source !== undefined) base.set(repoPath, source);
  }
  return compareSlop(measureSlop(base), measureSlop(current));
}
