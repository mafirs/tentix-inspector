import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexRunConfig, CodexSandbox } from './types';

const DEFAULT_CODEX_BIN = 'codex';
const DEFAULT_CODEX_SANDBOX: CodexSandbox = 'workspace-write';
const DEFAULT_CODEX_WORKSPACE_NETWORK_ACCESS = true;
const DEFAULT_CODEX_RUN_TIMEOUT_MS = 600_000;
const DEFAULT_CODEX_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_CODEX_MAX_PENDING_RUNS = 4;
const DEFAULT_CODEX_PENDING_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_OUTPUT_TRUNCATE_CHARS = 1_000;

export function getCodexRunConfig(): CodexRunConfig {
  return {
    binary: (process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN).trim() || DEFAULT_CODEX_BIN,
    inspectWorkdir: (process.env.CODEX_INSPECT_WORKDIR ?? '').trim(),
    codexHome: (process.env.CODEX_HOME ?? '').trim(),
    skill: (process.env.CODEX_INSPECT_SKILL ?? '').trim(),
    sandbox: getCodexSandbox(),
    workspaceNetworkAccess: getBooleanEnv(
      'CODEX_WORKSPACE_NETWORK_ACCESS',
      DEFAULT_CODEX_WORKSPACE_NETWORK_ACCESS
    ),
    timeoutMs: getPositiveIntegerEnv('CODEX_RUN_TIMEOUT_MS', DEFAULT_CODEX_RUN_TIMEOUT_MS),
    maxConcurrentRuns: getPositiveIntegerEnv(
      'CODEX_MAX_CONCURRENT_RUNS',
      DEFAULT_CODEX_MAX_CONCURRENT_RUNS
    ),
    maxPendingRuns: getNonNegativeIntegerEnv(
      'CODEX_MAX_PENDING_RUNS',
      DEFAULT_CODEX_MAX_PENDING_RUNS
    ),
    pendingTimeoutMs: getPositiveIntegerEnv(
      'CODEX_PENDING_TIMEOUT_MS',
      DEFAULT_CODEX_PENDING_TIMEOUT_MS
    ),
    outputTruncateChars: getPositiveIntegerEnv(
      'CODEX_OUTPUT_TRUNCATE_CHARS',
      DEFAULT_CODEX_OUTPUT_TRUNCATE_CHARS
    ),
    tempRoot: path.join(os.tmpdir(), 'tentix-codex-runs'),
  };
}

export function validateCodexRunConfig(config: CodexRunConfig): string {
  if (!config.inspectWorkdir) {
    return 'CODEX_INSPECT_WORKDIR is required';
  }
  if (!fs.existsSync(config.inspectWorkdir) || !fs.statSync(config.inspectWorkdir).isDirectory()) {
    return `CODEX_INSPECT_WORKDIR is not a directory: ${config.inspectWorkdir}`;
  }
  if (!config.codexHome) {
    return 'CODEX_HOME is required';
  }
  if (!fs.existsSync(config.codexHome) || !fs.statSync(config.codexHome).isDirectory()) {
    return `CODEX_HOME is not a directory: ${config.codexHome}`;
  }
  if (!config.skill) {
    return 'CODEX_INSPECT_SKILL is required';
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
