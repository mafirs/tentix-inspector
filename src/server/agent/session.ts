import { randomUUID } from 'crypto';
import { runAgentTool } from './tool-executor';
import {
  AgentSessionResult,
  AgentTraceEntry,
  AgentEvidenceEntry,
  AgentUsage,
  RunAgentSessionParams,
} from './session-types';

const DEFAULT_MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 16);
const DEFAULT_MAX_TOOL_CALLS = Number(process.env.AGENT_MAX_TOOL_CALLS ?? 12);
const DEFAULT_MAX_RUNTIME_MS = Number(process.env.AGENT_MAX_RUNTIME_MS ?? 180_000);
const DEFAULT_MAX_EVIDENCE_CHARS = Number(process.env.AGENT_MAX_EVIDENCE_CHARS ?? 60_000);
const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = Number(process.env.AGENT_TOOL_RESULT_PREVIEW_CHARS ?? 8_000);

export async function runAgentSession(params: RunAgentSessionParams): Promise<AgentSessionResult | { tool: 'none' }> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const budgets = {
    maxTurns: DEFAULT_MAX_TURNS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    maxEvidenceChars: DEFAULT_MAX_EVIDENCE_CHARS,
    toolResultPreviewChars: DEFAULT_TOOL_RESULT_PREVIEW_CHARS,
  };
  const trace: AgentTraceEntry[] = [];
  const evidence: AgentEvidenceEntry[] = [];
  const missingEvidence: string[] = [];
  const escalationAdvice: string[] = [];
  const repeatedActions = new Map<string, number>();
  let lastTool: string | undefined;
  let lastToolResultSummary = '';
  let toolCalls = 0;

  for (let turn = 1; turn <= budgets.maxTurns; turn += 1) {
    const usage = buildUsage(startedAt, turn - 1, toolCalls, evidence);
    if (usage.runtimeMs > budgets.maxRuntimeMs || usage.evidenceChars > budgets.maxEvidenceChars) {
      return buildSessionResult('budget_exceeded', 'max_runtime', '');
    }

    const decision = await params.decideNextAction({
      ticket: params.ticket,
      budgets,
      usage,
      evidence,
      trace,
      examinedResources: [],
      lastToolResultSummary,
      missingEvidence,
    });

    if (decision.action === 'none') {
      trace.push({ turn, action: 'none', reason: decision.reason });
      return { tool: 'none' };
    }

    if (decision.action === 'final') {
      trace.push({ turn, action: 'final', reason: decision.reason });
      return buildSessionResult('completed', 'final_answer', decision.finalAnswer ?? '', decision.customerReplyDraft ?? '');
    }

    if (decision.action === 'insufficient') {
      missingEvidence.push(...(decision.missingEvidence ?? []));
      escalationAdvice.push(...(decision.escalationAdvice ?? []));
      trace.push({ turn, action: 'insufficient', reason: decision.reason });
      return buildSessionResult('insufficient_evidence', 'insufficient_evidence', decision.finalAnswer ?? '', decision.customerReplyDraft ?? '');
    }

    if (!decision.selectedTool) {
      trace.push({ turn, action: 'blocked', error: 'router selected tool action without selectedTool' });
      return buildSessionResult('failed', 'router_error', '');
    }

    if (toolCalls >= budgets.maxToolCalls) {
      trace.push({ turn, action: 'blocked', error: 'max tool calls reached' });
      return buildSessionResult('budget_exceeded', 'max_tool_calls', '');
    }

    const actionKey = `${decision.selectedTool}:${JSON.stringify(decision.toolInput ?? {})}`;
    const repeatedCount = repeatedActions.get(actionKey) ?? 0;
    if (repeatedCount >= 1) {
      trace.push({
        turn,
        action: 'blocked',
        tool: decision.selectedTool,
        error: 'repeated action without new evidence',
        reason: 'choose a different evidence source, final, or insufficient',
      });
      missingEvidence.push(`Repeated action blocked: ${decision.selectedTool}. Choose a different evidence source, final, or insufficient.`);
      continue;
    }
    repeatedActions.set(actionKey, repeatedCount + 1);

    const output = await runAgentTool({
      client: params.client,
      namespace: params.ticket.namespace,
      ticket: params.ticket,
      toolName: decision.selectedTool,
      toolInput: decision.toolInput ?? {},
      turn,
      resultPreviewChars: budgets.toolResultPreviewChars,
    });

    toolCalls += 1;
    lastTool = decision.selectedTool;
    lastToolResultSummary = output.result.summary;
    evidence.push(output.evidence);
    trace.push({
      turn,
      action: 'tool',
      tool: decision.selectedTool,
      inputSummary: output.normalizedInputSummary,
      resultStatus: output.result.status,
      resultPreview: output.evidence.detailsPreview,
      reason: decision.reason,
      error: output.result.error,
      elapsedMs: output.result.elapsedMs,
    });
  }

  return buildSessionResult('budget_exceeded', 'max_turns', '');

  function buildSessionResult(
    status: AgentSessionResult['status'],
    terminationReason: AgentSessionResult['terminationReason'],
    finalAnswer: string,
    customerReplyDraft = ''
  ): AgentSessionResult {
    return {
      tool: 'agent_session',
      lastTool,
      status,
      terminationReason,
      finalAnswer,
      customerReplyDraft,
      traceId,
      trace,
      evidence,
      examinedResources: [],
      missingEvidence,
      escalationAdvice,
      budgets,
      usage: buildUsage(startedAt, trace.length, toolCalls, evidence),
    };
  }
}

function buildUsage(
  startedAt: number,
  turns: number,
  toolCalls: number,
  evidence: AgentEvidenceEntry[]
): AgentUsage {
  return {
    turns,
    toolCalls,
    runtimeMs: Date.now() - startedAt,
    evidenceChars: evidence.reduce((sum, item) => sum + (item.detailsPreview?.length ?? 0), 0),
  };
}
