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

/** Initialize a repository with a default-first interactive GIS setup. */
export async function initializeProject(
  options: InitOptions = {},
): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = options.defaults ?? false;
  const report = options.report ?? ((message: string) => console.log(message));
  const runCommand = options.runCommand ?? defaultRunCommand;
  let closePrompt: (() => void) | undefined;
  let ask = options.ask;

  if (!defaults && ask === undefined) {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error(
        'gis init は対話端末が必要です。自動設定には gis init --defaults を使ってください',
      );
    }
    const terminal = createInterface({ input: stdin, output: stdout });
    ask = (question) => terminal.question(question);
    closePrompt = () => terminal.close();
  }

  const answer = async (question: string): Promise<string> =>
    defaults ? '' : ask!(question);

  try {
    report(`GISプロジェクトを初期化します: ${cwd}`);
    const configPath = resolve(cwd, CONFIG_RELATIVE_PATH);
    if (await pathExists(configPath)) {
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
        return { status: 'cancelled' };
      }
    }

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

    report('');
    report(`  Git初期化: ${initializeGit ? `はい (${base})` : '不要'}`);
    report(`  Beads初期化: ${initializeBeads ? `はい (${prefix})` : '不要'}`);
    report(`  検証: ${verify}`);
    report(`  並列数: ${concurrencyText}`);
    report(`  エージェント: ${kindsText}`);
    const proceed = await askYesNo(
      answer,
      'この設定で作成しますか?',
      true,
      report,
    );
    if (!proceed) {
      report('gis: 初期化をキャンセルしました');
      return { status: 'cancelled' };
    }

    if (initializeGit) {
      await runCommand('git', ['init', '-b', base], cwd);
    }
    if (initializeBeads) {
      await runCommand(
        'bd',
        ['init', '--non-interactive', '--prefix', prefix!],
        cwd,
      );
    }

    const config: GisConfig = {
      ...DEFAULT_CONFIG,
      concurrency: Number(concurrencyText),
      base,
      verify,
      kinds: kindsText.split(',').map((kind) => kind.trim()),
    };
    const contents = serializeConfig(config);
    parseConfig(contents);
    await mkdir(resolve(cwd, '.gis'), { recursive: true });
    await writeFile(configPath, contents, 'utf8');
    await updateGitignore(cwd);

    report('');
    report(`gis: 初期化しました: ${configPath}`);
    report(
      '次の手順: 設定とプロジェクトファイルをコミットし、Beadを作成して gis run を実行してください',
    );
    return {
      status: 'initialized',
      configPath,
      gitInitialized: initializeGit,
      beadsInitialized: initializeBeads,
    };
  } finally {
    closePrompt?.();
  }
}
