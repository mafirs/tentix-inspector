import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRunConfig, CodexSandbox } from './types';

const DEFAULT_CODEX_BIN = 'codex';
const DEFAULT_CLAUDE_BIN = 'claude';
const DEFAULT_CODEX_SANDBOX: CodexSandbox = 'workspace-write';
const DEFAULT_AGENT_CHILD_BIN_DIR = path.join(os.homedir(), '.local', 'share', 'tentix-codex', 'bin');
const DEFAULT_AGENT_CHILD_PATH = [
  DEFAULT_AGENT_CHILD_BIN_DIR,
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].join(path.delimiter);
const DEFAULT_AGENT_READONLY_KUBECTL_COMMAND = 'kubectl-ByAgent-READONLY';
const DEFAULT_CODEX_WORKSPACE_NETWORK_ACCESS = true;
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_AGENT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_AGENT_MAX_PENDING_RUNS = 4;
const DEFAULT_AGENT_PENDING_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_OUTPUT_TRUNCATE_CHARS = 1_000;

export function getAgentRunConfig(): AgentRunConfig {
  return {
    codexBinary: (process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN).trim() || DEFAULT_CODEX_BIN,
    claudeBinary: (process.env.CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN).trim() || DEFAULT_CLAUDE_BIN,
    agentChildPath: (process.env.AGENT_CHILD_PATH ?? DEFAULT_AGENT_CHILD_PATH).trim(),
    readonlyKubectlCommand: (
      process.env.AGENT_READONLY_KUBECTL_COMMAND ?? DEFAULT_AGENT_READONLY_KUBECTL_COMMAND
    ).trim(),
    inspectWorkdir: (process.env.AGENT_INSPECT_WORKDIR ?? '').trim(),
    codexHome: (process.env.CODEX_HOME ?? '').trim(),
    skill: (process.env.AGENT_INSPECT_SKILL ?? '').trim(),
    codexSandbox: getCodexSandbox(),
    codexWorkspaceNetworkAccess: getBooleanEnv(
      'CODEX_WORKSPACE_NETWORK_ACCESS',
      DEFAULT_CODEX_WORKSPACE_NETWORK_ACCESS
    ),
    timeoutMs: getPositiveIntegerEnv('AGENT_RUN_TIMEOUT_MS', DEFAULT_AGENT_RUN_TIMEOUT_MS),
    maxConcurrentRuns: getPositiveIntegerEnv(
      'AGENT_MAX_CONCURRENT_RUNS',
      DEFAULT_AGENT_MAX_CONCURRENT_RUNS
    ),
    maxPendingRuns: getNonNegativeIntegerEnv(
      'AGENT_MAX_PENDING_RUNS',
      DEFAULT_AGENT_MAX_PENDING_RUNS
    ),
    pendingTimeoutMs: getPositiveIntegerEnv(
      'AGENT_PENDING_TIMEOUT_MS',
      DEFAULT_AGENT_PENDING_TIMEOUT_MS
    ),
    outputTruncateChars: getPositiveIntegerEnv(
      'AGENT_OUTPUT_TRUNCATE_CHARS',
      DEFAULT_AGENT_OUTPUT_TRUNCATE_CHARS
    ),
    tempRoot: path.join(os.tmpdir(), 'tentix-agent-runs'),
  };
}

export function validateCodexRunConfig(config: AgentRunConfig): string {
  const agentConfigError = validateAgentRunConfig(config);
  if (agentConfigError) {
    return agentConfigError;
  }
  if (!config.codexHome) {
    return 'CODEX_HOME is required';
  }
  if (!fs.existsSync(config.codexHome) || !fs.statSync(config.codexHome).isDirectory()) {
    return `CODEX_HOME is not a directory: ${config.codexHome}`;
  }
  return '';
}

export function validateAgentRunConfig(config: AgentRunConfig): string {
  if (!config.inspectWorkdir) {
    return 'AGENT_INSPECT_WORKDIR is required';
  }
  if (!fs.existsSync(config.inspectWorkdir) || !fs.statSync(config.inspectWorkdir).isDirectory()) {
    return `AGENT_INSPECT_WORKDIR is not a directory: ${config.inspectWorkdir}`;
  }
  if (!config.agentChildPath) {
    return 'AGENT_CHILD_PATH is required';
  }
  const invalidAgentChildPathEntry = getInvalidPathDirectory(config.agentChildPath);
  if (invalidAgentChildPathEntry) {
    return `AGENT_CHILD_PATH contains a non-directory entry: ${invalidAgentChildPathEntry}`;
  }
  if (!config.readonlyKubectlCommand) {
    return 'AGENT_READONLY_KUBECTL_COMMAND is required';
  }
  if (!/^[A-Za-z0-9._-]+$/.test(config.readonlyKubectlCommand)) {
    return `AGENT_READONLY_KUBECTL_COMMAND is unsafe: ${config.readonlyKubectlCommand}`;
  }
  if (config.readonlyKubectlCommand === 'kubectl') {
    return 'AGENT_READONLY_KUBECTL_COMMAND must not be kubectl';
  }
  const exposedKubectlPath = getExecutableInPath(config.agentChildPath, 'kubectl');
  if (exposedKubectlPath) {
    return `AGENT_CHILD_PATH exposes kubectl: ${exposedKubectlPath}`;
  }
  const readonlyKubectlPath = getExecutableInPath(
    config.agentChildPath,
    config.readonlyKubectlCommand
  );
  if (!readonlyKubectlPath) {
    return `AGENT_CHILD_PATH does not expose ${config.readonlyKubectlCommand}`;
  }
  if (!config.skill) {
    return 'AGENT_INSPECT_SKILL is required';
  }
  return '';
}

function getInvalidPathDirectory(pathValue: string): string {
  for (const entry of pathValue.split(path.delimiter)) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) {
      return '<empty>';
    }
    if (!fs.existsSync(trimmedEntry) || !fs.statSync(trimmedEntry).isDirectory()) {
      return trimmedEntry;
    }
  }

  return '';
}

function getExecutableInPath(pathValue: string, executableName: string): string {
  for (const entry of pathValue.split(path.delimiter)) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) {
      continue;
    }
    const candidate = path.join(trimmedEntry, executableName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return '';
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) {
    return fallback;
  }
  if (rawValue === 'true' || rawValue === '1') {
    return true;
  }
  if (rawValue === 'false' || rawValue === '0') {
    return false;
  }

  console.error(`[Codex] invalid ${name}="${rawValue}", fallback to ${fallback}`);
  return fallback;
}

function getCodexSandbox(): CodexSandbox {
  const rawValue = (process.env.CODEX_SANDBOX ?? DEFAULT_CODEX_SANDBOX).trim();
  if (
    rawValue === 'read-only' ||
    rawValue === 'workspace-write' ||
    rawValue === 'danger-full-access'
  ) {
    return rawValue;
  }

  console.error(`[Codex] invalid CODEX_SANDBOX="${rawValue}", fallback to ${DEFAULT_CODEX_SANDBOX}`);
  return DEFAULT_CODEX_SANDBOX;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  console.error(`[Codex] invalid ${name}="${rawValue}", fallback to ${fallback}`);
  return fallback;
}

function getNonNegativeIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }

  console.error(`[Codex] invalid ${name}="${rawValue}", fallback to ${fallback}`);
  return fallback;
}
