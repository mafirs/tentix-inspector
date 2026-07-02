import { KubernetesClient } from '../kubernetes/client';
import { GET_LOGS_BY_NS_TOOL, NONE_TOOL } from '../tools/types';
import { AgentTicketContext, AgentEvidenceEntry } from './session-types';
import { getAgentTool } from './tool-registry';
import {
  AgentToolResult,
  normalizeToolResult,
  sanitizeToolError,
  stringifyForPreview,
  truncateToolResultForEvidence,
} from './tool-result';

export interface RunAgentToolParams {
  client: KubernetesClient;
  namespace: string;
  ticket: AgentTicketContext;
  toolName: string;
  toolInput: Record<string, unknown>;
  turn: number;
  resultPreviewChars: number;
}

export interface RunAgentToolOutput {
  result: AgentToolResult;
  evidence: AgentEvidenceEntry;
  normalizedInputSummary: string;
}

export async function runAgentTool(params: RunAgentToolParams): Promise<RunAgentToolOutput> {
  const startedAt = Date.now();
  const tool = getAgentTool(params.toolName);

  if (!tool || !tool.enabledInV1 || tool.safety !== 'read_only') {
    const result = buildBlockedResult(params.toolName, startedAt);
    return buildOutput(params, result, {});
  }

  if (tool.scope === 'session' && tool.name !== NONE_TOOL.name) {
    const result = buildBlockedResult(params.toolName, startedAt);
    return buildOutput(params, result, {});
  }

  const input = buildTrustedInput(params, tool.scope);

  try {
    const rawResult = await tool.run({ client: params.client, input });
    const normalized = normalizeToolResult(rawResult, Date.now() - startedAt);
    const truncated = truncateToolResultForEvidence(normalized, params.resultPreviewChars);
    return buildOutput(params, truncated, input);
  } catch (error) {
    const result: AgentToolResult = {
      status: 'error',
      summary: sanitizeToolError(error),
      error: sanitizeToolError(error),
      elapsedMs: Date.now() - startedAt,
      truncated: false,
      originalSize: 0,
    };
    return buildOutput(params, result, input);
  }
}

function buildTrustedInput(params: RunAgentToolParams, scope: string): Record<string, unknown> {
  if (scope === 'namespace') {
    const base =
      params.toolName === GET_LOGS_BY_NS_TOOL.name
        ? {
            ticketModule: params.ticket.ticketModule,
            ticketTitle: params.ticket.ticketTitle,
            ticketDescription: params.ticket.ticketDescription,
            historyMessages: params.ticket.historyMessages,
            latestMessage: params.ticket.latestMessage,
          }
        : {};
    return {
      ...params.toolInput,
      ...base,
      namespace: params.namespace,
    };
  }

  return { ...params.toolInput };
}

function buildBlockedResult(toolName: string, startedAt: number): AgentToolResult {
  return {
    status: 'blocked',
    summary: `tool blocked: ${toolName}`,
    error: `tool blocked: ${toolName}`,
    elapsedMs: Date.now() - startedAt,
    truncated: false,
    originalSize: 0,
  };
}

function buildOutput(
  params: RunAgentToolParams,
  result: AgentToolResult,
  input: Record<string, unknown>
): RunAgentToolOutput {
  const preview = stringifyForPreview(result.data ?? result.error ?? result.summary);
  return {
    result,
    evidence: {
      sourceType: params.toolName.startsWith('search_knowledge')
        ? 'knowledge'
        : params.toolName.startsWith('search_sealos_source')
          ? 'source'
          : 'tool',
      source: params.toolName,
      summary: result.summary,
      detailsPreview: preview,
      tool: params.toolName,
      turn: params.turn,
      truncated: result.truncated,
    },
    normalizedInputSummary: stringifyForPreview(input),
  };
}
