import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type ReadSource =
  | 'visible'
  | 'recent'
  | 'recent-unwrapped'
  | 'detection';
export type ReadFormat = 'text' | 'ansi';

export interface HerdrClientOptions {
  socketPath?: string;
  /** Timeout for the socket exchange. Omit it for long-running waits. */
  timeoutMs?: number;
  requestIdPrefix?: string;
}

export interface WorktreeCreateOptions {
  branch: string;
  base?: string;
  cwd?: string;
  path?: string;
  label?: string;
  focus?: boolean;
  workspaceId?: string;
}

export interface WorktreeRemoveOptions {
  force?: boolean;
}

/** Options accepted by Herdr's pane.split API. */
export interface PaneSplitOptions {
  targetPaneId?: string;
  workspaceId?: string;
  direction?: 'right' | 'down';
  ratio?: number;
  cwd?: string;
  focus?: boolean;
  env?: Readonly<Record<string, string>>;
}

/** Minimal pane identity returned by Herdr's pane.split response. */
export interface PaneReference {
  pane_id: string;
  [key: string]: unknown;
}

/** Herdr 0.7 returns a `pane_info` result containing the created pane. */
export interface PaneSplitResult {
  type: 'pane_info';
  pane: PaneReference;
  [key: string]: unknown;
}

export interface AgentStartOptions {
  name: string;
  kind: string;
  paneId: string;
  args?: readonly string[];
  timeoutMs?: number;
}

export interface AgentPromptWaitOptions {
  until?: readonly AgentStatus[];
  timeoutMs?: number;
}

export interface AgentPromptOptions {
  wait?: AgentPromptWaitOptions;
}

export interface AgentWaitOptions {
  until?: readonly AgentStatus[];
  timeoutMs?: number;
}

export interface AgentReadOptions {
  source?: ReadSource;
  lines?: number;
  format?: ReadFormat;
  stripAnsi?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch?: string | null;
  is_bare?: boolean;
  is_detached?: boolean;
  is_prunable?: boolean;
  is_linked_worktree?: boolean;
  label?: string;
  open_workspace_id?: string | null;
}

export interface WorkspaceWorktreeInfo {
  checkout_path: string;
  is_linked_worktree?: boolean;
  repo_key?: string;
  repo_name?: string;
  repo_root?: string;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: AgentStatus;
  agent_session?: AgentSessionInfo | null;
  [key: string]: unknown;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label?: string;
  worktree?: WorkspaceWorktreeInfo | null;
  [key: string]: unknown;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  [key: string]: unknown;
}

export interface WorktreeCreatedResult {
  type: 'worktree_created';
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
}

export interface WorktreeRemovedResult {
  type: 'worktree_removed';
  workspace_id: string;
  path: string;
  forced: boolean;
}

export interface AgentInfo extends PaneInfo {
  agent?: string | null;
  name?: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  state_change_seq?: number;
}

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: 'id' | 'path';
  value: string;
}

export interface AgentStartedResult {
  type: 'agent_started';
  agent: AgentInfo;
  argv: string[];
}

export interface AgentPromptedResult {
  type: 'agent_prompted';
  agent: AgentInfo;
}

export interface AgentWaitMatchedResult {
  type: 'wait_matched';
  event: {
    event: string;
    data: {
      type: string;
      agent_status?: AgentStatus;
      [key: string]: unknown;
    };
  };
}

/** Herdr returns the current agent directly when it already matches `until`. */
export interface AgentWaitInfoResult {
  type: 'agent_info';
  agent: AgentInfo;
}

export type AgentWaitResult = AgentWaitMatchedResult | AgentWaitInfoResult;

export interface AgentReadResult {
  type: 'pane_read';
  read: {
    pane_id: string;
    source: ReadSource;
    format: ReadFormat;
    text: string;
    revision: number;
    truncated: boolean;
    [key: string]: unknown;
  };
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: unknown[];
  agents: AgentInfo[];
  [key: string]: unknown;
}

export interface SessionSnapshotResult {
  type: 'session_snapshot';
  snapshot: SessionSnapshot;
}

interface HerdrResponse {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
    [key: string]: unknown;
  };
}

export class HerdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HerdrError';
  }
}

export class HerdrApiError extends HerdrError {
  readonly code: string;
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(`herdr API error (${code}): ${message}`);
    this.name = 'HerdrApiError';
    this.code = code;
    this.data = data;
  }
}

export class HerdrProtocolError extends HerdrError {
  constructor(message: string) {
    super(`invalid herdr API response: ${message}`);
    this.name = 'HerdrProtocolError';
  }
}

export class HerdrConnectionError extends HerdrError {
  constructor(message: string) {
    super(`herdr socket connection failed: ${message}`);
    this.name = 'HerdrConnectionError';
  }
}

export function defaultHerdrSocketPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'herdr', 'herdr.sock');
}

function addIfDefined(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    params[key] = value;
  }
}

function normalizeOptions(
  options: HerdrClientOptions | string | undefined,
): HerdrClientOptions {
  return typeof options === 'string'
    ? { socketPath: options }
    : (options ?? {});
}

type HerdrObject = Record<string, unknown>;

// External values stay `unknown` until a method validator checks every field
// GIS consumes.  The narrow assertions in those validators only preserve
// validated objects' extension fields; request() itself never casts a result.

function protocolFailure(path: string, detail: string): never {
  throw new HerdrProtocolError(`${path} ${detail}`);
}

function objectAt(value: unknown, path: string): HerdrObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return protocolFailure(path, 'must be an object');
  }
  return value as HerdrObject;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return protocolFailure(path, 'must be a non-empty string');
  }
  return value;
}

function optionalStringAt(value: HerdrObject, key: string, path: string): void {
  if (value[key] !== undefined) {
    stringAt(value[key], `${path}.${key}`);
  }
}

function optionalNullableStringAt(
  value: HerdrObject,
  key: string,
  path: string,
): void {
  if (value[key] !== undefined && value[key] !== null) {
    stringAt(value[key], `${path}.${key}`);
  }
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return protocolFailure(path, 'must be a boolean');
  }
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return protocolFailure(path, 'must be a finite number');
  }
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    return protocolFailure(path, 'must be an array');
  }
  return value;
}

function discriminatorAt(
  value: HerdrObject,
  expected: string,
  path: string,
): void {
  if (value.type !== expected) {
    protocolFailure(`${path}.type`, `must be ${JSON.stringify(expected)}`);
  }
}

function agentStatusAt(value: unknown, path: string): AgentStatus {
  if (
    value !== 'idle' &&
    value !== 'working' &&
    value !== 'blocked' &&
    value !== 'done' &&
    value !== 'unknown'
  ) {
    return protocolFailure(path, 'must be a known agent status');
  }
  return value;
}

function validateAgentSession(
  value: unknown,
  path: string,
): AgentSessionInfo | null {
  if (value === null) {
    return null;
  }
  const session = objectAt(value, path);
  stringAt(session.source, `${path}.source`);
  stringAt(session.agent, `${path}.agent`);
  if (session.kind !== 'id' && session.kind !== 'path') {
    protocolFailure(`${path}.kind`, 'must be id or path');
  }
  stringAt(session.value, `${path}.value`);
  return session as unknown as AgentSessionInfo;
}

function validatePaneInfo(value: unknown, path: string): PaneInfo {
  const pane = objectAt(value, path);
  stringAt(pane.pane_id, `${path}.pane_id`);
  stringAt(pane.workspace_id, `${path}.workspace_id`);
  stringAt(pane.tab_id, `${path}.tab_id`);
  agentStatusAt(pane.agent_status, `${path}.agent_status`);
  if (pane.agent_session !== undefined) {
    validateAgentSession(pane.agent_session, `${path}.agent_session`);
  }
  if (pane.name !== undefined && pane.name !== null) {
    stringAt(pane.name, `${path}.name`);
  }
  if (pane.agent !== undefined && pane.agent !== null) {
    stringAt(pane.agent, `${path}.agent`);
  }
  if (pane.interactive_ready !== undefined) {
    booleanAt(pane.interactive_ready, `${path}.interactive_ready`);
  }
  if (pane.launch_pending !== undefined) {
    booleanAt(pane.launch_pending, `${path}.launch_pending`);
  }
  if (pane.state_change_seq !== undefined) {
    numberAt(pane.state_change_seq, `${path}.state_change_seq`);
  }
  return pane as PaneInfo;
}

function validateAgentInfo(value: unknown, path: string): AgentInfo {
  const agent = validatePaneInfo(value, path) as AgentInfo;
  const record = agent as HerdrObject;
  const name = record.name;
  const identity = record.agent;
  if (
    (name === undefined || name === null || String(name).trim().length === 0) &&
    (identity === undefined ||
      identity === null ||
      String(identity).trim().length === 0)
  ) {
    protocolFailure(`${path}.agent`, 'must include an agent identity');
  }
  if (record.agent !== undefined && record.agent !== null) {
    stringAt(record.agent, `${path}.agent`);
  }
  if (record.name !== undefined && record.name !== null) {
    stringAt(record.name, `${path}.name`);
  }
  return agent;
}

function validateWorktreeInfo(value: unknown, path: string): WorktreeInfo {
  const worktree = objectAt(value, path);
  stringAt(worktree.path, `${path}.path`);
  optionalNullableStringAt(worktree, 'branch', path);
  optionalStringAt(worktree, 'label', path);
  optionalNullableStringAt(worktree, 'open_workspace_id', path);
  for (const key of [
    'is_bare',
    'is_detached',
    'is_prunable',
    'is_linked_worktree',
  ]) {
    if (worktree[key] !== undefined) {
      booleanAt(worktree[key], `${path}.${key}`);
    }
  }
  return worktree as unknown as WorktreeInfo;
}

function validateWorkspaceInfo(value: unknown, path: string): WorkspaceInfo {
  const workspace = objectAt(value, path);
  stringAt(workspace.workspace_id, `${path}.workspace_id`);
  // Herdr 0.7 omits labels for workspaces created by the CLI.  GIS only uses
  // the stable workspace id and checkout path; preserve labels when present.
  optionalStringAt(workspace, 'label', path);
  if (workspace.worktree !== undefined && workspace.worktree !== null) {
    const worktree = objectAt(workspace.worktree, `${path}.worktree`);
    stringAt(worktree.checkout_path, `${path}.worktree.checkout_path`);
    if (worktree.is_linked_worktree !== undefined) {
      booleanAt(
        worktree.is_linked_worktree,
        `${path}.worktree.is_linked_worktree`,
      );
    }
    optionalStringAt(worktree, 'repo_key', `${path}.worktree`);
    optionalStringAt(worktree, 'repo_name', `${path}.worktree`);
    optionalStringAt(worktree, 'repo_root', `${path}.worktree`);
  }
  return workspace as WorkspaceInfo;
}

function validateTabInfo(value: unknown, path: string): TabInfo {
  const tab = objectAt(value, path);
  stringAt(tab.tab_id, `${path}.tab_id`);
  stringAt(tab.workspace_id, `${path}.workspace_id`);
  return tab as TabInfo;
}

function validateWorktreeCreated(value: unknown): WorktreeCreatedResult {
  const result = objectAt(value, 'worktree.create result');
  discriminatorAt(result, 'worktree_created', 'worktree.create result');
  validateWorkspaceInfo(result.workspace, 'worktree.create result.workspace');
  validateTabInfo(result.tab, 'worktree.create result.tab');
  validatePaneInfo(result.root_pane, 'worktree.create result.root_pane');
  validateWorktreeInfo(result.worktree, 'worktree.create result.worktree');
  return result as unknown as WorktreeCreatedResult;
}

function validateWorktreeRemoved(value: unknown): WorktreeRemovedResult {
  const result = objectAt(value, 'worktree.remove result');
  discriminatorAt(result, 'worktree_removed', 'worktree.remove result');
  stringAt(result.workspace_id, 'worktree.remove result.workspace_id');
  stringAt(result.path, 'worktree.remove result.path');
  booleanAt(result.forced, 'worktree.remove result.forced');
  return result as unknown as WorktreeRemovedResult;
}

function validatePaneReference(value: unknown, path: string): PaneReference {
  const pane = objectAt(value, path);
  stringAt(pane.pane_id, `${path}.pane_id`);
  return pane as unknown as PaneReference;
}

function validatePaneSplit(value: unknown): PaneSplitResult {
  const result = objectAt(value, 'pane.split result');
  discriminatorAt(result, 'pane_info', 'pane.split result');
  validatePaneReference(result.pane, 'pane.split result.pane');
  return result as unknown as PaneSplitResult;
}

function validateAgentStarted(value: unknown): AgentStartedResult {
  const result = objectAt(value, 'agent.start result');
  discriminatorAt(result, 'agent_started', 'agent.start result');
  validateAgentInfo(result.agent, 'agent.start result.agent');
  const argv = arrayAt(result.argv, 'agent.start result.argv');
  argv.forEach((arg, index) => {
    // Empty strings are valid process arguments, unlike identity fields.
    if (typeof arg !== 'string') {
      protocolFailure(`agent.start result.argv[${index}]`, 'must be a string');
    }
  });
  return result as unknown as AgentStartedResult;
}

function validateAgentPrompted(value: unknown): AgentPromptedResult {
  const result = objectAt(value, 'agent.prompt result');
  discriminatorAt(result, 'agent_prompted', 'agent.prompt result');
  validateAgentInfo(result.agent, 'agent.prompt result.agent');
  return result as unknown as AgentPromptedResult;
}

function validateAgentWait(value: unknown): AgentWaitResult {
  const result = objectAt(value, 'agent.wait result');
  if (result.type === 'agent_info') {
    validateAgentInfo(result.agent, 'agent.wait result.agent');
    return result as unknown as AgentWaitInfoResult;
  }
  discriminatorAt(result, 'wait_matched', 'agent.wait result');
  const event = objectAt(result.event, 'agent.wait result.event');
  stringAt(event.event, 'agent.wait result.event.event');
  const data = objectAt(event.data, 'agent.wait result.event.data');
  stringAt(data.type, 'agent.wait result.event.data.type');
  if (data.agent_status !== undefined) {
    agentStatusAt(
      data.agent_status,
      'agent.wait result.event.data.agent_status',
    );
  }
  return result as unknown as AgentWaitMatchedResult;
}

function validateAgentRead(value: unknown): AgentReadResult {
  const result = objectAt(value, 'agent.read result');
  discriminatorAt(result, 'pane_read', 'agent.read result');
  const read = objectAt(result.read, 'agent.read result.read');
  stringAt(read.pane_id, 'agent.read result.read.pane_id');
  if (
    read.source !== 'visible' &&
    read.source !== 'recent' &&
    read.source !== 'recent-unwrapped' &&
    read.source !== 'detection'
  ) {
    protocolFailure(
      'agent.read result.read.source',
      'must be a known read source',
    );
  }
  if (read.format !== 'text' && read.format !== 'ansi') {
    protocolFailure('agent.read result.read.format', 'must be text or ansi');
  }
  if (typeof read.text !== 'string') {
    protocolFailure('agent.read result.read.text', 'must be a string');
  }
  if (!Number.isSafeInteger(read.revision) || (read.revision as number) < 0) {
    protocolFailure(
      'agent.read result.read.revision',
      'must be a non-negative integer',
    );
  }
  booleanAt(read.truncated, 'agent.read result.read.truncated');
  return result as unknown as AgentReadResult;
}

function validateSnapshot(value: unknown): SessionSnapshotResult {
  const result = objectAt(value, 'session.snapshot result');
  discriminatorAt(result, 'session_snapshot', 'session.snapshot result');
  const snapshot = objectAt(
    result.snapshot,
    'session.snapshot result.snapshot',
  );
  stringAt(snapshot.version, 'session.snapshot result.snapshot.version');
  numberAt(snapshot.protocol, 'session.snapshot result.snapshot.protocol');
  const workspaces = arrayAt(
    snapshot.workspaces,
    'session.snapshot result.snapshot.workspaces',
  );
  workspaces.forEach((item, index) =>
    validateWorkspaceInfo(
      item,
      `session.snapshot result.snapshot.workspaces[${index}]`,
    ),
  );
  const tabs = arrayAt(snapshot.tabs, 'session.snapshot result.snapshot.tabs');
  tabs.forEach((item, index) =>
    validateTabInfo(item, `session.snapshot result.snapshot.tabs[${index}]`),
  );
  const panes = arrayAt(
    snapshot.panes,
    'session.snapshot result.snapshot.panes',
  );
  panes.forEach((item, index) =>
    validatePaneInfo(item, `session.snapshot result.snapshot.panes[${index}]`),
  );
  arrayAt(snapshot.layouts, 'session.snapshot result.snapshot.layouts');
  const agents = arrayAt(
    snapshot.agents,
    'session.snapshot result.snapshot.agents',
  );
  agents.forEach((item, index) =>
    validateAgentInfo(
      item,
      `session.snapshot result.snapshot.agents[${index}]`,
    ),
  );
  return result as unknown as SessionSnapshotResult;
}

function parseResponseLine(line: string): HerdrResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new HerdrProtocolError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HerdrProtocolError('response was not an object');
  }
  // The object guard above establishes the only assertion needed for the
  // response envelope; method results are validated separately at the API
  // boundary by requestValidated.
  return value as HerdrResponse;
}

export class HerdrClient {
  readonly socketPath: string;

  private readonly timeoutMs: number | undefined;
  private readonly requestIdPrefix: string;
  private nextRequestId = 1;

  constructor(options?: HerdrClientOptions | string) {
    const normalized = normalizeOptions(options);
    if (
      normalized.timeoutMs !== undefined &&
      (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0)
    ) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }

    this.socketPath =
      normalized.socketPath ??
      process.env.HERDR_SOCKET_PATH ??
      defaultHerdrSocketPath();
    this.timeoutMs = normalized.timeoutMs;
    this.requestIdPrefix = normalized.requestIdPrefix ?? 'gis';
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    exchangeTimeoutMs?: number,
  ): Promise<unknown> {
    if (method.length === 0) {
      throw new TypeError('herdr API method must not be empty');
    }

    const id = `${this.requestIdPrefix}:${this.nextRequestId++}`;
    const request = `${JSON.stringify({ id, method, params })}\n`;
    const response = await this.exchange(request, exchangeTimeoutMs);

    if (response.id !== id) {
      throw new HerdrProtocolError(
        `response id ${String(response.id)} does not match request ${id}`,
      );
    }

    if (response.error !== undefined) {
      if (
        response.error === null ||
        typeof response.error !== 'object' ||
        Array.isArray(response.error)
      ) {
        throw new HerdrProtocolError(
          'response error envelope was not an object',
        );
      }
      const code = stringAt(response.error.code, 'response.error.code');
      const message = stringAt(
        response.error.message,
        'response.error.message',
      );
      throw new HerdrApiError(code, message, response.error.data);
    }

    if (!('result' in response)) {
      throw new HerdrProtocolError('response did not contain result or error');
    }

    return response.result;
  }

  private async requestValidated<T>(
    method: string,
    params: Record<string, unknown>,
    validate: (value: unknown) => T,
    exchangeTimeoutMs?: number,
  ): Promise<T> {
    const result = await this.request(method, params, exchangeTimeoutMs);
    return validate(result);
  }

  worktreeCreate(
    options: WorktreeCreateOptions,
  ): Promise<WorktreeCreatedResult> {
    const params: Record<string, unknown> = { branch: options.branch };
    addIfDefined(params, 'base', options.base);
    addIfDefined(params, 'cwd', options.cwd);
    addIfDefined(params, 'path', options.path);
    addIfDefined(params, 'label', options.label);
    addIfDefined(params, 'focus', options.focus);
    addIfDefined(params, 'workspace_id', options.workspaceId);
    return this.requestValidated(
      'worktree.create',
      params,
      validateWorktreeCreated,
    );
  }

  worktreeRemove(
    workspaceId: string,
    options: WorktreeRemoveOptions = {},
  ): Promise<WorktreeRemovedResult> {
    const params: Record<string, unknown> = { workspace_id: workspaceId };
    addIfDefined(params, 'force', options.force);
    return this.requestValidated(
      'worktree.remove',
      params,
      validateWorktreeRemoved,
    );
  }

  paneSplit(options: PaneSplitOptions = {}): Promise<PaneSplitResult> {
    const params: Record<string, unknown> = {
      direction: options.direction ?? 'right',
    };
    addIfDefined(params, 'target_pane_id', options.targetPaneId);
    addIfDefined(params, 'workspace_id', options.workspaceId);
    addIfDefined(params, 'ratio', options.ratio);
    addIfDefined(params, 'cwd', options.cwd);
    addIfDefined(params, 'focus', options.focus);
    addIfDefined(
      params,
      'env',
      options.env === undefined ? undefined : { ...options.env },
    );
    return this.requestValidated('pane.split', params, validatePaneSplit);
  }

  agentStart(options: AgentStartOptions): Promise<AgentStartedResult>;
  agentStart(
    name: string,
    kind: string,
    paneId: string,
    args?: readonly string[],
    timeoutMs?: number,
  ): Promise<AgentStartedResult>;
  agentStart(
    optionsOrName: AgentStartOptions | string,
    kind?: string,
    paneId?: string,
    args?: readonly string[],
    timeoutMs?: number,
  ): Promise<AgentStartedResult> {
    const options: AgentStartOptions =
      typeof optionsOrName === 'string'
        ? { name: optionsOrName, kind: kind!, paneId: paneId!, args, timeoutMs }
        : optionsOrName;
    const params: Record<string, unknown> = {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
    };
    addIfDefined(
      params,
      'args',
      options.args === undefined ? undefined : [...options.args],
    );
    addIfDefined(params, 'timeout_ms', options.timeoutMs);
    return this.requestValidated(
      'agent.start',
      params,
      validateAgentStarted,
      options.timeoutMs,
    );
  }

  agentPrompt(
    target: string,
    text: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentPromptedResult> {
    const params: Record<string, unknown> = { target, text };
    if (options.wait !== undefined) {
      const wait: Record<string, unknown> = {};
      addIfDefined(
        wait,
        'until',
        options.wait.until === undefined ? undefined : [...options.wait.until],
      );
      addIfDefined(wait, 'timeout_ms', options.wait.timeoutMs);
      params.wait = wait;
    }
    return this.requestValidated(
      'agent.prompt',
      params,
      validateAgentPrompted,
      options.wait?.timeoutMs,
    );
  }

  agentWait(
    target: string,
    options: AgentWaitOptions = {},
  ): Promise<AgentWaitResult> {
    const params: Record<string, unknown> = {
      target,
      until:
        options.until === undefined ? ['done', 'blocked'] : [...options.until],
    };
    addIfDefined(params, 'timeout_ms', options.timeoutMs);
    return this.requestValidated(
      'agent.wait',
      params,
      validateAgentWait,
      options.timeoutMs,
    );
  }

  agentRead(
    target: string,
    options: AgentReadOptions = {},
  ): Promise<AgentReadResult> {
    const params: Record<string, unknown> = {
      target,
      source: options.source ?? 'recent',
      format: options.format ?? 'text',
      strip_ansi: options.stripAnsi ?? true,
    };
    addIfDefined(params, 'lines', options.lines);
    return this.requestValidated('agent.read', params, validateAgentRead);
  }

  apiSnapshot(timeoutMs?: number): Promise<SessionSnapshotResult> {
    return this.requestValidated(
      'session.snapshot',
      {},
      validateSnapshot,
      timeoutMs,
    );
  }

  snapshot(): Promise<SessionSnapshotResult> {
    return this.apiSnapshot();
  }

  private exchange(
    request: string,
    requestTimeoutMs?: number,
  ): Promise<HerdrResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let socket: Socket;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        callback();
      };

      const fail = (error: Error): void => finish(() => reject(error));

      try {
        socket = createConnection(this.socketPath);
      } catch (error) {
        reject(
          new HerdrConnectionError(
            error instanceof Error ? error.message : String(error),
          ),
        );
        return;
      }

      const timeoutMs = requestTimeoutMs ?? this.timeoutMs;
      if (timeoutMs !== undefined) {
        socket.setTimeout(timeoutMs, () => {
          fail(new HerdrConnectionError(`timed out after ${timeoutMs}ms`));
        });
      }

      socket.once('connect', () => {
        try {
          socket.write(request);
        } catch (error) {
          fail(
            new HerdrConnectionError(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      });

      socket.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          return;
        }

        const line = buffer.slice(0, newline).trim();
        if (line.length === 0) {
          fail(new HerdrProtocolError('response line was empty'));
          return;
        }

        try {
          const response = parseResponseLine(line);
          finish(() => resolve(response));
        } catch (error) {
          fail(
            error instanceof HerdrProtocolError
              ? error
              : new HerdrProtocolError(String(error)),
          );
          return;
        }
      });

      socket.once('end', () => {
        if (buffer.trim().length > 0 && !settled) {
          try {
            const response = parseResponseLine(buffer.trim());
            finish(() => resolve(response));
          } catch (error) {
            fail(
              error instanceof HerdrProtocolError
                ? error
                : new HerdrProtocolError(String(error)),
            );
            return;
          }
          return;
        }
        fail(
          new HerdrConnectionError(
            'socket closed before a response was received',
          ),
        );
      });

      socket.once('error', (error: Error) => {
        fail(new HerdrConnectionError(error.message));
      });
    });
  }
}

export class HerdrAdapter extends HerdrClient {}

export function createHerdrAdapter(
  options?: HerdrClientOptions | string,
): HerdrAdapter {
  return new HerdrAdapter(options);
}
