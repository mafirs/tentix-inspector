import { ConditionSummary, KubernetesError } from '../kubernetes/types';

export function extractKubernetesError(error: any): KubernetesError {
  if (error?.response?.body) {
    const body = error.response.body;
    return {
      code: error.statusCode || error.response.statusCode,
      reason: body.reason,
      message: body.message || error.message || 'Kubernetes request failed',
      details: body.details,
    };
  }
  if (error?.body) {
    return {
      code: error.statusCode,
      message: typeof error.body === 'string' ? error.body : JSON.stringify(error.body),
    };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown error occurred',
  };
}

export function calculateAge(value?: string | Date): string | undefined {
  if (!value) {
    return undefined;
  }
  const created = value instanceof Date ? value : new Date(value);
  const diff = Date.now() - created.getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

export function pickConditions(value: any): ConditionSummary[] {
  const conditions = Array.isArray(value?.status?.conditions) ? value.status.conditions : [];
  return conditions.slice(0, 8).map((condition: any) => ({
    type: condition.type,
    status: condition.status,
    reason: condition.reason,
    message: condition.message,
    lastTransitionTime: condition.lastTransitionTime
      ? new Date(condition.lastTransitionTime).toISOString()
      : undefined,
  }));
}

export function safeMetadataName(value: any, fallback = 'unknown'): string {
  return typeof value?.metadata?.name === 'string' ? value.metadata.name : fallback;
}

export function safeNamespace(value: any, fallback: string): string {
  return typeof value?.metadata?.namespace === 'string' ? value.metadata.namespace : fallback;
}
