import * as dotenv from "dotenv";
dotenv.config(); // 1. 加载 .env

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { inspect } from 'util';
import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { ChatOpenAI } from "@langchain/openai"; // 2. 引入 OpenAI 适配器
import { z } from 'zod';

import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  buildAgentToolsDescription,
} from './tool-registry';
import { runAgentSession } from './session';
import type { AgentEvidenceEntry, AgentRouterContext, AgentRouterDecision, AgentTicketContext } from './session-types';

// --- A. 初始化 AI 模型 (Gemini) ---
const AI_API_KEY = process.env.AI_API_KEY;
const AI_BASE_URL = process.env.AI_BASE_URL;
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 35_000);
const isDevelopment = process.env.NODE_ENV === 'development';

function logDevelopment(...args: unknown[]): void {
  if (isDevelopment) {
    console.log(...args);
  }
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return inspect(value, {
    depth: 8,
    colors: false,
    maxArrayLength: 50,
    breakLength: 120,
  });
}

function buildKubeconfigSummary(kubeconfig: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    bytes: Buffer.byteLength(kubeconfig, 'utf8'),
    lineCount: kubeconfig === '' ? 0 : kubeconfig.split(/\r?\n/).length,
    sha256: createHash('sha256').update(kubeconfig).digest('hex').slice(0, 12),
  };

  try {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromString(kubeconfig);
    summary.currentContext = kubeConfig.getCurrentContext();
    summary.clusterCount = kubeConfig.getClusters().length;
    summary.contextCount = kubeConfig.getContexts().length;
    summary.userCount = kubeConfig.getUsers().length;
  } catch (error) {
    summary.parseError = error instanceof Error ? error.message : 'Unknown parse error';
  }

  return summary;
}

function loadToolDescriptionOverrides(
  availableToolNames: string[]
): Record<string, string> {
  const overrideFile = process.env.TOOLS_DESC_OVERRIDE_FILE?.trim();
  if (!overrideFile) {
    return {};
  }

  const resolvedOverrideFile = path.isAbsolute(overrideFile)
    ? overrideFile
    : path.resolve(process.cwd(), overrideFile);

  if (!fs.existsSync(resolvedOverrideFile)) {
    return {};
  }

  const availableToolNameSet = new Set(availableToolNames);

  try {
    const fileContent = fs.readFileSync(resolvedOverrideFile, 'utf8');
    const parsed = JSON.parse(fileContent);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[Router] Invalid tool description override file format: ${resolvedOverrideFile}`
      );
      return {};
    }

    const overrides: Record<string, string> = {};
    const overriddenToolNames: string[] = [];

    for (const [toolName, description] of Object.entries(parsed)) {
      if (!availableToolNameSet.has(toolName)) {
        continue;
      }
      if (typeof description !== 'string') {
        continue;
      }

      overrides[toolName] = description;
      overriddenToolNames.push(toolName);
    }

    if (overriddenToolNames.length > 0) {
      console.error(
        `[Router] Tool description overrides applied: ${overriddenToolNames.join(', ')}`
      );
    }

    return overrides;
  } catch (error) {
    console.error('[Router] Failed to load tool description override file:', error);
    return {};
  }
}

logDevelopment('[DEBUG] Current CWD:', process.cwd());
logDevelopment('[DEBUG] AI_MODEL:', AI_MODEL);
logDevelopment('[DEBUG] AI_API_KEY Type:', typeof AI_API_KEY);
logDevelopment('[DEBUG] AI_API_KEY Length:', AI_API_KEY ? AI_API_KEY.length : 'Missing/Undefined');


// 检查配置
if (!AI_API_KEY || !AI_BASE_URL) {
  // 如果没配置，我们在 Router 里会做降级处理，或者在这里抛出错误
  console.warn("[Agent] Warning: AI_API_KEY or AI_BASE_URL not set in .env");
}

const formattedBaseUrl = AI_BASE_URL?.endsWith("/v1") ? AI_BASE_URL : `${AI_BASE_URL}/v1`;

const llm = new ChatOpenAI({
  modelName: AI_MODEL,
  apiKey: AI_API_KEY,
  configuration: { baseURL: formattedBaseUrl },
  timeout: LLM_TIMEOUT_MS,
  temperature: 0,
});

// --- B. 定义 State ---
export interface AgentState {
  zone: string;
  namespace: string;
  ticketTitle: string;
  ticketModule: string;
  ticketCategory: string;
  ticketDescription: string;
  historyMessages: string;
  latestMessage: string;
  latestMessageImages: string[];
  requestKubeconfig?: string;

  k8sClient?: KubernetesClient;
  finalResult?: unknown;
}

export type AgentRunnable = {
  invoke: (input: AgentState) => Promise<AgentState>;
};

// Zone 映射
export const ZONE_KUBECONFIG_MAP: Record<string, string> = {
  hzh: path.join(process.cwd(), 'kubeconfig', 'hzh-kubeconfig'),
  bja: path.join(process.cwd(), 'kubeconfig', 'bja-kubeconfig'),
  gzg: path.join(process.cwd(), 'kubeconfig', 'gzg-kubeconfig'),
  io: path.join(process.cwd(), 'kubeconfig', 'io-kubeconfig'),
};

export const SUPPORTED_ZONES = Object.keys(ZONE_KUBECONFIG_MAP);

const TOOL_DESCRIPTION_OVERRIDES = loadToolDescriptionOverrides([...AGENT_TOOL_NAMES]);

const routerDecisionSchema = z.object({
  action: z.enum(['tool', 'final', 'insufficient', 'none']),
  selectedTool: z.enum(AGENT_TOOL_NAMES).nullable(),
  toolInput: z.object({}).passthrough(),
  finalAnswer: z.string().nullable(),
  customerReplyDraft: z.string().nullable(),
  missingEvidence: z.array(z.string()),
  escalationAdvice: z.array(z.string()),
  reason: z.string().nullable(),
});
type RouterDecision = z.infer<typeof routerDecisionSchema>;
type RouterStructuredResponse = {
  raw: unknown;
  parsed: RouterDecision | null;
};

type RouterMessageContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const MODEL_OBSERVATION_ENTRIES = parsePositiveIntegerEnv(process.env.AGENT_MODEL_OBSERVATION_ENTRIES, 10, 30);
const MODEL_OBSERVATION_CHARS = parsePositiveIntegerEnv(process.env.AGENT_MODEL_OBSERVATION_CHARS, 96_000, 180_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}

function buildModelObservationContext(evidence: AgentEvidenceEntry[]): string {
  const candidates = evidence
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Boolean(item.observation?.trim()));
  if (candidates.length === 0) {
    return '- none';
  }

  const recent = candidates.slice(-MODEL_OBSERVATION_ENTRIES);
  const critical = candidates.filter(({ item }) => isCriticalObservation(item));
  const seen = new Set<number>();
  const selected = [...critical, ...recent]
    .filter(({ index }) => {
      if (seen.has(index)) {
        return false;
      }
      seen.add(index);
      return true;
    })
    .sort((a, b) => a.index - b.index);

  const sections: string[] = [];
  let remainingChars = MODEL_OBSERVATION_CHARS;
  for (const { item, index } of selected) {
    if (remainingChars <= 0) {
      break;
    }
    const header = `${index + 1}. [${item.sourceType}] ${item.source}: ${item.summary}`;
    const body = item.observation?.trim() ?? '';
    const bodyBudget = remainingChars - header.length - 1;
    if (bodyBudget <= 0) {
      break;
    }
    const visibleBody = body.length > bodyBudget
      ? `${body.slice(0, bodyBudget)}\n[observation truncated]`
      : body;
    sections.push(`${header}\n${visibleBody}`);
    remainingChars -= header.length + visibleBody.length + 2;
  }

  return sections.length > 0 ? sections.join('\n\n') : '- none';
}

function isCriticalObservation(item: AgentEvidenceEntry): boolean {
  const text = `${item.summary}\n${item.observation ?? ''}`.toLowerCase();
  return /notfound|not found|status=no_data|status=error|404|failed|blocked/.test(text);
}

function getRouterErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  function visit(value: unknown): void {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }

    if (value instanceof Error) {
      parts.push(value.message);
    }

    if (!isRecord(value)) {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const key of ['message', 'code', 'type', 'status', 'param']) {
      const part = value[key];
      if (typeof part === 'string' || typeof part === 'number') {
        parts.push(String(part));
      }
    }

    visit(value.error);
  }

  visit(error);
  return parts.length > 0 ? parts.join(' ') : formatLogValue(error);
}

function isResponseFormatUnavailableError(error: unknown): boolean {
  return /response_format type is unavailable/i.test(getRouterErrorText(error));
}

function parseRouterDecisionFromJsonObjectResponse(response: unknown): RouterDecision {
  const content = isRecord(response) ? response.content : undefined;
  let text = '';

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && typeof item.text === 'string') return item.text;
        return '';
      })
      .join('');
  }

  if (!text.trim()) {
    throw new Error('[Router] JSON object fallback response content is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`[Router] JSON object fallback returned invalid JSON: ${getRouterErrorText(error)}`);
  }

  return routerDecisionSchema.parse(parsed);
}

function buildRouterUserContext(context: AgentRouterContext): string {
  return `
    User Context:
    - Default Namespace: ${context.ticket.namespace}
    - Ticket Title: ${context.ticket.ticketTitle}
    - Ticket Module: ${context.ticket.ticketModule}
    - Ticket Category: ${context.ticket.ticketCategory}
    - Ticket Description: ${context.ticket.ticketDescription}
    - History Messages: ${context.ticket.historyMessages}
    - Latest Message: ${context.ticket.latestMessage}

    Runtime:
    - Turns Used: ${context.usage.turns}/${context.budgets.maxTurns}
    - Tool Calls Used: ${context.usage.toolCalls}/${context.budgets.maxToolCalls}
    - Runtime Used Ms: ${context.usage.runtimeMs}/${context.budgets.maxRuntimeMs}

    Evidence Summary:
    ${context.evidence.map((item, index) => `${index + 1}. [${item.sourceType}] ${item.source}: ${item.summary}`).join('\n') || '- none'}

    Model-Visible Observations:
    ${buildModelObservationContext(context.evidence)}

    Last Tool Result:
    ${context.lastToolResultSummary || '- none'}

    Trace Summary:
    ${context.trace.map((item) => `turn=${item.turn} action=${item.action} tool=${item.tool ?? ''} status=${item.resultStatus ?? ''} reason=${item.reason ?? ''}`).join('\n') || '- none'}

    Missing Evidence So Far:
    ${(context.missingEvidence.length ? context.missingEvidence : ['none']).join('\n')}
  `;
}

function buildRouterUserContent(context: AgentRouterContext): string | RouterMessageContentItem[] {
  const userContext = buildRouterUserContext(context);
  const imageUrls = Array.from(new Set(context.ticket.latestMessageImages.filter(Boolean))).slice(-6);

  if (imageUrls.length === 0) {
    return userContext;
  }

  return [
    { type: 'text', text: userContext },
    ...imageUrls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ];
}

// 自动生成 AI Prompt (无需手动维护两份列表)
const GENERATED_TOOLS_DESC = buildAgentToolsDescription(TOOL_DESCRIPTION_OVERRIDES);

const SYSTEM_PROMPT = `
You are a Kubernetes Expert Agent.
Your job is to run a bounded read-only investigation for a k8s-sealos support ticket.

Available Tools:
${GENERATED_TOOLS_DESC}

Investigation Rules:
- Use Ticket Title, Ticket Description, Ticket Module, Ticket Category, History Messages, and Latest Message together as one routing context. Do not rely on Latest Message alone.
- Every turn receives accumulated evidence, selected model-visible observations, and trace. Choose the next action based on what is still missing.
- Treat Model-Visible Observations as the concrete tool output available for current reasoning. Do not ask for the same tool/input again when an observation already contains the needed names, status, selectors, events, or logs.
- If the ticket includes a concrete app/resource/domain/host/pod-prefix target such as "xrouter", prefer find_k8s_resources_by_ns early to locate matching Services, Ingresses, workloads, Pods, App CRDs, ConfigMaps, PVCs, Certificates, or Issuers before broad list/get sweeps.
- find_k8s_resources_by_ns does not search Secrets by default. Use resourceTypes=["secrets"] only when Secret metadata/key presence is directly relevant; never ask for Secret values.
- When find_k8s_resources_by_ns returns coverageStatus=partial, errors, or unsupportedResourceTypes, do not treat total=0 as proof that the target does not exist.
- When an observation contains an Index section, treat it as the visible candidate set for that tool result. Use exact name, labelSelector, kubectl_describe_by_ns, kubectl_logs_by_ns, or find_k8s_resources_by_ns for drilldown instead of repeating a broad list/get.
- When a list/get observation says details were omitted or truncated, do not infer absence from missing detail rows. Narrow by target name, selector, or find_k8s_resources_by_ns.
- Choose action "tool" when one more allowed read-only tool can add useful evidence.
- Choose action "final" when the current namespace evidence is enough to answer.
- Choose action "insufficient" when the issue likely needs platform-side, cross-namespace, Secret, arbitrary shell, or unavailable evidence.
- Select "none" only when the current turn is clearly just a greeting, thanks, acknowledgement, filler, or a pure conversational reply that does not require checking live cluster or namespace state.
- Never request shell, raw kubeconfig, -A, platform namespace, system namespace, cluster-scoped resources, Secret data, connection strings, object storage access keys, or write operations.
- Treat kubectl_get_by_ns, kubectl_describe_by_ns, kubectl_logs_by_ns, and kubectl_events_by_ns as the primary live namespace inspection tools for supported resources.
- Use list_pod_listening_ports_by_ns only when the ticket needs evidence of ports actually listening inside a known pod/container. This is a controlled probe; do not provide command, args, flags, shell text, or namespace.
- Use du_summary_by_ns only when the ticket needs disk usage for a specific absolute path inside a known pod/container. Provide path only as data; do not provide command, args, flags, shell text, or namespace.
- Use find_k8s_resources_by_ns as the primary live target-locating tool when the user provides a likely resource name, app name, domain, service name, or pod prefix.
- If the ticket does not contain a concrete target name, use multiple ordinary kubectl_get_by_ns calls with output="summary" on relevant high-frequency or semantically relevant supported resources, such as devboxes, pods, statefulsets, deployments, clusters, services, ingresses, events, or other supported resources selected from the ticket context. Do not treat this example set as exhaustive.
- Use list_supported_k8s_resources when you are unsure which resource name, alias, or apiVersion to use.
- Use kubectl_get_by_ns with output="summary" for resource discovery, name lookup, labelSelector lookup, and broad first-pass scans.
- Use kubectl_get_by_ns with output="yaml" only after an exact resource name is known and sanitized object detail is needed.
- Use kubectl_describe_by_ns only after a target resource name is known and diagnosis, conditions, related resources, or related events are needed.
- Use kubectl_events_by_ns for event evidence, either namespace-wide during first-pass scans or filtered by resource/name after a target is known.
- For access failures, inspect Service/Ingress endpoint readiness in kubectl_get_by_ns or kubectl_describe_by_ns observations. A Service or Ingress that exists but has ready=0 endpoints is concrete evidence of routing or selector/backend mismatch.
- Use kubectl_logs_by_ns when podName or labelSelector is known. Use get_logs_by_ns only when the user asks for logs but the target pod is not yet known and automatic resolution is useful.
- Never ask for ConfigMap values. The server only returns ConfigMap keys and sizes.
- Knowledge and source search results are context, not live cluster state.
- If evidence or missing evidence says knowledge or source search was unavailable or returned no matches, do not claim that KB/source context was successfully checked.
- Use knowledge/source context for playbook or platform behavior only; current root cause still requires namespace evidence unless the ticket only asks product behavior.
- Use search_text with rootType="knowledge" for targeted playbook, SOP, KB, or support-document lookup.
- Use search_text with rootType="source" when the issue depends on Sealos platform behavior, product implementation, controller behavior, or source confirmation.
- Use list_text_files only when you need to discover available KB/source paths; use read_text_slice after a search result identifies a specific useful file.
- Do not repeat the same tool with the same input unless you explain what new evidence it can produce.
- If the user is still troubleshooting, is asking about current status, is correcting the previous target, or is asking about any live issue related to namespace resources, do not select "none".
- If the request may depend on current cluster or namespace state, do not select "none" just because the latest message is short or ambiguous.
- If the user mentions public access, external access, 公网, 外网, domain, 域名, CNAME, host, route, ingress, external IP, HTTPS, SSL, certificate, 证书, port exposure, or "访问不到", prefer kubectl_get_by_ns with resource="ingresses" and output="summary" as the first live-state check unless a concrete target should be located by find_k8s_resources_by_ns or the request is specifically about certificate issuance or renewal status.
- If the user specifically asks about certificate issuance, renewal, or secure certificate status after domain configuration, prefer "list_certificate_by_ns".
- If the user mentions 欠费, 余额不足, 扣费, 充值后, 费用异常, suspend, release, 被释放, 停服, or post-recharge abnormality, prefer "list_debt_by_ns".
- If the user mentions DevBox, devbox, VS Code, Cursor, Trae, SSH, remote connection, IDE connection, DevBox startup, restart, release, sharing, or DevBox availability, prefer kubectl_get_by_ns with resource="devboxes" and output="summary".
- If the user explicitly asks for logs, stdout, stderr, stack trace, or runtime output and a podName or labelSelector is known, prefer "kubectl_logs_by_ns"; otherwise use "get_logs_by_ns" or first identify the pod with "kubectl_get_by_ns".
- If the user asks which ports are listening inside a pod/container and a podName or labelSelector is known, prefer "list_pod_listening_ports_by_ns"; otherwise first identify the pod with "kubectl_get_by_ns" or "find_k8s_resources_by_ns".
- If the user asks for du, disk usage, directory size, or path usage inside a pod/container and a podName or labelSelector plus an absolute path are known, prefer "du_summary_by_ns"; otherwise first identify the pod or ask for the missing path in the final response.
- When several tools look possible, choose the tool that is the best first live-state inspection for the user's current complaint. Do not choose "none" merely because the message is brief.

Examples:
User: 远程连接不上
Return: {"action":"tool","selectedTool":"kubectl_get_by_ns","toolInput":{"resource":"devboxes","output":"summary"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"DevBox connectivity needs DevBox summary state"}

User: Trae无法连接
Return: {"action":"tool","selectedTool":"kubectl_get_by_ns","toolInput":{"resource":"devboxes","output":"summary"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"DevBox IDE connectivity needs DevBox status"}

User: 余额不足被释放了
Return: {"action":"tool","selectedTool":"list_debt_by_ns","toolInput":{},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"billing suspension should inspect debt state"}

User: 充钱后中的项目还是找不到
Return: {"action":"tool","selectedTool":"list_debt_by_ns","toolInput":{},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"post-recharge recovery should inspect debt state"}

User: 公网域名无法访问
Return: {"action":"tool","selectedTool":"kubectl_get_by_ns","toolInput":{"resource":"ingresses","output":"summary"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"external access should inspect ingress summary first"}

User: xrouter应用无法访问，显示 Node is not ready
Return: {"action":"tool","selectedTool":"find_k8s_resources_by_ns","toolInput":{"query":"xrouter"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"the ticket includes a concrete App Launchpad target name and needs resource locating before drilldown"}

User: 如何查看应用的对外ip？
Return: {"action":"tool","selectedTool":"kubectl_get_by_ns","toolInput":{"resource":"ingresses","output":"summary"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"external IP is exposed by ingress state"}

User: ingress
Return: {"action":"tool","selectedTool":"kubectl_get_by_ns","toolInput":{"resource":"ingresses","output":"summary"},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"ingress request needs ingress state"}

User: 谢谢，知道了
Return: {"action":"none","selectedTool":null,"toolInput":{},"finalAnswer":null,"customerReplyDraft":null,"missingEvidence":[],"escalationAdvice":[],"reason":"acknowledgement only"}

Output Format:
You MUST return a strictly valid JSON object. No markdown.
Every field is required:
{
  "action": "tool",
  "selectedTool": "tool_name_from_above_or_null",
  "toolInput": {},
  "finalAnswer": null,
  "customerReplyDraft": null,
  "missingEvidence": [],
  "escalationAdvice": [],
  "reason": ""
}
Note:
- action must be exactly one of "tool", "final", "insufficient", "none".
- selectedTool must be an exact tool name from Available Tools when action is "tool"; otherwise selectedTool must be null.
- toolInput must always be an object. Use {} when no arguments are needed.
- finalAnswer, customerReplyDraft, and reason must be strings or null.
- missingEvidence and escalationAdvice must always be arrays of strings. Use [] when empty.
- Do not add namespace into toolInput. The server injects trusted namespace.
- For find_k8s_resources_by_ns, provide query. Use resourceTypes only when you already know the target class; omit it for the default resource set. Secrets require explicit resourceTypes=["secrets"].
- For kubectl_get_by_ns, provide resource plus optional name, apiVersion, labelSelector, fieldSelector, limit, and output. Use output="summary" for broad scans. Use output="yaml" only with name.
- For kubectl_describe_by_ns, provide resource and name only when evidence already identifies a target resource.
- For kubectl_logs_by_ns, provide podName or labelSelector. Provide container when the target pod has multiple containers unless allContainers is intended.
- For kubectl_events_by_ns, provide resource and name when filtering events to one target; otherwise omit them for namespace event scan.
- For list_pod_listening_ports_by_ns, provide podName or labelSelector and optional container. Do not provide command, args, flags, or namespace.
- For du_summary_by_ns, provide podName or labelSelector, path, and optional container. Do not provide command, args, flags, or namespace.
- Do not add namespace into toolInput. The server injects trusted namespace.
`;

const structuredRouter = llm.withStructuredOutput(routerDecisionSchema, {
  method: 'jsonSchema',
  name: 'router_decision',
});
const structuredRouterWithRaw = llm.withStructuredOutput(routerDecisionSchema, {
  method: 'jsonSchema',
  name: 'router_decision',
  includeRaw: true,
});
const jsonObjectRouter = llm.withConfig({ response_format: { type: 'json_object' } });
const routerCapabilityCache = new Map<string, 'json_object'>();
const routerCapabilityKey = `${formattedBaseUrl ?? ''}|${AI_MODEL}`;
const ROUTER_JSON_SCHEMA_MAX_ATTEMPTS = 2;

function shouldPreferJsonObjectRouter(): boolean {
  return routerCapabilityCache.get(routerCapabilityKey) === 'json_object';
}

function markJsonSchemaUnavailable(): void {
  routerCapabilityCache.set(routerCapabilityKey, 'json_object');
}

async function invokeStructuredRouter(messages: Array<{ role: string; content: unknown }>): Promise<RouterDecision> {
  if (isDevelopment) {
    const rawResponse = await structuredRouterWithRaw.invoke(messages as any) as RouterStructuredResponse;
    logDevelopment('[Router] AI raw response:', formatLogValue(rawResponse.raw));

    if (!rawResponse.parsed) {
      throw new Error('[Router] AI raw response could not be parsed');
    }

    return rawResponse.parsed;
  }

  return await structuredRouter.invoke(messages as any) as RouterDecision;
}

async function invokeJsonObjectRouter(messages: Array<{ role: string; content: unknown }>): Promise<RouterDecision> {
  const rawResponse = await jsonObjectRouter.invoke(messages as any);
  logDevelopment('[Router] AI json_object fallback response:', formatLogValue(rawResponse));
  return parseRouterDecisionFromJsonObjectResponse(rawResponse);
}

async function invokeStructuredRouterWithResponseFormatFallback(
  messages: Array<{ role: string; content: unknown }>
): Promise<RouterDecision> {
  let lastResponseFormatError: unknown;

  for (let attempt = 1; attempt <= ROUTER_JSON_SCHEMA_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await invokeStructuredRouter(messages);
    } catch (error) {
      if (!isResponseFormatUnavailableError(error)) {
        throw error;
      }

      lastResponseFormatError = error;
      console.error(
        `[Router] json_schema response_format unavailable (attempt ${attempt}/${ROUTER_JSON_SCHEMA_MAX_ATTEMPTS}):`,
        getRouterErrorText(error)
      );
    }
  }

  markJsonSchemaUnavailable();
  console.error(
    '[Router] json_schema response_format unavailable after two attempts, falling back to json_object:',
    getRouterErrorText(lastResponseFormatError)
  );
  return await invokeJsonObjectRouter(messages);
}

// --- Node 1: Init ---
async function initContextNode(state: AgentState): Promise<Partial<AgentState>> {
  const requestKubeconfig = (state.requestKubeconfig ?? '').trim();
  const namespace = (state.namespace || '').trim();

  if (!namespace.startsWith('ns-') || namespace.length <= 3) {
    throw new Error('[Agent] Invalid namespace format, expected ns-xxx');
  }

  if (requestKubeconfig) {
    console.log('[Agent] Init request-scoped KubernetesClient from Authorization header');
    logDevelopment(
      '[Agent] Request kubeconfig summary:',
      JSON.stringify(buildKubeconfigSummary(requestKubeconfig))
    );

    const requestClient = new KubernetesClient(undefined, requestKubeconfig);
    return { k8sClient: requestClient };
  }

  const selectedZone = (state.zone || '').trim();
  const kubeconfigPath = ZONE_KUBECONFIG_MAP[selectedZone];

  if (!kubeconfigPath) {
    throw new Error(`[Agent] Unsupported zone: ${selectedZone}`);
  }
  if (!fs.existsSync(kubeconfigPath)) {
    throw new Error(`[Agent] Local kubeconfig file not found for zone: ${selectedZone}`);
  }

  const userName = namespace.slice(3); // ns-xxx -> xxx

  // 1) master client: use zone kubeconfig to query User CRD
  console.log(`[Agent] Init master KubernetesClient for zone=${selectedZone}`);
  const masterClient = new KubernetesClient(kubeconfigPath);

  // 2) fetch user kubeconfig from cluster-scoped CRD: users.user.sealos.io (user.sealos.io/v1)
  const customObjectsApi = masterClient.getCustomObjectsApi();
  const userObjResp = await customObjectsApi.getClusterCustomObject(
    'user.sealos.io',
    'v1',
    'users',
    userName
  );
  const userObj = userObjResp.body as any;
  const userKubeconfig: string | undefined = userObj?.status?.kubeConfig;

  if (!userKubeconfig || typeof userKubeconfig !== 'string' || userKubeconfig.trim() === '') {
    throw new Error('[Agent] Failed to get user kubeconfig from User.status.kubeConfig');
  }

  console.error(`[Agent] User kubeconfig fetched for user=${userName} zone=${selectedZone}`);
  logDevelopment(
    '[Agent] User kubeconfig summary:',
    JSON.stringify(buildKubeconfigSummary(userKubeconfig))
  );

  // 3) user client: all subsequent tools will use this client (user cluster only)
  const userClient = new KubernetesClient(undefined, userKubeconfig);
  return { k8sClient: userClient };
}

// --- Node 2: Router (AI 智能版) ---
async function decideNextAction(context: AgentRouterContext): Promise<AgentRouterDecision> {
  console.log(`[Router] Asking AI (${AI_MODEL}) to select tool...`);

  const userContext = buildRouterUserContext(context);
  const routerUserContent = buildRouterUserContent(context);

  async function invokeRouter(content: string | RouterMessageContentItem[]) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: content as any }
    ];
    let decision: RouterDecision;

    if (shouldPreferJsonObjectRouter()) {
      decision = await invokeJsonObjectRouter(messages);
    } else {
      decision = await invokeStructuredRouterWithResponseFormatFallback(messages);
    }

    console.log('[Router] AI structured decision:', JSON.stringify(decision));

    if (decision.action === 'tool' && !decision.selectedTool) {
      throw new Error('[Router] AI selected tool action without selectedTool');
    }

    const selectedTool = decision.selectedTool ?? undefined;
    const toolInput =
      decision.toolInput &&
      typeof decision.toolInput === 'object' &&
      !Array.isArray(decision.toolInput)
        ? decision.toolInput
        : {};
    const missingEvidence = Array.isArray(decision.missingEvidence)
      ? decision.missingEvidence
      : [];
    const escalationAdvice = Array.isArray(decision.escalationAdvice)
      ? decision.escalationAdvice
      : [];

    return {
      ...decision,
      selectedTool: selectedTool as AgentToolName | undefined,
      toolInput,
      finalAnswer: decision.finalAnswer ?? undefined,
      customerReplyDraft: decision.customerReplyDraft ?? undefined,
      missingEvidence,
      escalationAdvice,
      reason: decision.reason ?? undefined,
    };
  }

  try {
    if (Array.isArray(routerUserContent)) {
      try {
        return await invokeRouter(routerUserContent);
      } catch (visionError) {
        console.error('[Router] Vision routing failed, falling back to text routing', visionError);
      }
    }

    return await invokeRouter(userContext);
  } catch (error) {
    console.error('[Router] AI structured routing failed, returning insufficient', error);
    return {
      action: 'insufficient',
      missingEvidence: ['router decision failed'],
      escalationAdvice: ['manual inspection required because router failed'],
      reason: 'router_error',
    };
  }
}

// --- 构建图 (保留对外 runnable 接口) ---
let cachedRunnable: AgentRunnable | null = null;

export async function getAgentRunnable(): Promise<AgentRunnable> {
  if (cachedRunnable) return cachedRunnable;

  cachedRunnable = {
    async invoke(input: AgentState): Promise<AgentState> {
      const initResult = await initContextNode(input);
      const initializedState: AgentState = { ...input, ...initResult };
      if (!initializedState.k8sClient) {
        throw new Error('[Agent] k8sClient not initialized');
      }
      const ticket: AgentTicketContext = {
        zone: initializedState.zone,
        namespace: initializedState.namespace,
        ticketTitle: initializedState.ticketTitle,
        ticketModule: initializedState.ticketModule,
        ticketCategory: initializedState.ticketCategory,
        ticketDescription: initializedState.ticketDescription,
        historyMessages: initializedState.historyMessages,
        latestMessage: initializedState.latestMessage,
        latestMessageImages: initializedState.latestMessageImages,
      };
      const finalResult = await runAgentSession({
        client: initializedState.k8sClient,
        ticket,
        decideNextAction,
      });
      return { ...initializedState, finalResult };
    },
  };
  return cachedRunnable;
}
