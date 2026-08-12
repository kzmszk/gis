import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import {
  DEFAULT_CONFIG,
  parseConfig,
  type GisConfig,
  type ProfileCandidate,
  type ProfileName,
} from './config.js';

const execFileAsync = promisify(execFile);
const CONFIG_RELATIVE_PATH = '.gis/config.toml';
const RUNTIME_IGNORE = '.gis/run/';

export interface InitCommandResult {
  readonly stdout: string;
}

export interface InitOptions {
  readonly cwd?: string;
  readonly defaults?: boolean;
  readonly ask?: (question: string) => Promise<string>;
  readonly report?: (message: string) => void;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<InitCommandResult>;
}

export interface InitResult {
  readonly status: 'initialized' | 'cancelled';
  readonly configPath?: string;
  readonly gitInitialized?: boolean;
  readonly beadsInitialized?: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultPrefix(cwd: string): string {
  const normalized = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  return normalized || 'project';
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function profileLines(
  name: ProfileName,
  candidates: readonly ProfileCandidate[],
): string[] {
  return candidates.flatMap((candidate) => [
    `[[profiles.${name}]]`,
    `kind = ${quote(candidate.kind)}`,
    `model = ${quote(candidate.model)}`,
    `effort = ${quote(candidate.effort)}`,
    '',
  ]);
}

/** Serialize the complete config so a generated file is self-documenting. */
export function serializeConfig(config: GisConfig): string {
  const lines = [
    `concurrency = ${config.concurrency}`,
    `base = ${quote(config.base)}`,
    `verify = ${quote(config.verify)}`,
    `kinds = [${config.kinds.map(quote).join(', ')}]`,
    `review = ${config.review}`,
    `verify_max = ${config.verify_max}`,
    `review_max = ${config.review_max}`,
    `blocked_timeout = ${quote(config.blocked_timeout)}`,
    `worker_timeout = ${quote(config.worker_timeout)}`,
    `verify_timeout = ${quote(config.verify_timeout)}`,
    `claude_permission_mode = ${quote(config.claude_permission_mode)}`,
    '',
    ...profileLines('plan', config.profiles.plan),
    ...profileLines('implement', config.profiles.implement),
    ...profileLines('review', config.profiles.review),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<InitCommandResult> {
  const result = await execFileAsync(command, [...args], { cwd });
  return { stdout: result.stdout };
}

async function detectGit(
  cwd: string,
  runCommand: NonNullable<InitOptions['runCommand']>,
): Promise<{ exists: boolean; base: string }> {
  try {
    const root = (
      await runCommand('git', ['rev-parse', '--show-toplevel'], cwd)
    ).stdout.trim();
    if (resolve(root) !== resolve(cwd)) {
      throw new Error(
        `gis init はGitリポジトリのルートで実行してください: ${root}`,
      );
    }
    const branch = (
      await runCommand('git', ['branch', '--show-current'], cwd)
    ).stdout.trim();
    return { exists: true, base: branch || DEFAULT_CONFIG.base };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.startsWith('gis init はGitリポジトリのルート')
    ) {
      throw error;
    }
    return { exists: false, base: DEFAULT_CONFIG.base };
  }
}

async function detectVerifyCommand(cwd: string): Promise<string> {
  if (await pathExists(resolve(cwd, 'package.json'))) {
    try {
      const packageJson = JSON.parse(
        await readFile(resolve(cwd, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, unknown> };
      if (typeof packageJson.scripts?.check === 'string') {
        return (await pathExists(resolve(cwd, 'pnpm-lock.yaml')))
          ? 'pnpm check'
          : 'npm run check';
      }
      if (typeof packageJson.scripts?.test === 'string') return 'npm test';
    } catch {
      // The config wizard can still use the generic default for malformed JSON.
    }
  }
  if (await pathExists(resolve(cwd, 'Cargo.toml'))) return 'cargo test';
  if (await pathExists(resolve(cwd, 'go.mod'))) return 'go test ./...';
  if (await pathExists(resolve(cwd, 'pyproject.toml'))) return 'pytest';
  return DEFAULT_CONFIG.verify;
}

function parseYesNo(value: string, defaultValue: boolean): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  if (normalized === 'y' || normalized === 'yes') return true;
  if (normalized === 'n' || normalized === 'no') return false;
  return undefined;
}

async function askValue(
  ask: (question: string) => Promise<string>,
  question: string,
  defaultValue: string,
  validate: (value: string) => string | undefined,
  report: (message: string) => void,
): Promise<string> {
  while (true) {
    const answer = (await ask(`${question} [${defaultValue}]: `)).trim();
    const value = answer || defaultValue;
    const issue = validate(value);
    if (issue === undefined) return value;
    report(`gis: ${issue}`);
  }
}

async function askYesNo(
  ask: (question: string) => Promise<string>,
  question: string,
  defaultValue: boolean,
  report: (message: string) => void,
): Promise<boolean> {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  while (true) {
    const answer = await ask(`${question} ${suffix}: `);
    const parsed = parseYesNo(answer, defaultValue);
    if (parsed !== undefined) return parsed;
    report('gis: y または n で答えてください');
  }
}

async function updateGitignore(cwd: string): Promise<void> {
  const path = resolve(cwd, '.gitignore');
  const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : '';
  if (
    existing
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .includes(RUNTIME_IGNORE)
  ) {
    return;
  }
  const separator =
    existing.length === 0 || existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  await writeFile(
    path,
    `${existing}${separator}# gis runtime artifacts\n${RUNTIME_IGNORE}\n`,
    'utf8',
  );
}

type Answer = (question: string) => Promise<string>;
type Report = (message: string) => void;
type RunCommand = NonNullable<InitOptions['runCommand']>;

/**
 * Owns the interactive-prompt lifecycle for one `initializeProject` run.
 *
 * Invariants:
 * - `close()` is always safe to call (a no-op unless a live readline
 *   interface was opened) and must be called exactly once, even on failure.
 * - `answer` never touches the terminal in `--defaults` mode; it resolves
 *   to `''` so every question falls back to its default.
 * - Opening a live terminal requires both `stdin` and `stdout` to be a TTY;
 *   otherwise construction throws before any prompt is shown.
 */
interface RunContext {
  readonly cwd: string;
  readonly defaults: boolean;
  readonly report: Report;
  readonly runCommand: RunCommand;
  readonly answer: Answer;
  readonly close: () => void;
}

function createRunContext(options: InitOptions): RunContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = options.defaults ?? false;
  const report = options.report ?? ((message: string) => console.log(message));
  const runCommand = options.runCommand ?? defaultRunCommand;
  let ask = options.ask;
  let close = (): void => undefined;

  if (!defaults && ask === undefined) {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error(
        'gis init は対話端末が必要です。自動設定には gis init --defaults を使ってください',
      );
    }
    const terminal = createInterface({ input: stdin, output: stdout });
    ask = (question) => terminal.question(question);
    close = () => terminal.close();
  }

  const answer: Answer = async (question) => (defaults ? '' : ask!(question));

  return { cwd, defaults, report, runCommand, answer, close };
}

/**
 * Guards the target config path before anything else runs.
 *
 * Returns `false` (after reporting the cancellation) when the caller should
 * abort with `{ status: 'cancelled' }`. Throws instead of prompting when
 * `--defaults` finds an existing config, since there is no one to confirm
 * an overwrite with.
 */
async function ensureConfigWritable(
  configPath: string,
  defaults: boolean,
  answer: Answer,
  report: Report,
): Promise<boolean> {
  if (!(await pathExists(configPath))) return true;
  if (defaults) {
    throw new Error(
      `${CONFIG_RELATIVE_PATH} は既に存在します。対話モードで上書きを確認してください`,
    );
  }
  const overwrite = await askYesNo(
    answer,
    `${CONFIG_RELATIVE_PATH} は既に存在します。上書きしますか?`,
    false,
    report,
  );
  if (!overwrite) {
    report('gis: 初期化をキャンセルしました');
    return false;
  }
  return true;
}

interface CollectedAnswers {
  readonly initializeGit: boolean;
  readonly initializeBeads: boolean;
  readonly base: string;
  readonly verify: string;
  readonly concurrencyText: string;
  readonly kindsText: string;
  readonly prefix: string | undefined;
}

/**
 * Runs every setup question in the fixed order the CLI has always asked
 * them in (Git, then Beads, then base/verify/concurrency/kinds, then the
 * Beads prefix if Beads is being initialized). Detection (`detectGit`,
 * `detectVerifyCommand`, an existing `.beads` directory) supplies the
 * default each question offers; `--defaults` mode accepts every default
 * without prompting.
 */
async function collectAnswers(
  cwd: string,
  runCommand: RunCommand,
  answer: Answer,
  report: Report,
): Promise<CollectedAnswers> {
  const git = await detectGit(cwd, runCommand);
  const initializeGit = git.exists
    ? false
    : await askYesNo(answer, 'Gitリポジトリを初期化しますか?', true, report);
  const beadsExists = await pathExists(resolve(cwd, '.beads'));
  const initializeBeads = beadsExists
    ? false
    : await askYesNo(answer, 'Beadsを初期化しますか?', true, report);
  const base = await askValue(
    answer,
    'baseブランチ',
    git.base,
    (value) => (value.trim() ? undefined : 'baseブランチは空にできません'),
    report,
  );
  const verify = await askValue(
    answer,
    '検証コマンド',
    await detectVerifyCommand(cwd),
    (value) => (value.trim() ? undefined : '検証コマンドは空にできません'),
    report,
  );
  const concurrencyText = await askValue(
    answer,
    '並列タスク数',
    String(DEFAULT_CONFIG.concurrency),
    (value) =>
      /^[1-9]\d*$/.test(value)
        ? undefined
        : '並列タスク数には正の整数を指定してください',
    report,
  );
  const kindsText = await askValue(
    answer,
    '利用するエージェント（カンマ区切り）',
    DEFAULT_CONFIG.kinds.join(','),
    (value) =>
      value
        .split(',')
        .map((kind) => kind.trim())
        .every(Boolean)
        ? undefined
        : 'エージェントを1つ以上指定してください',
    report,
  );
  const prefix = initializeBeads
    ? await askValue(
        answer,
        'Beadsのissue prefix',
        defaultPrefix(cwd),
        (value) =>
          /^[a-z][a-z0-9-]*$/.test(value)
            ? undefined
            : 'prefixは小文字英数字で始め、使用できる文字は小文字英数字とハイフンです',
        report,
      )
    : undefined;

  return {
    initializeGit,
    initializeBeads,
    base,
    verify,
    concurrencyText,
    kindsText,
    prefix,
  };
}

/**
 * Carries out the confirmed plan: runs `git init`/`bd init` when requested
 * (in that order), then validates and persists `.gis/config.toml` and
 * updates `.gitignore`. Assumes the caller already confirmed the plan;
 * every step here is a real filesystem or subprocess side effect.
 */
async function applyDecisions(
  cwd: string,
  configPath: string,
  runCommand: RunCommand,
  answers: CollectedAnswers,
): Promise<void> {
  if (answers.initializeGit) {
    await runCommand('git', ['init', '-b', answers.base], cwd);
  }
  if (answers.initializeBeads) {
    await runCommand(
      'bd',
      ['init', '--non-interactive', '--prefix', answers.prefix!],
      cwd,
    );
  }

  const config: GisConfig = {
    ...DEFAULT_CONFIG,
    concurrency: Number(answers.concurrencyText),
    base: answers.base,
    verify: answers.verify,
    kinds: answers.kindsText.split(',').map((kind) => kind.trim()),
  };
  const contents = serializeConfig(config);
  parseConfig(contents);
  await mkdir(resolve(cwd, '.gis'), { recursive: true });
  await writeFile(configPath, contents, 'utf8');
  await updateGitignore(cwd);
}

/** Initialize a repository with a default-first interactive GIS setup. */
export async function initializeProject(
  options: InitOptions = {},
): Promise<InitResult> {
  const ctx = createRunContext(options);
  try {
    ctx.report(`GISプロジェクトを初期化します: ${ctx.cwd}`);
    const configPath = resolve(ctx.cwd, CONFIG_RELATIVE_PATH);
    if (
      !(await ensureConfigWritable(
        configPath,
        ctx.defaults,
        ctx.answer,
        ctx.report,
      ))
    ) {
      return { status: 'cancelled' };
    }

    const answers = await collectAnswers(
      ctx.cwd,
      ctx.runCommand,
      ctx.answer,
      ctx.report,
    );

    ctx.report('');
    ctx.report(
      `  Git初期化: ${answers.initializeGit ? `はい (${answers.base})` : '不要'}`,
    );
    ctx.report(
      `  Beads初期化: ${answers.initializeBeads ? `はい (${answers.prefix})` : '不要'}`,
    );
    ctx.report(`  検証: ${answers.verify}`);
    ctx.report(`  並列数: ${answers.concurrencyText}`);
    ctx.report(`  エージェント: ${answers.kindsText}`);
    const proceed = await askYesNo(
      ctx.answer,
      'この設定で作成しますか?',
      true,
      ctx.report,
    );
    if (!proceed) {
      ctx.report('gis: 初期化をキャンセルしました');
      return { status: 'cancelled' };
    }

    await applyDecisions(ctx.cwd, configPath, ctx.runCommand, answers);

    ctx.report('');
    ctx.report(`gis: 初期化しました: ${configPath}`);
    ctx.report(
      '次の手順: 設定とプロジェクトファイルをコミットし、Beadを作成して gis run を実行してください',
    );
    return {
      status: 'initialized',
      configPath,
      gitInitialized: answers.initializeGit,
      beadsInitialized: answers.initializeBeads,
    };
  } finally {
    ctx.close();
  }
}
