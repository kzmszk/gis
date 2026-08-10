import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type ReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";
export type ReadFormat = "text" | "ansi";

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
  is_linked_worktree: boolean;
  repo_key: string;
  repo_name: string;
  repo_root: string;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: AgentStatus;
  [key: string]: unknown;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  worktree?: WorkspaceWorktreeInfo | null;
  [key: string]: unknown;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  [key: string]: unknown;
}

export interface WorktreeCreatedResult {
  type: "worktree_created";
  workspace: WorkspaceInfo;
  tab: TabInfo;
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
}

export interface WorktreeRemovedResult {
  type: "worktree_removed";
  workspace_id: string;
  path: string;
  forced: boolean;
}

export interface AgentInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: AgentStatus;
  [key: string]: unknown;
}

export interface AgentStartedResult {
  type: "agent_started";
  agent: AgentInfo;
  argv: string[];
}

export interface AgentPromptedResult {
  type: "agent_prompted";
  agent: AgentInfo;
}

export interface AgentWaitResult {
  type: "wait_matched";
  event: {
    event: string;
    data: {
      type: string;
      agent_status?: AgentStatus;
      [key: string]: unknown;
    };
  };
}

export interface AgentReadResult {
  type: "pane_read";
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
  type: "session_snapshot";
  snapshot: SessionSnapshot;
}

interface HerdrResponse {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export class HerdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

export class HerdrApiError extends HerdrError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`herdr API error (${code}): ${message}`);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

export class HerdrProtocolError extends HerdrError {
  constructor(message: string) {
    super(`invalid herdr API response: ${message}`);
    this.name = "HerdrProtocolError";
  }
}

export class HerdrConnectionError extends HerdrError {
  constructor(message: string) {
    super(`herdr socket connection failed: ${message}`);
    this.name = "HerdrConnectionError";
  }
}

export function defaultHerdrSocketPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "herdr", "herdr.sock");
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

function normalizeOptions(options: HerdrClientOptions | string | undefined): HerdrClientOptions {
  return typeof options === "string" ? { socketPath: options } : (options ?? {});
}

export class HerdrClient {
  readonly socketPath: string;

  private readonly timeoutMs: number | undefined;
  private readonly requestIdPrefix: string;
  private nextRequestId = 1;

  constructor(options?: HerdrClientOptions | string) {
    const normalized = normalizeOptions(options);
    if (normalized.timeoutMs !== undefined &&
        (!Number.isFinite(normalized.timeoutMs) || normalized.timeoutMs <= 0)) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }

    this.socketPath = normalized.socketPath ?? process.env.HERDR_SOCKET_PATH ?? defaultHerdrSocketPath();
    this.timeoutMs = normalized.timeoutMs;
    this.requestIdPrefix = normalized.requestIdPrefix ?? "gis";
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method.length === 0) {
      throw new TypeError("herdr API method must not be empty");
    }

    const id = `${this.requestIdPrefix}:${this.nextRequestId++}`;
    const request = `${JSON.stringify({ id, method, params })}\n`;
    const response = await this.exchange(request);

    if (response.id !== id) {
      throw new HerdrProtocolError(`response id ${String(response.id)} does not match request ${id}`);
    }

    if (response.error !== undefined) {
      const code = typeof response.error.code === "string" ? response.error.code : "unknown";
      const message = typeof response.error.message === "string"
        ? response.error.message
        : "unknown herdr API error";
      throw new HerdrApiError(code, message);
    }

    if (!("result" in response)) {
      throw new HerdrProtocolError("response did not contain result or error");
    }

    return response.result as T;
  }

  worktreeCreate(options: WorktreeCreateOptions): Promise<WorktreeCreatedResult> {
    const params: Record<string, unknown> = { branch: options.branch };
    addIfDefined(params, "base", options.base);
    addIfDefined(params, "cwd", options.cwd);
    addIfDefined(params, "path", options.path);
    addIfDefined(params, "label", options.label);
    addIfDefined(params, "focus", options.focus);
    addIfDefined(params, "workspace_id", options.workspaceId);
    return this.request<WorktreeCreatedResult>("worktree.create", params);
  }

  worktreeRemove(
    workspaceId: string,
    options: WorktreeRemoveOptions = {},
  ): Promise<WorktreeRemovedResult> {
    const params: Record<string, unknown> = { workspace_id: workspaceId };
    addIfDefined(params, "force", options.force);
    return this.request<WorktreeRemovedResult>("worktree.remove", params);
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
    const options: AgentStartOptions = typeof optionsOrName === "string"
      ? { name: optionsOrName, kind: kind!, paneId: paneId!, args, timeoutMs }
      : optionsOrName;
    const params: Record<string, unknown> = {
      name: options.name,
      kind: options.kind,
      pane_id: options.paneId,
    };
    addIfDefined(params, "args", options.args === undefined ? undefined : [...options.args]);
    addIfDefined(params, "timeout_ms", options.timeoutMs);
    return this.request<AgentStartedResult>("agent.start", params);
  }

  agentPrompt(
    target: string,
    text: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentPromptedResult> {
    const params: Record<string, unknown> = { target, text };
    if (options.wait !== undefined) {
      const wait: Record<string, unknown> = {};
      addIfDefined(wait, "until", options.wait.until === undefined ? undefined : [...options.wait.until]);
      addIfDefined(wait, "timeout_ms", options.wait.timeoutMs);
      params.wait = wait;
    }
    return this.request<AgentPromptedResult>("agent.prompt", params);
  }

  agentWait(target: string, options: AgentWaitOptions = {}): Promise<AgentWaitResult> {
    const params: Record<string, unknown> = {
      target,
      until: options.until === undefined ? ["done", "blocked"] : [...options.until],
    };
    addIfDefined(params, "timeout_ms", options.timeoutMs);
    return this.request<AgentWaitResult>("agent.wait", params);
  }

  agentRead(target: string, options: AgentReadOptions = {}): Promise<AgentReadResult> {
    const params: Record<string, unknown> = {
      target,
      source: options.source ?? "recent",
      format: options.format ?? "text",
      strip_ansi: options.stripAnsi ?? true,
    };
    addIfDefined(params, "lines", options.lines);
    return this.request<AgentReadResult>("agent.read", params);
  }

  apiSnapshot(): Promise<SessionSnapshotResult> {
    return this.request<SessionSnapshotResult>("session.snapshot", {});
  }

  snapshot(): Promise<SessionSnapshotResult> {
    return this.apiSnapshot();
  }

  private exchange(request: string): Promise<HerdrResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
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
        reject(new HerdrConnectionError(error instanceof Error ? error.message : String(error)));
        return;
      }

      if (this.timeoutMs !== undefined) {
        socket.setTimeout(this.timeoutMs, () => {
          fail(new HerdrConnectionError(`timed out after ${this.timeoutMs}ms`));
        });
      }

      socket.once("connect", () => {
        try {
          socket.write(request);
        } catch (error) {
          fail(new HerdrConnectionError(error instanceof Error ? error.message : String(error)));
        }
      });

      socket.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }

        const line = buffer.slice(0, newline).trim();
        if (line.length === 0) {
          fail(new HerdrProtocolError("response line was empty"));
          return;
        }

        let response: HerdrResponse;
        try {
          response = JSON.parse(line) as HerdrResponse;
        } catch (error) {
          fail(new HerdrProtocolError(error instanceof Error ? error.message : String(error)));
          return;
        }

        if (response === null || typeof response !== "object") {
          fail(new HerdrProtocolError("response was not an object"));
          return;
        }
        finish(() => resolve(response));
      });

      socket.once("end", () => {
        if (buffer.trim().length > 0 && !settled) {
          let response: HerdrResponse;
          try {
            response = JSON.parse(buffer.trim()) as HerdrResponse;
          } catch (error) {
            fail(new HerdrProtocolError(error instanceof Error ? error.message : String(error)));
            return;
          }
          if (response === null || typeof response !== "object") {
            fail(new HerdrProtocolError("response was not an object"));
            return;
          }
          finish(() => resolve(response));
          return;
        }
        fail(new HerdrConnectionError("socket closed before a response was received"));
      });

      socket.once("error", (error: Error) => {
        fail(new HerdrConnectionError(error.message));
      });
    });
  }
}

export class HerdrAdapter extends HerdrClient {}

export function createHerdrAdapter(options?: HerdrClientOptions | string): HerdrAdapter {
  return new HerdrAdapter(options);
}
