import { KubectlResourceDefinition } from './kubectl-resource-registry';

export interface KubectlRedaction {
  path: string;
  reason: string;
}

export interface SanitizedObject {
  object: unknown;
  redactions: KubectlRedaction[];
}

const SENSITIVE_KEY_PATTERN =
  /^(authorization|token|password|passwd|secret|secretkey|accesskey|secretheader|connectionstring|dsn|kubeconfig|clientcertificate|clientkey)$/i;
const SENSITIVE_TEXT_PATTERN =
  /(authorization|token|password|passwd|secret|secretKey|accessKey|secretHeader|connectionString|dsn|kubeconfig)\s*[:=]\s*[^,\s"}]+/gi;

export function sanitizeKubernetesObject(
  value: unknown,
  resource: KubectlResourceDefinition
): SanitizedObject {
  const redactions: KubectlRedaction[] = [];
  return {
    object: sanitizeValue(value, resource, '$', redactions),
    redactions,
  };
}

export function sanitizeLogText(value: string): string {
  return value.replace(SENSITIVE_TEXT_PATTERN, '$1=[redacted]');
}

function sanitizeValue(
  value: unknown,
  resource: KubectlResourceDefinition,
  path: string,
  redactions: KubectlRedaction[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, resource, `${path}[${index}]`, redactions));
  }
  if (!isRecord(value)) {
    return typeof value === 'string' ? sanitizeLogText(value) : value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase();

    if (childPath === '$.metadata.managedFields') {
      redactions.push({ path: childPath, reason: 'managedFields omitted to keep evidence bounded' });
      continue;
    }

    if (resource.outputPolicy === 'secret_metadata' && (normalizedKey === 'data' || normalizedKey === 'stringdata')) {
      result[key] = summarizeKeyMap(child);
      redactions.push({ path: childPath, reason: 'Secret values are never returned' });
      continue;
    }

    if (resource.outputPolicy === 'configmap_keys' && (normalizedKey === 'data' || normalizedKey === 'binarydata')) {
      result[key] = summarizeKeyMap(child);
      redactions.push({ path: childPath, reason: 'ConfigMap values are not returned' });
      continue;
    }

    if (resource.outputPolicy === 'objectstorageuser_safe' && (normalizedKey === 'accesskey' || normalizedKey === 'secretkey')) {
      result[key] = '[redacted]';
      redactions.push({ path: childPath, reason: 'ObjectStorageUser credential field' });
      continue;
    }

    if (resource.outputPolicy === 'terminal_safe' && normalizedKey === 'secretheader') {
      result[key] = '[redacted]';
      redactions.push({ path: childPath, reason: 'Terminal secret header' });
      continue;
    }

    if (resource.outputPolicy === 'license_safe' && normalizedKey === 'token') {
      result[key] = '[redacted]';
      redactions.push({ path: childPath, reason: 'License token' });
      continue;
    }

    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[redacted]';
      redactions.push({ path: childPath, reason: 'sensitive field name' });
      continue;
    }

    result[key] = sanitizeValue(child, resource, childPath, redactions);
  }

  return result;
}

function summarizeKeyMap(value: unknown): unknown {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [
      key,
      {
        present: true,
        bytes: typeof rawValue === 'string' ? Buffer.byteLength(rawValue, 'utf8') : undefined,
      },
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
