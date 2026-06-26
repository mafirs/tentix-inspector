import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCodexRunConfig, validateCodexRunConfig } from './config';
import {
  CodexEventSummary,
  CodexInspectRequest,
  CodexInspectResult,
  CodexRunConfig,
  CodexRunStatus,
} from './types';

export type { CodexInspectRequest } from './types';

type SlotRelease = () => void;
type PendingRun = {
  resolve: (release: SlotRelease | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  finalText: string;
  eventSummary: CodexEventSummary;
};

let activeCodexRuns = 0;
const pendingCodexRuns: PendingRun[] = [];

export async function runCodexInspection(input: CodexInspectRequest): Promise<CodexInspectResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const config = getCodexRunConfig();
  const eventSummary = createEmptyEventSummary();

  if (input.inputError) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: 'invalid_input',
      reason: input.inputError,
      eventSummary,
    });
  }

  if (!input.requestKubeconfig) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: 'invalid_input',
      reason: 'request kubeconfig is required',
      eventSummary,
    });
  }

  const configError = validateCodexRunConfig(config);
  if (configError) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: 'invalid_config',
      reason: configError,
      eventSummary,
    });
  }

  const release = await acquireCodexSlot(config);
  if (!release) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: pendingCodexRuns.length >= config.maxPendingRuns ? 'pool_full' : 'pending_timeout',
      reason: 'codex run queue unavailable',
      eventSummary,
    });
  }

  let runDir = '';
  try {
    await fs.mkdir(config.tempRoot, { recursive: true, mode: 0o700 });
    runDir = await fs.mkdtemp(path.join(config.tempRoot, `${runId}-`));
    const kubeconfigPath = path.join(runDir, 'kubeconfig');
    await fs.writeFile(kubeconfigPath, input.requestKubeconfig, { mode: 0o600 });

    const runWorkdir = path.join(runDir, 'workspace');
    await fs.mkdir(runWorkdir, { recursive: true, mode: 0o700 });

    const childResult = await runCodexChild({
      runId,
      input,
      config,
      kubeconfigPath,
      runWorkdir,
    });

    const status = getStatusFromChildResult(childResult);
    const text = childResult.finalText.trim() || getFallbackText(status, runId);
    logCodexRun({
      runId,
      input,
      config,
      startedAt,
      status,
      reason: '',
      exitCode: childResult.exitCode,
      signal: childResult.signal,
      finalTextLength: childResult.finalText.length,
      eventSummary: childResult.eventSummary,
    });

    return { runId, status, text };
  } catch (error) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: 'spawn_failed',
      reason: getErrorMessage(error),
      eventSummary,
    });
  } finally {
    release();
    if (runDir) {
      await fs.rm(runDir, { recursive: true, force: true }).catch((error) => {
        console.error('[Codex] temp cleanup failed:', {
          runId,
          error: getErrorMessage(error),
        });
      });
    }
  }
}

async function runCodexChild(args: {
  runId: string;
  input: CodexInspectRequest;
  config: CodexRunConfig;
  kubeconfigPath: string;
  runWorkdir: string;
}): Promise<ChildResult> {
  const { runId, input, config, kubeconfigPath, runWorkdir } = args;
  const eventSummary = createEmptyEventSummary();
  const childEnv = buildCodexProcessEnv(config, kubeconfigPath);
  const codexArgs = buildCodexArgs(config, runWorkdir, childEnv);
  const child = spawn(config.binary, codexArgs, {
    cwd: runWorkdir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let finalText = '';
  let settled = false;
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      const parsedText = handleCodexJsonlLine(line, eventSummary, config.outputTruncateChars);
      if (parsedText) {
        finalText = parsedText;
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    eventSummary.lastStderr = truncate(chunk, config.outputTruncateChars);
  });

  child.stdin.end(buildCodexPrompt(input, config), 'utf8');

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5_000);
    }, config.timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      eventSummary.lastError = truncate(getErrorMessage(error), config.outputTruncateChars);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        finalText,
        eventSummary,
      });
    });

    child.once('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      settled = true;
      const trailingLine = stdoutBuffer.trim();
      if (trailingLine) {
        const parsedText = handleCodexJsonlLine(
          trailingLine,
          eventSummary,
          config.outputTruncateChars
        );
        if (parsedText) {
          finalText = parsedText;
        }
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        finalText,
        eventSummary,
      });
    });

    console.error('[Codex] run spawned:', {
      runId,
      pid: child.pid ?? null,
      zone: input.zone,
      namespace: input.namespace,
      ticketId: input.ticketId,
      sandbox: config.sandbox,
      runWorkdir,
      inspectWorkdir: config.inspectWorkdir,
    });
  });
}

function buildCodexArgs(
  config: CodexRunConfig,
  runWorkdir: string,
  childEnv: NodeJS.ProcessEnv
): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    config.sandbox,
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    `shell_environment_policy.set=${toTomlInlineStringMap(childEnv)}`,
    '--skip-git-repo-check',
    '-C',
    runWorkdir,
  ];

  if (config.sandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(config.workspaceNetworkAccess)}`);
  }

  args.push('-');
  return args;
}

function buildCodexProcessEnv(
  config: CodexRunConfig,
  kubeconfigPath: string
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CODEX_HOME: config.codexHome,
    CODEX_INSPECT_WORKDIR: config.inspectWorkdir,
    KUBECONFIG: kubeconfigPath,
    BYAGENT_KUBECONFIG: kubeconfigPath,
  };

  return childEnv;
}

function buildCodexPrompt(input: CodexInspectRequest, config: CodexRunConfig): string {
  return [
    `$${config.skill}`,
    '',
    '请按该 skill 的 SOP 处理下面的 Tentix 工单诊断请求。',
    '只能使用 ByAgent 暴露的只读集群查询能力，不要直接调用原生 kubectl。',
    `诊断资料目录: ${config.inspectWorkdir}`,
    '诊断资料目录只用于读取 Sealos 源码、知识库和操作守则；临时文件只写入当前工作目录。',
    '最终只输出给 Tentix 参考的诊断结论纯文本，不要输出 JSON，不要输出 Markdown 表格。',
    '',
    `zone: ${input.zone}`,
    `namespace: ${input.namespace}`,
    `ticketId: ${input.ticketId}`,
    `ticketTitle: ${input.ticketTitle}`,
    `ticketModule: ${input.ticketModule}`,
    `ticketCategory: ${input.ticketCategory}`,
    `ticketDescription: ${input.ticketDescription}`,
    `historyMessages: ${input.historyMessages}`,
    `latestMessage: ${input.latestMessage}`,
    `latestMessageImages: ${input.latestMessageImages.join('\n')}`,
  ].join('\n');
}

function toTomlInlineStringMap(values: NodeJS.ProcessEnv): string {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function handleCodexJsonlLine(
  line: string,
  eventSummary: CodexEventSummary,
  truncateChars: number
): string {
  if (!line) {
    return '';
  }

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    eventSummary.anomalies += 1;
    return '';
  }

  if (!isRecord(raw)) {
    eventSummary.anomalies += 1;
    return '';
  }

  if (typeof raw.thread_id === 'string') {
    eventSummary.threadId = raw.thread_id;
  }

  if (typeof raw.message === 'string') {
    return raw.message;
  }
  if (typeof raw.text === 'string') {
    return raw.text;
  }

  const item = isRecord(raw.item) ? raw.item : null;
  if (!item) {
    return '';
  }

  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return item.text;
  }

  if (item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const output =
      typeof item.output === 'string'
        ? item.output
        : typeof item.aggregated_output === 'string'
          ? item.aggregated_output
          : typeof item.stdout === 'string'
            ? item.stdout
            : '';
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0;

    eventSummary.commandCount += 1;
    eventSummary.commands.push({
      command: truncate(command, truncateChars),
      output: truncate(output, truncateChars),
      isError: exitCode !== 0,
    });
  }

  return '';
}

function getStatusFromChildResult(result: ChildResult): CodexRunStatus {
  if (result.timedOut) {
    return 'timeout';
  }
  if (result.exitCode !== 0) {
    return 'codex_failed';
  }
  if (!result.finalText.trim()) {
    return 'no_final_message';
  }
  return 'success';
}

async function acquireCodexSlot(config: CodexRunConfig): Promise<SlotRelease | null> {
  if (activeCodexRuns < config.maxConcurrentRuns) {
    activeCodexRuns += 1;
    return createCodexSlotRelease();
  }

  if (pendingCodexRuns.length >= config.maxPendingRuns) {
    return null;
  }

  return await new Promise((resolve) => {
    const pendingRun: PendingRun = {
      resolve,
      timer: setTimeout(() => {
        const index = pendingCodexRuns.indexOf(pendingRun);
        if (index >= 0) {
          pendingCodexRuns.splice(index, 1);
        }
        resolve(null);
      }, config.pendingTimeoutMs),
    };
    pendingCodexRuns.push(pendingRun);
  });
}

function createCodexSlotRelease(): SlotRelease {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeCodexRuns = Math.max(activeCodexRuns - 1, 0);
    const next = pendingCodexRuns.shift();
    if (!next) {
      return;
    }
    clearTimeout(next.timer);
    activeCodexRuns += 1;
    next.resolve(createCodexSlotRelease());
  };
}

function finishWithoutSpawn(args: {
  runId: string;
  input: CodexInspectRequest;
  config: CodexRunConfig;
  startedAt: number;
  status: CodexRunStatus;
  reason: string;
  eventSummary: CodexEventSummary;
}): CodexInspectResult {
  logCodexRun({
    ...args,
    exitCode: null,
    signal: null,
    finalTextLength: 0,
  });
  return {
    runId: args.runId,
    status: args.status,
    text: getFallbackText(args.status, args.runId),
  };
}

function getFallbackText(status: CodexRunStatus, runId: string): string {
  if (status === 'timeout') {
    return `自动诊断超时，未生成可用结论。runId=${runId}`;
  }
  if (status === 'pool_full' || status === 'pending_timeout') {
    return `自动诊断当前繁忙，未生成可用结论。runId=${runId}`;
  }
  if (status === 'spawn_failed' || status === 'invalid_config') {
    return `自动诊断服务暂不可用，未生成可用结论。runId=${runId}`;
  }
  return `自动诊断未生成有效结论。runId=${runId}`;
}

function logCodexRun(args: {
  runId: string;
  input: CodexInspectRequest;
  config: CodexRunConfig;
  startedAt: number;
  status: CodexRunStatus;
  reason: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalTextLength: number;
  eventSummary: CodexEventSummary;
}): void {
  console.error('[Codex] run completed:', JSON.stringify({
    runId: args.runId,
    ticketId: args.input.ticketId,
    zone: args.input.zone,
    namespace: args.input.namespace,
    status: args.status,
    reason: args.reason,
    exitCode: args.exitCode,
    signal: args.signal,
    durationMs: Date.now() - args.startedAt,
    finalTextLength: args.finalTextLength,
    sandbox: args.config.sandbox,
    inspectWorkdir: args.config.inspectWorkdir,
    hasKubeconfig: Boolean(args.input.requestKubeconfig),
    eventSummary: args.eventSummary,
  }));
}

function createEmptyEventSummary(): CodexEventSummary {
  return {
    commandCount: 0,
    commands: [],
    anomalies: 0,
    lastError: '',
    lastStderr: '',
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
