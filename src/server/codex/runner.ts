import { randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getAgentRunConfig, validateCodexRunConfig } from './config';
import {
  AgentRunConfig,
  CodexEventSummary,
  CodexInspectRequest,
  CodexInspectResult,
  CodexRunStatus,
} from './types';

export type { CodexInspectRequest } from './types';

type SlotRelease = () => void;
type PendingRun = {
  resolve: (release: SlotRelease | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CodexLiveLogContext = {
  runId: string;
  input: CodexInspectRequest;
  config: AgentRunConfig;
  startedAt: number;
  itemStarts: Map<string, number>;
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
  const config = getAgentRunConfig();
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
  config: AgentRunConfig;
  kubeconfigPath: string;
  runWorkdir: string;
}): Promise<ChildResult> {
  const { runId, input, config, kubeconfigPath, runWorkdir } = args;
  const eventSummary = createEmptyEventSummary();
  const childEnv = buildCodexProcessEnv(config, kubeconfigPath, input.namespace);
  const codexArgs = buildCodexArgs(config, runWorkdir, childEnv);
  const codexBinary = await resolveExecutablePath(config.codexBinary);
  const childStartedAt = Date.now();
  const child = spawn(codexBinary, codexArgs, {
    cwd: runWorkdir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const liveLogContext: CodexLiveLogContext = {
    runId,
    input,
    config,
    startedAt: childStartedAt,
    itemStarts: new Map(),
  };

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
      const parsedText = handleCodexJsonlLine(
        line,
        eventSummary,
        config.outputTruncateChars,
        liveLogContext
      );
      if (parsedText) {
        finalText = parsedText;
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const stderrText = truncate(chunk.trim(), config.outputTruncateChars);
    eventSummary.lastStderr = stderrText;
    logCodexLiveLine(liveLogContext, 'stderr', stderrText);
  });

  child.stdin.end(buildCodexPrompt(input, config), 'utf8');

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      logCodexLiveLine(
        liveLogContext,
        'timeout',
        `terminating codex after ${formatDuration(config.timeoutMs)}`
      );
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
      logCodexLiveLine(liveLogContext, 'process error', eventSummary.lastError);
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
          config.outputTruncateChars,
          liveLogContext
        );
        if (parsedText) {
          finalText = parsedText;
        }
      }
      logCodexLiveLine(
        liveLogContext,
        'process exited',
        `exitCode=${exitCode ?? 'null'} signal=${signal ?? 'null'}`
      );
      resolve({
        exitCode,
        signal,
        timedOut,
        finalText,
        eventSummary,
      });
    });

    logCodexRunStart(liveLogContext, child.pid ?? null, runWorkdir);
  });
}

function buildCodexArgs(
  config: AgentRunConfig,
  runWorkdir: string,
  childEnv: NodeJS.ProcessEnv
): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    config.codexSandbox,
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

  if (config.codexSandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(config.codexWorkspaceNetworkAccess)}`);
  }

  args.push('-');
  return args;
}

function buildCodexProcessEnv(
  config: AgentRunConfig,
  kubeconfigPath: string,
  targetNamespace: string
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: config.agentChildPath,
    HOME: process.env.HOME ?? '',
    CODEX_HOME: config.codexHome,
    AGENT_INSPECT_WORKDIR: config.inspectWorkdir,
    AGENT_READONLY_KUBECTL_COMMAND: config.readonlyKubectlCommand,
    AGENT_TARGET_NAMESPACE: targetNamespace,
    KUBECONFIG: kubeconfigPath,
  };

  return childEnv;
}

function buildCodexPrompt(input: CodexInspectRequest, config: AgentRunConfig): string {
  const readonlyKubectlCommand = config.readonlyKubectlCommand;
  return [
    `$${config.skill}`,
    '',
    '请按该 skill 的 SOP 处理下面的 Tentix 工单诊断请求。',
    `Kubernetes 查询只能使用本项目命令: ${readonlyKubectlCommand}`,
    `命令格式: ${readonlyKubectlCommand} <readonly-subcommand> ...`,
    `只能查询当前用户 namespace: ${input.namespace}`,
    '禁止使用 -A / --all-namespaces，禁止查询 nodes、pv、namespaces 等集群级资源。',
    '不要调用原生 kubectl。',
    '允许的 Kubernetes 子命令: get, describe, logs, top, exec；所有命令必须带当前 namespace。',
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

async function resolveExecutablePath(binary: string): Promise<string> {
  if (hasPathSeparator(binary)) {
    return binary;
  }

  const parentPath = process.env.PATH ?? '';
  for (const entry of parentPath.split(path.delimiter)) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) {
      continue;
    }

    const candidate = path.join(trimmedEntry, binary);
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  return binary;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
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
  truncateChars: number,
  logContext: CodexLiveLogContext
): string {
  if (!line) {
    return '';
  }

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    eventSummary.anomalies += 1;
    logCodexLiveLine(logContext, 'event warning', 'ignored invalid JSONL event');
    return '';
  }

  if (!isRecord(raw)) {
    eventSummary.anomalies += 1;
    logCodexLiveLine(logContext, 'event warning', 'ignored non-object JSONL event');
    return '';
  }

  const eventType = getStringValue(raw, 'type');

  if (typeof raw.thread_id === 'string') {
    eventSummary.threadId = raw.thread_id;
  }

  logCodexLifecycleEvent(eventType, raw, logContext, truncateChars);

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

  logCodexItemEvent(eventType, item, logContext, truncateChars);

  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return item.text;
  }

  if (item.type === 'command_execution' && eventType !== 'item.started') {
    const command = typeof item.command === 'string' ? item.command : '';
    const output = getCommandOutput(item);
    const exitCode = getExitCode(item) ?? 0;

    eventSummary.commandCount += 1;
    eventSummary.commands.push({
      command: truncate(command, truncateChars),
      output: truncate(output, truncateChars),
      isError: exitCode !== 0,
    });
  }

  return '';
}

function logCodexRunStart(
  context: CodexLiveLogContext,
  pid: number | null,
  runWorkdir: string
): void {
  console.error([
    `[Codex][${context.runId}] run started`,
    `  pid: ${pid ?? 'unknown'}`,
    `  ticketId: ${context.input.ticketId}`,
    `  zone: ${context.input.zone}`,
    `  namespace: ${context.input.namespace}`,
    `  sandbox: ${context.config.codexSandbox}`,
    `  runWorkdir: ${runWorkdir}`,
    `  inspectWorkdir: ${context.config.inspectWorkdir}`,
    `  readonlyKubectlCommand: ${context.config.readonlyKubectlCommand}`,
  ].join('\n'));
}

function logCodexLifecycleEvent(
  eventType: string,
  raw: Record<string, unknown>,
  context: CodexLiveLogContext,
  truncateChars: number
): void {
  if (eventType === 'thread.started') {
    logCodexLiveLine(context, 'thread started', getStringValue(raw, 'thread_id'));
    return;
  }
  if (eventType === 'turn.started') {
    logCodexLiveLine(context, 'turn started', 'codex started processing');
    return;
  }
  if (eventType === 'turn.completed') {
    const usageText = getUsageText(raw);
    logCodexLiveLine(context, 'turn completed', usageText || 'codex turn completed');
    return;
  }
  if (eventType === 'turn.failed') {
    logCodexLiveLine(context, 'turn failed', truncate(getEventText(raw), truncateChars));
    return;
  }
  if (eventType === 'error') {
    logCodexLiveLine(context, 'error', truncate(getEventText(raw), truncateChars));
  }
}

function logCodexItemEvent(
  eventType: string,
  item: Record<string, unknown>,
  context: CodexLiveLogContext,
  truncateChars: number
): void {
  const itemType = getStringValue(item, 'type') || 'item';
  const itemId = getStringValue(item, 'id');

  if (eventType === 'item.started') {
    if (itemId) {
      context.itemStarts.set(itemId, Date.now());
    }
    if (itemType === 'command_execution') {
      logCodexLiveLine(
        context,
        'command started',
        truncate(getStringValue(item, 'command') || '<empty command>', truncateChars)
      );
      return;
    }
    logCodexLiveLine(
      context,
      `${formatItemType(itemType)} started`,
      truncate(getItemText(item) || 'started', truncateChars)
    );
    return;
  }

  if (eventType === 'item.completed') {
    const durationText = itemId ? getCompletedItemDuration(context, itemId) : '';
    if (itemType === 'command_execution') {
      logCodexCommandCompleted(item, context, durationText, truncateChars);
      return;
    }
    logCodexLiveLine(
      context,
      `${formatItemType(itemType)} completed`,
      truncate(getItemText(item) || `completed${durationText ? ` in ${durationText}` : ''}`, truncateChars)
    );
    return;
  }

  if (eventType.startsWith('item.')) {
    logCodexLiveLine(
      context,
      `${formatItemType(itemType)} ${eventType.slice('item.'.length)}`,
      truncate(getItemText(item) || eventType, truncateChars)
    );
  }
}

function logCodexCommandCompleted(
  item: Record<string, unknown>,
  context: CodexLiveLogContext,
  durationText: string,
  truncateChars: number
): void {
  const command = truncate(getStringValue(item, 'command') || '<empty command>', truncateChars);
  const output = truncate(getCommandOutput(item).trim(), truncateChars);
  const exitCode = getExitCode(item);
  const statusText = exitCode === null ? 'exit unknown' : `exit ${exitCode}`;
  const timingText = durationText ? ` in ${durationText}` : '';
  const outputText = output ? `\n  output:\n    ${indentMultiline(output)}` : '';
  logCodexLiveLine(
    context,
    'command completed',
    `${statusText}${timingText}: ${command}${outputText}`
  );
}

function logCodexLiveLine(
  context: CodexLiveLogContext,
  label: string,
  message: string
): void {
  const cleanMessage = message.trim();
  if (!cleanMessage) {
    return;
  }
  const elapsed = formatDuration(Date.now() - context.startedAt);
  console.error(`[Codex][${context.runId}][+${elapsed}] ${label}: ${indentMultiline(cleanMessage)}`);
}

function getCompletedItemDuration(context: CodexLiveLogContext, itemId: string): string {
  const startedAt = context.itemStarts.get(itemId);
  if (!startedAt) {
    return '';
  }
  context.itemStarts.delete(itemId);
  return formatDuration(Date.now() - startedAt);
}

function getCommandOutput(item: Record<string, unknown>): string {
  return (
    getStringValue(item, 'output') ||
    getStringValue(item, 'aggregated_output') ||
    getStringValue(item, 'stdout')
  );
}

function getExitCode(item: Record<string, unknown>): number | null {
  const exitCode = item.exit_code;
  return typeof exitCode === 'number' ? exitCode : null;
}

function getItemText(item: Record<string, unknown>): string {
  return (
    getStringValue(item, 'text') ||
    getStringValue(item, 'message') ||
    getStringValue(item, 'summary') ||
    getStringValue(item, 'title') ||
    getStringValue(item, 'name') ||
    getStringValue(item, 'query') ||
    getStringValue(item, 'status')
  );
}

function getEventText(raw: Record<string, unknown>): string {
  return (
    getStringValue(raw, 'message') ||
    getStringValue(raw, 'error') ||
    getStringValue(raw, 'error_message') ||
    getStringValue(raw, 'text')
  );
}

function getUsageText(raw: Record<string, unknown>): string {
  const usage = isRecord(raw.usage) ? raw.usage : null;
  if (!usage) {
    return '';
  }

  const parts = [
    getNumberPart(usage, 'input_tokens', 'input'),
    getNumberPart(usage, 'cached_input_tokens', 'cached'),
    getNumberPart(usage, 'output_tokens', 'output'),
    getNumberPart(usage, 'reasoning_output_tokens', 'reasoning'),
  ].filter(Boolean);
  return parts.length ? `usage: ${parts.join(', ')}` : '';
}

function getNumberPart(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  return typeof value === 'number' ? `${label}=${value}` : '';
}

function getStringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function formatItemType(itemType: string): string {
  return itemType.replace(/_/g, ' ');
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

async function acquireCodexSlot(config: AgentRunConfig): Promise<SlotRelease | null> {
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
  config: AgentRunConfig;
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
  config: AgentRunConfig;
  startedAt: number;
  status: CodexRunStatus;
  reason: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalTextLength: number;
  eventSummary: CodexEventSummary;
}): void {
  const lines = [
    `[Codex][${args.runId}] run completed`,
    `  ticketId: ${args.input.ticketId}`,
    `  zone: ${args.input.zone}`,
    `  namespace: ${args.input.namespace}`,
    `  status: ${args.status}`,
    `  exitCode: ${args.exitCode ?? 'null'}`,
    `  signal: ${args.signal ?? 'null'}`,
    `  duration: ${formatDuration(Date.now() - args.startedAt)}`,
    `  finalTextLength: ${args.finalTextLength}`,
    `  sandbox: ${args.config.codexSandbox}`,
    `  inspectWorkdir: ${args.config.inspectWorkdir}`,
    `  readonlyKubectlCommand: ${args.config.readonlyKubectlCommand}`,
    `  hasKubeconfig: ${Boolean(args.input.requestKubeconfig)}`,
    `  threadId: ${args.eventSummary.threadId ?? ''}`,
    `  commandCount: ${args.eventSummary.commandCount}`,
    `  anomalies: ${args.eventSummary.anomalies}`,
  ];

  if (args.reason) {
    lines.push(`  reason: ${args.reason}`);
  }
  if (args.eventSummary.lastError) {
    lines.push(`  lastError: ${indentMultiline(args.eventSummary.lastError)}`);
  }
  if (args.eventSummary.lastStderr) {
    lines.push(`  lastStderr: ${indentMultiline(args.eventSummary.lastStderr)}`);
  }
  if (args.eventSummary.commands.length) {
    lines.push('  commands:');
    for (const [index, command] of args.eventSummary.commands.slice(0, 10).entries()) {
      lines.push(`    ${index + 1}. ${command.isError ? 'failed' : 'ok'} ${command.command}`);
    }
    if (args.eventSummary.commands.length > 10) {
      lines.push(`    ... ${args.eventSummary.commands.length - 10} more`);
    }
  }

  console.error(lines.join('\n'));
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

function indentMultiline(value: string): string {
  return value.replace(/\r/g, '').replace(/\n/g, '\n  ');
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
