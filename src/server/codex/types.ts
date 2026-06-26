export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexRunStatus =
  | 'success'
  | 'timeout'
  | 'spawn_failed'
  | 'codex_failed'
  | 'no_final_message'
  | 'pool_full'
  | 'pending_timeout'
  | 'invalid_input'
  | 'invalid_config';

export interface CodexInspectRequest {
  zone: string;
  namespace: string;
  ticketId: string;
  ticketTitle: string;
  ticketModule: string;
  ticketCategory: string;
  ticketDescription: string;
  historyMessages: string;
  latestMessage: string;
  latestMessageImages: string[];
  requestKubeconfig?: string;
  retrievedContext?: unknown;
  inputError?: string;
}

export interface CodexRunConfig {
  binary: string;
  codexChildPath: string;
  readonlyKubectlCommand: string;
  inspectWorkdir: string;
  codexHome: string;
  skill: string;
  sandbox: CodexSandbox;
  workspaceNetworkAccess: boolean;
  timeoutMs: number;
  maxConcurrentRuns: number;
  maxPendingRuns: number;
  pendingTimeoutMs: number;
  outputTruncateChars: number;
  tempRoot: string;
}

export interface CodexCommandSummary {
  command: string;
  output: string;
  isError: boolean;
}

export interface CodexEventSummary {
  threadId?: string;
  commandCount: number;
  commands: CodexCommandSummary[];
  anomalies: number;
  lastError: string;
  lastStderr: string;
}

export interface CodexInspectResult {
  runId: string;
  status: CodexRunStatus;
  text: string;
}
