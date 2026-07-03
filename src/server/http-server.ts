import { randomUUID, timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import type { Server } from 'http';
import * as path from 'path';
import * as k8s from '@kubernetes/client-node';
import { z } from 'zod';
import { runCodexInspection } from './codex/runner';
import { runClaudeInspection } from './claude/runner';
import { CodexInspectRequest, CodexInspectResult } from './codex/types';
import { getAgentRunnable, AgentState, SUPPORTED_ZONES, ZONE_KUBECONFIG_MAP } from './agent/graph';

const app = express();
const PORT = process.env.PORT || 3000;
const CODEX_HOME = process.env.CODEX_HOME ?? '';
const AGENT_INSPECT_SKILL = process.env.AGENT_INSPECT_SKILL ?? '';
const CODEX_SKILL_ROOT = process.env.CODEX_SKILL_ROOT ?? '';
const AIPROXY_BRIDGE_ENABLED = (process.env.AIPROXY_BRIDGE_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
const AIPROXY_BRIDGE_HOST = process.env.AIPROXY_BRIDGE_HOST ?? '127.0.0.1';
const AIPROXY_BRIDGE_PORT = process.env.AIPROXY_BRIDGE_PORT ?? '18087';
const INSPECTOR_API_KEY_HEADER = 'x-tentix-inspector-key';
const SKILLS_RESPONSE_CAPTURE_ENABLED =
  (process.env.SKILLS_RESPONSE_CAPTURE_ENABLED ?? 'false').trim().toLowerCase() === 'true';
const SKILLS_RESPONSE_CAPTURE_DIR = process.env.SKILLS_RESPONSE_CAPTURE_DIR?.trim()
  ? path.resolve(process.cwd(), process.env.SKILLS_RESPONSE_CAPTURE_DIR.trim())
  : path.join(process.cwd(), 'skills-response-captures');
const DEFAULT_JSON_BODY_LIMIT = '256kb';
const JSON_BODY_LIMIT = getJsonBodyLimit();
const jsonBodyParser = express.json({ limit: JSON_BODY_LIMIT });
const DEFAULT_MAX_CONCURRENT_INSPECTIONS = 4;
const DEFAULT_MAX_PENDING_INSPECTIONS = 8;
const DEFAULT_PENDING_INSPECTION_TIMEOUT_MS = 3000;
const MAX_CONCURRENT_INSPECTIONS = getPositiveIntegerEnv(
  'MAX_CONCURRENT_INSPECTIONS',
  DEFAULT_MAX_CONCURRENT_INSPECTIONS
);
const MAX_PENDING_INSPECTIONS = getNonNegativeIntegerEnv(
  'MAX_PENDING_INSPECTIONS',
  DEFAULT_MAX_PENDING_INSPECTIONS
);
const PENDING_INSPECTION_TIMEOUT_MS = getPositiveIntegerEnv(
  'PENDING_INSPECTION_TIMEOUT_MS',
  DEFAULT_PENDING_INSPECTION_TIMEOUT_MS
);

type InspectionSlotRelease = () => void;
type PendingInspection = {
  resolve: (release: InspectionSlotRelease | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let activeInspections = 0;
const pendingInspections: PendingInspection[] = [];

const SkillsPayloadSchema = z
  .object({
    zone: z.string().optional(),
    namespace: z.string().optional(),
    ticketId: z.string().optional(),
    ticketTitle: z.string().optional(),
    ticketModule: z.string().optional(),
    ticketCategory: z.string().optional(),
    ticketDescription: z.string().optional(),
    historyMessages: z.string().optional(),
    latestMessage: z.string().optional(),
    latestMessageImages: z.array(z.string()).optional(),
    retrievedContext: z.unknown().optional(),
  })
  .passthrough();

function pickQueryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decodeRequestKubeconfig(authHeader: string): string {
  const encoded = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : authHeader;

  return decodeURIComponent(encoded).trim();
}

function isValidKubeconfig(kubeconfig: string): boolean {
  try {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromString(kubeconfig);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getJsonBodyLimit(): string {
  const limit = (process.env.JSON_BODY_LIMIT ?? DEFAULT_JSON_BODY_LIMIT).trim();

  if (/^[1-9]\d*(?:b|kb|mb)$/i.test(limit)) {
    return limit;
  }

  console.error(`[HTTP] invalid JSON_BODY_LIMIT="${limit}", fallback to ${DEFAULT_JSON_BODY_LIMIT}`);
  return DEFAULT_JSON_BODY_LIMIT;
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

  console.error(`[HTTP] invalid ${name}="${rawValue}", fallback to ${fallback}`);
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

  console.error(`[HTTP] invalid ${name}="${rawValue}", fallback to ${fallback}`);
  return fallback;
}

function safeEqualSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function getConfiguredInspectorApiKey(): string {
  return (process.env.TENTIX_INSPECTOR_API_KEY ?? '').trim();
}

function logInspectorAuthFailure(req: Request, reason: string): void {
  console.error('[HTTP] /api/skills auth failed:', {
    reason,
    ip: req.ip,
    zone: pickQueryString(req.query.zone) ?? '',
    namespace: pickQueryString(req.query.namespace) ?? '',
    userAgent: req.header('user-agent') ?? '',
  });
}

function authenticateInspectorRequest(req: Request, res: Response, next: NextFunction): void {
  const expectedApiKey = getConfiguredInspectorApiKey();

  if (!expectedApiKey) {
    logInspectorAuthFailure(req, 'server_auth_not_configured');
    res.status(500).json({ error: 'server auth is not configured' });
    return;
  }

  const actualApiKey = (req.header(INSPECTOR_API_KEY_HEADER) ?? '').trim();

  if (!actualApiKey || !safeEqualSecret(actualApiKey, expectedApiKey)) {
    logInspectorAuthFailure(req, actualApiKey ? 'invalid_api_key' : 'missing_api_key');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}

const SUPPORTED_ZONE_SET = new Set(SUPPORTED_ZONES);

function extractErrorText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    return '';
  }

  const parts: string[] = [];

  if (typeof value.code === 'string') {
    parts.push(value.code);
  }
  if (typeof value.message === 'string') {
    parts.push(value.message);
  }

  return parts.join(' ').trim();
}

function looksLikeTimeout(value: unknown): boolean {
  return /timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError/i.test(
    extractErrorText(value)
  );
}

function getSkillsResponseStatus(finalResult: unknown): number {
  if (finalResult == null) {
    return 502;
  }

  if (!isRecord(finalResult)) {
    return 200;
  }

  const result = finalResult.result;

  if (isRecord(result) && result.success === false) {
    return looksLikeTimeout(result.error) ? 504 : 502;
  }

  return 200;
}

function getSafeInspectionErrorMessage(status: number): string {
  return status === 504 ? 'inspection timed out' : 'inspection failed';
}

function sanitizeFinalResult(finalResult: unknown, status: number): unknown {
  if (!isRecord(finalResult)) {
    return finalResult;
  }

  if (finalResult.tool === 'agent_session') {
    return sanitizeAgentSessionResult(finalResult);
  }

  const result = finalResult.result;
  if (!isRecord(result) || result.success !== false) {
    return finalResult;
  }

  return {
    ...finalResult,
    result: {
      ...result,
      error: {
        message: getSafeInspectionErrorMessage(status),
      },
    },
  };
}

function sanitizeAgentSessionResult(finalResult: Record<string, unknown>): unknown {
  return {
    ...finalResult,
    trace: Array.isArray(finalResult.trace)
      ? finalResult.trace.map((entry) => sanitizeTraceEntry(entry))
      : [],
    evidence: Array.isArray(finalResult.evidence)
      ? finalResult.evidence.map((entry) => sanitizeEvidenceEntry(entry))
      : [],
  };
}

function sanitizeTraceEntry(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  return {
    ...entry,
    error: typeof entry.error === 'string' ? sanitizeSensitiveText(entry.error) : entry.error,
    resultPreview: typeof entry.resultPreview === 'string'
      ? sanitizeSensitiveText(entry.resultPreview)
      : entry.resultPreview,
    observation: typeof entry.observation === 'string'
      ? sanitizeSensitiveText(entry.observation)
      : entry.observation,
  };
}

function sanitizeEvidenceEntry(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  return {
    ...entry,
    detailsPreview: typeof entry.detailsPreview === 'string'
      ? sanitizeSensitiveText(entry.detailsPreview)
      : entry.detailsPreview,
    observation: typeof entry.observation === 'string'
      ? sanitizeSensitiveText(entry.observation)
      : entry.observation,
  };
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(/(authorization|kubeconfig|token|secret|password|accessKey|secretKey)\s*[:=]\s*[^,\s"}]+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-pem]');
}

function handleJsonParseError(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void req;

  if (isRecord(error) && error.type === 'entity.too.large') {
    res.status(413).json({ error: 'request body too large' });
    return;
  }

  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'invalid json body' });
    return;
  }

  next(error);
}

function getInspectionRetryAfterSeconds(): string {
  return String(Math.max(1, Math.ceil(PENDING_INSPECTION_TIMEOUT_MS / 1000)));
}

function sendInspectionBusyResponse(res: Response, zone: string, namespace: string): void {
  console.error('[HTTP] /api/skills concurrency limit reached:', {
    zone,
    namespace,
    active: activeInspections,
    pending: pendingInspections.length,
    maxConcurrent: MAX_CONCURRENT_INSPECTIONS,
    maxPending: MAX_PENDING_INSPECTIONS,
  });
  res.setHeader('Retry-After', getInspectionRetryAfterSeconds());
  res.status(429).json({ error: 'too many concurrent inspection requests' });
}

function serializeJsonResponseBody(responseBody: unknown): string {
  return JSON.stringify(responseBody) ?? '';
}

function sanitizeCaptureFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

async function captureSkillsResponseBody(
  zone: string,
  namespace: string,
  status: number,
  responseText: string
): Promise<void> {
  if (!SKILLS_RESPONSE_CAPTURE_ENABLED) {
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = [
    timestamp,
    sanitizeCaptureFilePart(zone),
    sanitizeCaptureFilePart(namespace),
    String(status),
    randomUUID(),
  ].join('_') + '.json';
  const filePath = path.join(SKILLS_RESPONSE_CAPTURE_DIR, filename);

  try {
    await fs.promises.mkdir(SKILLS_RESPONSE_CAPTURE_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, responseText, 'utf8');
    console.error('[HTTP] /api/skills response captured:', {
      zone,
      namespace,
      status,
      filePath,
      bytes: Buffer.byteLength(responseText, 'utf8'),
    });
  } catch (error) {
    console.error('[HTTP] /api/skills response capture failed:', {
      zone,
      namespace,
      status,
      error: extractErrorText(error),
    });
  }
}

function createInspectionSlotRelease(): InspectionSlotRelease {
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    releaseInspectionSlot();
  };
}

function releaseInspectionSlot(): void {
  activeInspections = Math.max(activeInspections - 1, 0);

  const next = pendingInspections.shift();
  if (!next) {
    return;
  }

  clearTimeout(next.timer);
  activeInspections += 1;
  next.resolve(createInspectionSlotRelease());
}

function acquireInspectionSlot(): Promise<InspectionSlotRelease | null> {
  if (activeInspections < MAX_CONCURRENT_INSPECTIONS) {
    activeInspections += 1;
    return Promise.resolve(createInspectionSlotRelease());
  }

  if (pendingInspections.length >= MAX_PENDING_INSPECTIONS) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const pendingInspection: PendingInspection = {
      resolve,
      timer: setTimeout(() => {
        const index = pendingInspections.indexOf(pendingInspection);
        if (index >= 0) {
          pendingInspections.splice(index, 1);
        }
        resolve(null);
      }, PENDING_INSPECTION_TIMEOUT_MS),
    };

    pendingInspections.push(pendingInspection);
  });
}

function sendCodexPlainText(res: Response, text: string): void {
  res.status(200).type('text/plain; charset=utf-8').send(text);
}

type InspectionAgent = 'codex' | 'claude';

function getConfiguredInspectionAgent(): InspectionAgent | null {
  const rawAgent = (process.env.AGENT ?? 'codex').trim().toLowerCase();
  if (!rawAgent || rawAgent === 'codex') {
    return 'codex';
  }
  if (rawAgent === 'claude') {
    return 'claude';
  }
  return null;
}

async function runConfiguredInspection(input: CodexInspectRequest): Promise<CodexInspectResult> {
  const agent = getConfiguredInspectionAgent();
  if (agent === 'claude') {
    return await runClaudeInspection(input);
  }
  if (agent === 'codex') {
    return await runCodexInspection(input);
  }

  const runId = randomUUID();
  console.error('[HTTP] invalid AGENT for /api/codex-inspect:', {
    runId,
    agent: process.env.AGENT ?? '',
  });
  return {
    runId,
    status: 'invalid_config',
    text: `自动诊断服务暂不可用，未生成可用结论。runId=${runId}`,
  };
}

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.get('/readyz', async (_req: Request, res: Response) => {
  const errors = await getReadinessErrors();
  if (errors.length > 0) {
    return res.status(503).json({ ok: false, errors });
  }
  return res.status(200).json({ ok: true });
});

app.post('/api/codex-inspect', authenticateInspectorRequest, jsonBodyParser, async (req: Request, res: Response) => {
  let runInput: CodexInspectRequest | null = null;

  try {
    const body = SkillsPayloadSchema.parse(req.body ?? {});
    let requestKubeconfig: string | undefined;
    const authHeader = req.header('authorization');

    if (authHeader) {
      try {
        requestKubeconfig = decodeRequestKubeconfig(authHeader);
      } catch {
        const result = await runConfiguredInspection({
          zone: '',
          namespace: '',
          ticketId: body.ticketId ?? '',
          ticketTitle: body.ticketTitle ?? '',
          ticketModule: body.ticketModule ?? '',
          ticketCategory: body.ticketCategory ?? '',
          ticketDescription: body.ticketDescription ?? '',
          historyMessages: body.historyMessages ?? '',
          latestMessage: body.latestMessage ?? '',
          latestMessageImages: body.latestMessageImages ?? [],
          requestKubeconfig: undefined,
          retrievedContext: body.retrievedContext,
          inputError: 'invalid Authorization header kubeconfig encoding',
        });
        sendCodexPlainText(res, result.text);
        return;
      }

      if (!requestKubeconfig || !isValidKubeconfig(requestKubeconfig)) {
        const result = await runConfiguredInspection({
          zone: '',
          namespace: '',
          ticketId: body.ticketId ?? '',
          ticketTitle: body.ticketTitle ?? '',
          ticketModule: body.ticketModule ?? '',
          ticketCategory: body.ticketCategory ?? '',
          ticketDescription: body.ticketDescription ?? '',
          historyMessages: body.historyMessages ?? '',
          latestMessage: body.latestMessage ?? '',
          latestMessageImages: body.latestMessageImages ?? [],
          requestKubeconfig: undefined,
          retrievedContext: body.retrievedContext,
          inputError: 'invalid kubeconfig content in Authorization header',
        });
        sendCodexPlainText(res, result.text);
        return;
      }
    }

    const zone = (pickQueryString(req.query.zone) ?? '').trim();
    const namespace = (pickQueryString(req.query.namespace) ?? '').trim();
    const inputError =
      !zone
        ? 'zone is required'
        : !namespace
          ? 'namespace is required'
          : !SUPPORTED_ZONE_SET.has(zone)
            ? `unsupported zone: ${zone}. supported zones: ${SUPPORTED_ZONES.join(', ')}`
            : !requestKubeconfig
              ? 'request kubeconfig is required'
              : '';

    runInput = {
      zone,
      namespace,
      ticketId: body.ticketId ?? '',
      ticketTitle: body.ticketTitle ?? '',
      ticketModule: body.ticketModule ?? '',
      ticketCategory: body.ticketCategory ?? '',
      ticketDescription: body.ticketDescription ?? '',
      historyMessages: body.historyMessages ?? '',
      latestMessage: body.latestMessage ?? '',
      latestMessageImages: body.latestMessageImages ?? [],
      requestKubeconfig,
      retrievedContext: body.retrievedContext,
      inputError,
    };

    const result = await runConfiguredInspection(runInput);
    sendCodexPlainText(res, result.text);
  } catch (error) {
    console.error('[HTTP] /api/codex-inspect unexpected error:', {
      error: extractErrorText(error),
      zone: runInput?.zone ?? pickQueryString(req.query.zone) ?? '',
      namespace: runInput?.namespace ?? pickQueryString(req.query.namespace) ?? '',
      ticketId: runInput?.ticketId ?? '',
    });
    sendCodexPlainText(res, '自动诊断服务暂不可用，未生成可用结论。');
  }
});

app.post('/api/skills', authenticateInspectorRequest, jsonBodyParser, async (req: Request, res: Response) => {
  try {
    const body = SkillsPayloadSchema.parse(req.body ?? {});
    let requestKubeconfig: string | undefined;
    const authHeader = req.header('authorization');

    if (authHeader) {
      try {
        requestKubeconfig = decodeRequestKubeconfig(authHeader);
      } catch {
        return res
          .status(400)
          .json({ error: 'invalid Authorization header kubeconfig encoding' });
      }

      if (!requestKubeconfig || !isValidKubeconfig(requestKubeconfig)) {
        return res.status(400).json({ error: 'invalid kubeconfig content in Authorization header' });
      }
    }

    // zone/namespace 只认 URL query；body 里同名字段一律忽略
    const zone = (pickQueryString(req.query.zone) ?? '').trim();
    const namespace = (pickQueryString(req.query.namespace) ?? '').trim();

    if (!zone) {
      return res.status(400).json({ error: 'zone is required' });
    }
    if (!namespace) {
      return res.status(400).json({ error: 'namespace is required' });
    }
    if (!SUPPORTED_ZONE_SET.has(zone)) {
      return res.status(400).json({
        error: `unsupported zone: ${zone}. supported zones: ${SUPPORTED_ZONES.join(', ')}`,
      });
    }

    const localKubeconfigPath = ZONE_KUBECONFIG_MAP[zone];

    if (!requestKubeconfig && !fs.existsSync(localKubeconfigPath)) {
      console.error('[HTTP] /api/skills kubeconfig unavailable:', {
        zone,
        namespace,
        hasRequestKubeconfig: Boolean(requestKubeconfig),
        localKubeconfigPath,
      });
      return res.status(404).json({
        error: 'cluster credentials unavailable',
      });
    }

    const initialState: AgentState = {
      zone,
      namespace,
      ticketTitle: body.ticketTitle ?? '',
      ticketModule: body.ticketModule ?? '',
      ticketCategory: body.ticketCategory ?? '',
      ticketDescription: body.ticketDescription ?? '',
      historyMessages: body.historyMessages ?? '',
      latestMessage: body.latestMessage ?? '',
      latestMessageImages: body.latestMessageImages ?? [],
      requestKubeconfig,
    };

    const releaseInspection = await acquireInspectionSlot();
    if (!releaseInspection) {
      sendInspectionBusyResponse(res, zone, namespace);
      return;
    }

    try {
      console.error(`[HTTP] /api/skills zone=${zone} namespace=${namespace}`);

      const runnable = await getAgentRunnable();
      const finalState = await runnable.invoke(initialState);
      const finalResult = finalState.finalResult ?? null;

      if (isRecord(finalResult) && finalResult.tool === 'none') {
        await captureSkillsResponseBody(zone, namespace, 204, '');
        return res.status(204).end();
      }

      const status = getSkillsResponseStatus(finalResult);
      const responseBody = sanitizeFinalResult(finalResult, status);
      const responseText = serializeJsonResponseBody(responseBody);

      await captureSkillsResponseBody(zone, namespace, status, responseText);
      res.status(status).type('application/json').send(responseText);
    } finally {
      releaseInspection();
    }
  } catch (error) {
    console.error('[HTTP] /api/skills error:', error);
    const status = looksLikeTimeout(error) ? 504 : 500;
    res.status(status).json({ error: getSafeInspectionErrorMessage(status) });
  }
});

app.use(handleJsonParseError);

async function startServer(): Promise<Server> {
  console.error('[HTTP Server] Initializing /api/skills only...');
  const server = app.listen(PORT, () => {
    console.error(`[HTTP Server] Server is running on http://localhost:${PORT}`);
    console.error(`[HTTP Server] POST http://localhost:${PORT}/api/skills`);
    console.error(`[HTTP Server] POST http://localhost:${PORT}/api/codex-inspect`);
  });
  return server;
}

startServer()
  .then((server) => {
    const shutdown = (signal: NodeJS.Signals) => {
      console.error(`[HTTP Server] Received ${signal}, shutting down...`);
      server.close((error) => {
        if (error) {
          console.error('[HTTP Server] Shutdown failed:', error);
          process.exit(1);
        }
        process.exit(0);
      });
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  })
  .catch((error) => {
    console.error('[HTTP Server] Fatal error:', error);
    process.exit(1);
  });

async function getReadinessErrors(): Promise<string[]> {
  const errors: string[] = [];
  const codexHome = CODEX_HOME.trim();
  const skillName = AGENT_INSPECT_SKILL.trim();
  const skillRoot = CODEX_SKILL_ROOT.trim();

  if (!codexHome) {
    errors.push('CODEX_HOME is required');
  } else {
    if (!fs.existsSync(codexHome) || !fs.statSync(codexHome).isDirectory()) {
      errors.push(`CODEX_HOME is not a directory: ${codexHome}`);
    }
    const configPath = `${codexHome}/config.toml`;
    if (!fs.existsSync(configPath)) {
      errors.push(`Codex config is missing: ${configPath}`);
    }
  }

  if (!skillName) {
    errors.push('AGENT_INSPECT_SKILL is required');
  }

  if (!skillRoot) {
    errors.push('CODEX_SKILL_ROOT is required');
  } else {
    const skillPath = `${skillRoot}/SKILL.md`;
    if (!fs.existsSync(skillPath)) {
      errors.push(`Codex skill is missing: ${skillPath}`);
    }
  }

  if (AIPROXY_BRIDGE_ENABLED) {
    const bridgeReady = await isBridgeReady();
    if (!bridgeReady) {
      errors.push('AI proxy bridge is not ready');
    }
  }

  return errors;
}

async function isBridgeReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://${AIPROXY_BRIDGE_HOST}:${AIPROXY_BRIDGE_PORT}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
