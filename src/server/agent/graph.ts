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
import type { AgentRouterContext, AgentRouterDecision, AgentTicketContext } from './session-types';

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
  selectedTool: z.enum(AGENT_TOOL_NAMES).optional(),
  toolInput: z.record(z.unknown()).default({}),
  finalAnswer: z.string().optional(),
  customerReplyDraft: z.string().optional(),
  missingEvidence: z.array(z.string()).default([]),
  escalationAdvice: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
type RouterDecision = z.infer<typeof routerDecisionSchema>;
type RouterStructuredResponse = {
  raw: unknown;
  parsed: RouterDecision | null;
};

type RouterMessageContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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
- Every turn receives accumulated evidence and trace. Choose the next action based on what is still missing.
- Choose action "tool" when one more allowed read-only tool can add useful evidence.
- Choose action "final" when the current namespace evidence is enough to answer.
- Choose action "insufficient" when the issue likely needs platform-side, cross-namespace, Secret, shell, or unavailable evidence.
- Select "none" only when the current turn is clearly just a greeting, thanks, acknowledgement, filler, or a pure conversational reply that does not require checking live cluster or namespace state.
- Never request shell, raw kubeconfig, -A, platform namespace, system namespace, cluster-scoped resources, Secret data, connection strings, object storage access keys, or write operations.
- Knowledge and source search results are context, not live cluster state.
- Do not repeat the same tool with the same input unless you explain what new evidence it can produce.
- If the user is still troubleshooting, is asking about current status, is correcting the previous target, or is asking about any live issue related to namespace resources, do not select "none".
- If the request may depend on current cluster or namespace state, do not select "none" just because the latest message is short or ambiguous.
- If the user mentions public access, external access, 公网, 外网, domain, 域名, CNAME, host, route, ingress, external IP, HTTPS, SSL, certificate, 证书, port exposure, or "访问不到", prefer "list_ingress_by_ns" as the first live-state check unless the request is specifically about certificate issuance or renewal status.
- If the user specifically asks about certificate issuance, renewal, or secure certificate status after domain configuration, prefer "list_certificate_by_ns".
- If the user mentions 欠费, 余额不足, 扣费, 充值后, 费用异常, suspend, release, 被释放, 停服, or post-recharge abnormality, prefer "list_debt_by_ns".
- If the user mentions DevBox, devbox, VS Code, Cursor, Trae, SSH, remote connection, IDE connection, DevBox startup, restart, release, sharing, or DevBox availability, prefer "list_devbox_by_ns".
- If the user explicitly asks for logs, stdout, stderr, stack trace, or runtime output, prefer "get_logs_by_ns".
- When several tools look possible, choose the tool that is the best first live-state inspection for the user's current complaint. Do not choose "none" merely because the message is brief.

Examples:
User: 远程连接不上
Return: {"action":"tool","selectedTool":"list_devbox_by_ns","toolInput":{},"reason":"DevBox connectivity needs live namespace evidence"}

User: Trae无法连接
Return: {"action":"tool","selectedTool":"list_devbox_by_ns","toolInput":{},"reason":"DevBox IDE connectivity needs DevBox status"}

User: 余额不足被释放了
Return: {"action":"tool","selectedTool":"list_debt_by_ns","toolInput":{},"reason":"billing suspension should inspect debt state"}

User: 充钱后中的项目还是找不到
Return: {"action":"tool","selectedTool":"list_debt_by_ns","toolInput":{},"reason":"post-recharge recovery should inspect debt state"}

User: 公网域名无法访问
Return: {"action":"tool","selectedTool":"list_ingress_by_ns","toolInput":{},"reason":"external access should inspect ingress first"}

User: 如何查看应用的对外ip？
Return: {"action":"tool","selectedTool":"list_ingress_by_ns","toolInput":{},"reason":"external IP is exposed by ingress state"}

User: ingress
Return: {"action":"tool","selectedTool":"list_ingress_by_ns","toolInput":{},"reason":"ingress request needs ingress state"}

User: 谢谢，知道了
Return: {"action":"none","toolInput":{},"reason":"acknowledgement only"}

Output Format:
You MUST return a strictly valid JSON object. No markdown.
Structure:
{
  "action": "tool|final|insufficient|none",
  "selectedTool": "tool_name_from_above",
  "toolInput": {},
  "finalAnswer": "",
  "customerReplyDraft": "",
  "missingEvidence": [],
  "escalationAdvice": [],
  "reason": ""
}
Note:
- Do not add namespace into toolInput. The server injects trusted namespace.
- For describe_resource_summary_by_ns, provide kind and name only when evidence already identifies a target resource.
`;

const structuredRouter = llm.withStructuredOutput(routerDecisionSchema);
const structuredRouterWithRaw = llm.withStructuredOutput(routerDecisionSchema, { includeRaw: true });

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

    if (isDevelopment) {
      const rawResponse = await structuredRouterWithRaw.invoke(messages) as RouterStructuredResponse;
      logDevelopment('[Router] AI raw response:', formatLogValue(rawResponse.raw));

      if (!rawResponse.parsed) {
        throw new Error('[Router] AI raw response could not be parsed');
      }

      decision = rawResponse.parsed;
    } else {
      decision = await structuredRouter.invoke(messages) as RouterDecision;
    }

    console.log('[Router] AI structured decision:', JSON.stringify(decision));

    if (decision.action === 'tool' && !decision.selectedTool) {
      throw new Error('[Router] AI selected tool action without selectedTool');
    }

    const toolInput =
      decision.toolInput &&
      typeof decision.toolInput === 'object' &&
      !Array.isArray(decision.toolInput)
        ? decision.toolInput
        : {};

    return {
      ...decision,
      selectedTool: decision.selectedTool as AgentToolName | undefined,
      toolInput
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
