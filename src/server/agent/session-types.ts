import { KubernetesClient } from '../kubernetes/client';

export type AgentSessionStatus =
  | 'completed'
  | 'insufficient_evidence'
  | 'budget_exceeded'
  | 'failed';

export type AgentTerminationReason =
  | 'final_answer'
  | 'insufficient_evidence'
  | 'max_turns'
  | 'max_tool_calls'
  | 'max_runtime'
  | 'tool_error'
  | 'router_error'
  | 'repeated_action';

export type AgentEvidenceSourceType = 'tool' | 'knowledge' | 'source' | 'ticket';

export interface AgentBudgets {
  maxTurns: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxEvidenceChars: number;
  toolResultPreviewChars: number;
}

export interface AgentUsage {
  turns: number;
  toolCalls: number;
  runtimeMs: number;
  evidenceChars: number;
}

export interface AgentTraceEntry {
  turn: number;
  action: 'tool' | 'final' | 'insufficient' | 'none' | 'blocked';
  tool?: string;
  inputSummary?: string;
  resultStatus?: string;
  resultPreview?: string;
  observation?: string;
  reason?: string;
  error?: string;
  elapsedMs?: number;
}

export interface AgentEvidenceEntry {
  sourceType: AgentEvidenceSourceType;
  source: string;
  summary: string;
  detailsPreview?: string;
  observation?: string;
  tool?: string;
  turn?: number;
  truncated?: boolean;
}

export interface ExaminedResource {
  kind: string;
  name: string;
  namespace: string;
  sourceTool: string;
}

export interface AgentSessionResult {
  tool: 'agent_session';
  lastTool?: string;
  status: AgentSessionStatus;
  terminationReason: AgentTerminationReason;
  finalAnswer: string;
  customerReplyDraft: string;
  traceId: string;
  trace: AgentTraceEntry[];
  evidence: AgentEvidenceEntry[];
  examinedResources: ExaminedResource[];
  missingEvidence: string[];
  escalationAdvice: string[];
  budgets: AgentBudgets;
  usage: AgentUsage;
}

export interface AgentTicketContext {
  zone: string;
  namespace: string;
  ticketTitle: string;
  ticketModule: string;
  ticketCategory: string;
  ticketDescription: string;
  historyMessages: string;
  latestMessage: string;
  latestMessageImages: string[];
}

export interface AgentRouterContext {
  ticket: AgentTicketContext;
  budgets: AgentBudgets;
  usage: AgentUsage;
  evidence: AgentEvidenceEntry[];
  trace: AgentTraceEntry[];
  examinedResources: ExaminedResource[];
  lastToolResultSummary?: string;
  missingEvidence: string[];
}

export type AgentRouterAction = 'tool' | 'final' | 'insufficient' | 'none';

export interface AgentRouterDecision {
  action: AgentRouterAction;
  selectedTool?: string;
  toolInput?: Record<string, unknown>;
  finalAnswer?: string;
  customerReplyDraft?: string;
  missingEvidence?: string[];
  escalationAdvice?: string[];
  reason?: string;
}

export type DecideNextAgentAction = (
  context: AgentRouterContext
) => Promise<AgentRouterDecision>;

export interface RunAgentSessionParams {
  client: KubernetesClient;
  ticket: AgentTicketContext;
  decideNextAction: DecideNextAgentAction;
}
