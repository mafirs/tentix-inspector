import { randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getAgentRunConfig, validateAgentRunConfig } from '../codex/config';
import {
  AgentRunConfig,
  CodexEventSummary,
  CodexInspectRequest,
  CodexInspectResult,
  CodexRunStatus,
} from '../codex/types';

const CLAUDE_SANDBOX_RUNNER = path.resolve(__dirname, '../../../scripts/run-claude-inspect-sandbox');
const CLAUDE_TOOLS = 'Bash,Read,Grep,Glob';
const CLAUDE_DISALLOWED_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch';

type SlotRelease = () => void;
type PendingRun = {
  resolve: (release: SlotRelease | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ClaudeLiveLogContext = {
  runId: string;
  input: CodexInspectRequest;
  config: AgentRunConfig;
  startedAt: number;
};

type ChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  finalText: string;
  eventSummary: CodexEventSummary;
};

let activeClaudeRuns = 0;
const pendingClaudeRuns: PendingRun[] = [];

export async function runClaudeInspection(input: CodexInspectRequest): Promise<CodexInspectResult> {
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

  const configError = validateAgentRunConfig(config);
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

  const release = await acquireClaudeSlot(config);
  if (!release) {
    return finishWithoutSpawn({
      runId,
      input,
      config,
      startedAt,
      status: pendingClaudeRuns.length >= config.maxPendingRuns ? 'pool_full' : 'pending_timeout',
      reason: 'claude run queue unavailable',
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

    const childResult = await runClaudeChild({
      runId,
      input,
      config,
      kubeconfigPath,
      runWorkdir,
    });

    const status = getStatusFromChildResult(childResult);
    const text = childResult.finalText.trim() || getFallbackText(status, runId);
    logClaudeRun({
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
        console.error('[Claude][Inspect] temp cleanup failed:', {
          runId,
          error: getErrorMessage(error),
        });
      });
    }
  }
}

async function runClaudeChild(args: {
  runId: string;
  input: CodexInspectRequest;
  config: AgentRunConfig;
  kubeconfigPath: string;
  runWorkdir: string;
}): Promise<ChildResult> {
  const { runId, input, config, kubeconfigPath, runWorkdir } = args;
  const eventSummary = createEmptyEventSummary();
  const childEnv = buildClaudeProcessEnv(config, kubeconfigPath, input.namespace);
  const claudeSkillPluginDir = getClaudeSkillPluginDir(config.inspectWorkdir);
  const claudeArgs = buildClaudeArgs(config, claudeSkillPluginDir);
  const claudeBinary = await resolveExecutablePath(config.claudeBinary);
  const childStartedAt = Date.now();
  const command = config.claudeUseBwrap
    ? await resolveExecutablePath(CLAUDE_SANDBOX_RUNNER)
    : claudeBinary;
  const commandArgs = config.claudeUseBwrap
    ? [
        runWorkdir,
        config.inspectWorkdir,
        claudeSkillPluginDir,
        kubeconfigPath,
        config.agentChildPath,
        claudeBinary,
        '--',
        ...claudeArgs,
      ]
    : claudeArgs;
  const child = spawn(command, commandArgs, {
    cwd: runWorkdir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const liveLogContext: ClaudeLiveLogContext = {
    runId,
    input,
    config,
    startedAt: childStartedAt,
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
      const parsedText = handleClaudeJsonlLine(
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
    logClaudeLiveLine(liveLogContext, 'stderr', stderrText);
  });

  child.stdin.end(buildClaudePrompt(input, config), 'utf8');

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      logClaudeLiveLine(
        liveLogContext,
        'timeout',
        `terminating claude after ${formatDuration(config.timeoutMs)}`
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
      logClaudeLiveLine(liveLogContext, 'process error', eventSummary.lastError);
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
        const parsedText = handleClaudeJsonlLine(
          trailingLine,
          eventSummary,
          config.outputTruncateChars,
          liveLogContext
        );
        if (parsedText) {
          finalText = parsedText;
        }
      }
      logClaudeLiveLine(
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

    logClaudeRunStart(liveLogContext, child.pid ?? null, runWorkdir);
  });
}

function buildClaudeArgs(config: AgentRunConfig, claudeSkillPluginDir: string): string[] {
  return [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'acceptEdits',
    '--tools',
    CLAUDE_TOOLS,
    '--allowedTools',
    `Bash(${config.readonlyKubectlCommand} *)`,
    'Read',
    'Grep',
    'Glob',
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS,
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--bare',
    '--plugin-dir',
    claudeSkillPluginDir,
    '--add-dir',
    config.inspectWorkdir,
  ];
}

function getClaudeSkillPluginDir(inspectWorkdir: string): string {
  if (path.basename(inspectWorkdir) === 'knowledge') {
    return path.dirname(inspectWorkdir);
  }
  return inspectWorkdir;
}

function buildClaudeProcessEnv(
  config: AgentRunConfig,
  kubeconfigPath: string,
  targetNamespace: string
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: config.agentChildPath,
    HOME: process.env.HOME ?? '',
    AGENT_INSPECT_WORKDIR: config.inspectWorkdir,
    AGENT_READONLY_KUBECTL_COMMAND: config.readonlyKubectlCommand,
    AGENT_TARGET_NAMESPACE: targetNamespace,
    KUBECONFIG: kubeconfigPath,
  };

  return childEnv;
}

function buildClaudePrompt(input: CodexInspectRequest, config: AgentRunConfig): string {
  const readonlyKubectlCommand = config.readonlyKubectlCommand;
  return [
    `/${config.skill}`,
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

function handleClaudeJsonlLine(
  line: string,
  eventSummary: CodexEventSummary,
  truncateChars: number,
  logContext: ClaudeLiveLogContext
): string {
  if (!line) {
    return '';
  }

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    eventSummary.anomalies += 1;
    logClaudeLiveLine(logContext, 'event warning', 'ignored invalid JSONL event');
    return '';
  }

  if (!isRecord(raw)) {
    eventSummary.anomalies += 1;
    logClaudeLiveLine(logContext, 'event warning', 'ignored non-object JSONL event');
    return '';
  }

  const eventType = getStringValue(raw, 'type');
  if (typeof raw.session_id === 'string') {
    eventSummary.threadId = raw.session_id;
  }
  logClaudeLifecycleEvent(eventType, raw, logContext, truncateChars);

  if (eventType === 'result') {
    return getStringValue(raw, 'result');
  }

  const message = isRecord(raw.message) ? raw.message : null;
  if (!message) {
    return '';
  }

  collectClaudeToolEvents(message, eventSummary, truncateChars, logContext);
  return getClaudeMessageText(message);
}

function collectClaudeToolEvents(
  message: Record<string, unknown>,
  eventSummary: CodexEventSummary,
  truncateChars: number,
  logContext: ClaudeLiveLogContext
): void {
  if (!Array.isArray(message.content)) {
    return;
  }

  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockType = getStringValue(block, 'type');
    if (blockType === 'tool_use') {
      const toolName = getStringValue(block, 'name');
      const input = isRecord(block.input) ? block.input : null;
      const command = input ? getStringValue(input, 'command') : '';
      if (toolName === 'Bash') {
        eventSummary.commandCount += 1;
        eventSummary.commands.push({
          command: truncate(command, truncateChars),
          output: '',
          isError: false,
        });
        logClaudeLiveLine(logContext, 'command started', truncate(command || '<empty command>', truncateChars));
      }
      continue;
    }

    if (blockType === 'tool_result') {
      const lastCommand = eventSummary.commands[eventSummary.commands.length - 1];
      if (!lastCommand) {
        continue;
      }
      const output = getClaudeContentText(block.content);
      lastCommand.output = truncate(output, truncateChars);
      lastCommand.isError = block.is_error === true;
      logClaudeLiveLine(
        logContext,
        'command completed',
        `${lastCommand.isError ? 'failed' : 'ok'} ${lastCommand.command}`
      );
    }
  }
}

function getClaudeMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  return getClaudeContentText(content);
}

function getClaudeContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }
      if (typeof block.text === 'string') {
        return block.text;
      }
      if (typeof block.content === 'string') {
        return block.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function logClaudeRunStart(
  context: ClaudeLiveLogContext,
  pid: number | null,
  runWorkdir: string
): void {
  console.error([
    `[Claude][Inspect][${context.runId}] run started`,
    `  pid: ${pid ?? 'unknown'}`,
    `  ticketId: ${context.input.ticketId}`,
    `  zone: ${context.input.zone}`,
    `  namespace: ${context.input.namespace}`,
    `  runWorkdir: ${runWorkdir}`,
    `  inspectWorkdir: ${context.config.inspectWorkdir}`,
    `  claudeUseBwrap: ${context.config.claudeUseBwrap}`,
    `  readonlyKubectlCommand: ${context.config.readonlyKubectlCommand}`,
    `  tools: ${CLAUDE_TOOLS}`,
  ].join('\n'));
}

function logClaudeLifecycleEvent(
  eventType: string,
  raw: Record<string, unknown>,
  context: ClaudeLiveLogContext,
  truncateChars: number
): void {
  if (eventType === 'system') {
    logClaudeLiveLine(context, 'system', truncate(getStringValue(raw, 'subtype') || 'system event', truncateChars));
    return;
  }
  if (eventType === 'assistant') {
    logClaudeLiveLine(context, 'assistant', 'assistant message received');
    return;
  }
  if (eventType === 'result') {
    const usage = getClaudeUsageText(raw);
    logClaudeLiveLine(context, 'result', usage || 'claude result received');
    return;
  }
  if (eventType === 'error') {
    logClaudeLiveLine(context, 'error', truncate(getEventText(raw), truncateChars));
  }
}

function getClaudeUsageText(raw: Record<string, unknown>): string {
  const usage = isRecord(raw.usage) ? raw.usage : null;
  if (!usage) {
    return '';
  }
  const parts = [
    getNumberPart(usage, 'input_tokens', 'input'),
    getNumberPart(usage, 'output_tokens', 'output'),
    getNumberPart(usage, 'cache_creation_input_tokens', 'cache_create'),
    getNumberPart(usage, 'cache_read_input_tokens', 'cache_read'),
  ].filter(Boolean);
  return parts.length ? `usage: ${parts.join(', ')}` : '';
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

async function acquireClaudeSlot(config: AgentRunConfig): Promise<SlotRelease | null> {
  if (activeClaudeRuns < config.maxConcurrentRuns) {
    activeClaudeRuns += 1;
    return createClaudeSlotRelease();
  }

  if (pendingClaudeRuns.length >= config.maxPendingRuns) {
    return null;
  }

  return await new Promise((resolve) => {
    const pendingRun: PendingRun = {
      resolve,
      timer: setTimeout(() => {
        const index = pendingClaudeRuns.indexOf(pendingRun);
        if (index >= 0) {
          pendingClaudeRuns.splice(index, 1);
        }
        resolve(null);
      }, config.pendingTimeoutMs),
    };
    pendingClaudeRuns.push(pendingRun);
  });
}

function createClaudeSlotRelease(): SlotRelease {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeClaudeRuns = Math.max(activeClaudeRuns - 1, 0);
    const next = pendingClaudeRuns.shift();
    if (!next) {
      return;
    }
    clearTimeout(next.timer);
    activeClaudeRuns += 1;
    next.resolve(createClaudeSlotRelease());
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
  logClaudeRun({
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

function logClaudeRun(args: {
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
    `[Claude][Inspect][${args.runId}] run completed`,
    `  ticketId: ${args.input.ticketId}`,
    `  zone: ${args.input.zone}`,
    `  namespace: ${args.input.namespace}`,
    `  status: ${args.status}`,
    `  exitCode: ${args.exitCode ?? 'null'}`,
    `  signal: ${args.signal ?? 'null'}`,
    `  duration: ${formatDuration(Date.now() - args.startedAt)}`,
    `  finalTextLength: ${args.finalTextLength}`,
    `  inspectWorkdir: ${args.config.inspectWorkdir}`,
    `  claudeUseBwrap: ${args.config.claudeUseBwrap}`,
    `  readonlyKubectlCommand: ${args.config.readonlyKubectlCommand}`,
    `  hasKubeconfig: ${Boolean(args.input.requestKubeconfig)}`,
    `  sessionId: ${args.eventSummary.threadId ?? ''}`,
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

function logClaudeLiveLine(
  context: ClaudeLiveLogContext,
  label: string,
  message: string
): void {
  const cleanMessage = message.trim();
  if (!cleanMessage) {
    return;
  }
  const elapsed = formatDuration(Date.now() - context.startedAt);
  console.error(`[Claude][Inspect][${context.runId}][+${elapsed}] ${label}: ${indentMultiline(cleanMessage)}`);
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

function getEventText(raw: Record<string, unknown>): string {
  return (
    getStringValue(raw, 'message') ||
    getStringValue(raw, 'error') ||
    getStringValue(raw, 'error_message') ||
    getStringValue(raw, 'text')
  );
}

function getNumberPart(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  return typeof value === 'number' ? `${label}=${value}` : '';
}

function getStringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
