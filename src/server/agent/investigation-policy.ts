import { SEARCH_TEXT_TOOL } from '../tools/types';
import type { AgentEvidenceEntry, AgentRouterDecision, AgentTicketContext } from './session-types';

const SEARCH_LIMIT = parseBoundedNumber(process.env.AGENT_POLICY_SEARCH_LIMIT, 5, 10);
const MAX_QUERY_CHARS = parseBoundedNumber(process.env.AGENT_POLICY_QUERY_CHARS, 240, 1000);

const ACK_ONLY_PATTERN = /^(hi|hello|hey|ok|okay|thanks|thank you|thx|谢谢|感谢|好的|知道了|收到|明白|嗯|嗯嗯|好)$/i;
const TROUBLESHOOTING_PATTERN = /(无法|不能|不行|失败|异常|报错|错误|卡住|准备中|启动|重启|连接|访问|公网|外网|域名|ingress|https|ssl|证书|devbox|应用|app|数据库|db|objectstorage|对象存储|cronjob|job|备份|实例|配额|quota|扩容|欠费|余额|释放|丢失|找不到|pending|failed|error|crash|restart|timeout|refused|unavailable)/i;
const SOURCE_TRIGGER_PATTERN = /(源码|实现|机制|平台|sealos|app\s*launchpad|applaunchpad|devbox|数据库|objectstorage|对象存储|ingress|公网|外网|域名|证书|template|模板|cronjob|opsrequest|backup|instance|实例|为什么|是否支持|如何|怎么)/i;
const UNAVAILABLE_PATTERN = /(notconfigured|not configured|rootunavailable|pathoutsideroot|enoent|enotdir|eacces|eperm|root is not available|outside configured source root|knowledge root|source root)/i;
const NO_MATCH_PATTERN = /status=no_data; total=0/i;

export function getInvestigationPolicyDecision(params: {
  ticket: AgentTicketContext;
  evidence: AgentEvidenceEntry[];
}): AgentRouterDecision | undefined {
  if (!shouldRunInvestigationPolicy(params.ticket)) {
    return undefined;
  }

  const knowledgeEvidence = findEvidence(params.evidence, 'knowledge');
  const sourceEvidence = findEvidence(params.evidence, 'source');
  const query = buildPolicySearchQuery(params.ticket);

  if (!knowledgeEvidence) {
    return {
      action: 'tool',
      selectedTool: SEARCH_TEXT_TOOL.name,
      toolInput: { rootType: 'knowledge', query, limit: SEARCH_LIMIT },
      reason: 'policy: search support knowledge before live diagnosis',
    };
  }

  if (!sourceEvidence && shouldSearchSource(params.ticket, knowledgeEvidence)) {
    return {
      action: 'tool',
      selectedTool: SEARCH_TEXT_TOOL.name,
      toolInput: { rootType: 'source', query, limit: SEARCH_LIMIT },
      reason: 'policy: search Sealos source for platform behavior or knowledge fallback',
    };
  }

  return undefined;
}

export function getInvestigationPolicyMissingEvidence(evidence: AgentEvidenceEntry[]): string[] {
  const missing: string[] = [];
  const knowledgeEvidence = findEvidence(evidence, 'knowledge');
  const sourceEvidence = findEvidence(evidence, 'source');

  if (knowledgeEvidence && (isUnavailable(knowledgeEvidence) || isNoMatch(knowledgeEvidence))) {
    missing.push(`Knowledge search did not provide usable context: ${knowledgeEvidence.summary}`);
  }

  if (sourceEvidence && (isUnavailable(sourceEvidence) || isNoMatch(sourceEvidence))) {
    missing.push(`Sealos source search did not provide usable context: ${sourceEvidence.summary}`);
  }

  return missing;
}

function shouldRunInvestigationPolicy(ticket: AgentTicketContext): boolean {
  const latestMessage = normalizeText(ticket.latestMessage);

  if (ACK_ONLY_PATTERN.test(latestMessage)) {
    return false;
  }

  return TROUBLESHOOTING_PATTERN.test(collectTicketText(ticket));
}

function shouldSearchSource(ticket: AgentTicketContext, knowledgeEvidence: AgentEvidenceEntry): boolean {
  return SOURCE_TRIGGER_PATTERN.test(collectTicketText(ticket)) || isUnavailable(knowledgeEvidence);
}

function findEvidence(evidence: AgentEvidenceEntry[], sourceType: 'knowledge' | 'source'): AgentEvidenceEntry | undefined {
  return evidence.find((item) => item.sourceType === sourceType);
}

function isUnavailable(evidence: AgentEvidenceEntry): boolean {
  return UNAVAILABLE_PATTERN.test(evidenceText(evidence));
}

function isNoMatch(evidence: AgentEvidenceEntry): boolean {
  return NO_MATCH_PATTERN.test(evidence.summary) || /"total":\s*0/.test(evidence.detailsPreview ?? '');
}

function buildPolicySearchQuery(ticket: AgentTicketContext): string {
  const query = normalizeText([
    ticket.ticketTitle,
    ticket.ticketModule,
    ticket.ticketCategory,
    ticket.ticketDescription,
    ticket.latestMessage,
    ticket.historyMessages,
  ].join(' '));

  return (query || 'Sealos support troubleshooting').slice(0, MAX_QUERY_CHARS);
}

function collectTicketText(ticket: AgentTicketContext): string {
  return normalizeText([
    ticket.ticketTitle,
    ticket.ticketModule,
    ticket.ticketCategory,
    ticket.ticketDescription,
    ticket.historyMessages,
    ticket.latestMessage,
  ].join('\n'));
}

function evidenceText(evidence: AgentEvidenceEntry): string {
  return `${evidence.summary}\n${evidence.detailsPreview ?? ''}`.toLowerCase();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseBoundedNumber(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}
