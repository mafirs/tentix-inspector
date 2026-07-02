export type AgentToolResultStatus =
  | 'success'
  | 'error'
  | 'no_data'
  | 'blocked'
  | 'truncated';

export interface AgentToolResult {
  status: AgentToolResultStatus;
  data?: unknown;
  summary: string;
  error?: string;
  elapsedMs: number;
  truncated: boolean;
  originalSize: number;
}

export function sanitizeToolError(error: unknown): string {
  if (typeof error === 'string') {
    return redactSensitiveText(error);
  }
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (isRecord(error)) {
    const parts = [error.code, error.reason, error.message]
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .map(String);
    return redactSensitiveText(parts.join(' ').trim() || 'tool failed');
  }
  return 'tool failed';
}

export function normalizeToolResult(rawResult: unknown, elapsedMs: number): AgentToolResult {
  const original = stringifyForPreview(rawResult);
  const status = getRawResultStatus(rawResult);
  return {
    status,
    data: rawResult,
    summary: buildSummary(rawResult, status),
    error: status === 'error' ? sanitizeToolError(getRawError(rawResult)) : undefined,
    elapsedMs,
    truncated: false,
    originalSize: original.length,
  };
}

export function truncateToolResultForEvidence(
  result: AgentToolResult,
  maxChars: number
): AgentToolResult {
  const preview = stringifyForPreview(result.data);
  if (preview.length <= maxChars) {
    return result;
  }
  return {
    ...result,
    status: result.status === 'success' ? 'truncated' : result.status,
    data: `${preview.slice(0, maxChars)}\n[truncated ${preview.length - maxChars} chars]`,
    truncated: true,
    originalSize: preview.length,
  };
}

export function stringifyForPreview(value: unknown): string {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  try {
    return redactSensitiveText(JSON.stringify(value, null, 2));
  } catch {
    return redactSensitiveText(String(value));
  }
}

function getRawResultStatus(rawResult: unknown): AgentToolResultStatus {
  if (isRecord(rawResult) && rawResult.success === false) {
    return 'error';
  }
  if (isRecord(rawResult) && typeof rawResult.total === 'number' && rawResult.total === 0) {
    return 'no_data';
  }
  return 'success';
}

function getRawError(rawResult: unknown): unknown {
  return isRecord(rawResult) ? rawResult.error : undefined;
}

function buildSummary(rawResult: unknown, status: AgentToolResultStatus): string {
  if (status === 'error') {
    return sanitizeToolError(getRawError(rawResult));
  }
  if (isRecord(rawResult) && typeof rawResult.total === 'number') {
    return `status=${status}; total=${rawResult.total}`;
  }
  return `status=${status}`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization|kubeconfig|token|secret|password|accessKey|secretKey)\s*[:=]\s*[^,\s"}]+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-pem]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
