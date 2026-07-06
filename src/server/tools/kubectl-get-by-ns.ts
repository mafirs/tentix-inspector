import { KubernetesClient } from '../kubernetes/client';
import { EndpointProjection } from '../kubernetes/types';
import { buildResourceSummary, extractKubernetesError } from './common';
import { KubectlGetByNsInput, KubectlGetByNsInputSchema } from './types';
import { findKubectlResource } from './kubectl-resource-registry';
import { listAllKubectlResource, listServiceEndpointReadiness, readKubectlResource } from './kubectl-resource-reader';
import { KubectlRedaction, sanitizeKubernetesObject } from './kubectl-sanitize';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function kubectlGetByNamespace(
  client: KubernetesClient,
  input: KubectlGetByNsInput
): Promise<unknown> {
  const validatedInput = KubectlGetByNsInputSchema.parse(input);
  const { namespace, resource, name, apiVersion, labelSelector, fieldSelector } = validatedInput;
  const output = validatedInput.output ?? 'summary';
  const limit = Math.min(validatedInput.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const resourceDefinition = findKubectlResource(resource, apiVersion);

  if (!resourceDefinition) {
    return {
      namespace,
      resource,
      total: 0,
      success: false,
      error: { reason: 'Blocked', message: `resource is not supported: ${resource}` },
    };
  }

  if (output === 'yaml' && !name) {
    return {
      namespace,
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      kind: resourceDefinition.kind,
      name,
      mode: 'detail',
      output,
      manifest: undefined,
      redactions: [],
      omitted: [],
      coverage: {
        status: 'partial',
        truncated: false,
        omittedSections: [],
        message: 'yaml detail requires name',
      },
      success: false,
      error: { reason: 'InvalidInput', message: 'kubectl_get_by_ns output=yaml requires an exact name' },
    };
  }

  console.error(`[Server] Executing: kubectl get ${resourceDefinition.resource}${name ? `/${name}` : ''} -n ${namespace}`);

  try {
    const redactions: KubectlRedaction[] = [];
    if (name) {
      const rawObject = await readKubectlResource(client, resourceDefinition, namespace, name);
      const sanitized = sanitizeKubernetesObject(rawObject, resourceDefinition);
      redactions.push(...sanitized.redactions);
      const endpointReadinessByService = await buildEndpointReadinessContext(client, namespace, resourceDefinition.resource, [sanitized.object]);
      const summary = buildResourceSummary(sanitized.object, resourceDefinition, namespace, { endpointReadinessByService });
      if (output === 'yaml') {
        return {
          namespace,
          resource: resourceDefinition.resource,
          apiVersion: resourceDefinition.apiVersion,
          kind: resourceDefinition.kind,
          name,
          mode: 'detail',
          output,
          manifest: sanitized.object,
          summary,
          redactions,
          omitted: summary.omitted,
          coverage: {
            status: 'complete',
            truncated: false,
            omittedSections: summary.omitted.map((item) => item.path),
          },
          success: true,
        };
      }
      return {
        namespace,
        resource: resourceDefinition.resource,
        apiVersion: resourceDefinition.apiVersion,
        kind: resourceDefinition.kind,
        name,
        mode: 'list',
        output: 'summary',
        items: [summary],
        total: 1,
        coverage: { status: 'complete', pages: 1, returned: 1, truncated: false },
        redactions,
        success: true,
      };
    }

    const listResult = await listAllKubectlResource(client, resourceDefinition, namespace, { labelSelector, fieldSelector, limit });
    const sanitizedItems = listResult.items.map((item) => {
      const sanitized = sanitizeKubernetesObject(item, resourceDefinition);
      redactions.push(...sanitized.redactions);
      return sanitized.object;
    });
    const endpointReadinessByService = await buildEndpointReadinessContext(client, namespace, resourceDefinition.resource, sanitizedItems);
    const items = sanitizedItems.map((item) => buildResourceSummary(item, resourceDefinition, namespace, { endpointReadinessByService }));

    return {
      namespace,
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      kind: resourceDefinition.kind,
      labelSelector,
      fieldSelector,
      limit,
      mode: 'list',
      output: 'summary',
      items,
      total: items.length,
      coverage: {
        status: listResult.remainingItemCount ? 'partial' : 'complete',
        pages: listResult.pageCount,
        returned: items.length,
        remainingItemCount: listResult.remainingItemCount,
        truncated: Boolean(listResult.remainingItemCount),
        message: listResult.remainingItemCount ? 'Kubernetes API reported remaining items after paged read' : undefined,
      },
      redactions,
      success: true,
    };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error executing kubectl get ${resourceDefinition.resource} in namespace ${namespace}:`, {
      code: k8sError.code,
      reason: k8sError.reason,
      message: k8sError.message,
    });
    return {
      namespace,
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      kind: resourceDefinition.kind,
      name,
      mode: output === 'yaml' ? 'detail' : 'list',
      output,
      items: output === 'summary' ? [] : undefined,
      manifest: undefined,
      total: 0,
      coverage: output === 'yaml'
        ? { status: 'partial', truncated: false, omittedSections: [], message: k8sError.message }
        : { status: 'partial', pages: 0, returned: 0, truncated: false, message: k8sError.message },
      error: k8sError,
      success: false,
    };
  }
}

async function buildEndpointReadinessContext(
  client: KubernetesClient,
  namespace: string,
  resource: string,
  objects: unknown[]
): Promise<Map<string, EndpointProjection> | undefined> {
  const serviceNames = collectServiceNamesForEndpointLookup(resource, objects);
  return serviceNames.length > 0 ? listServiceEndpointReadiness(client, namespace, serviceNames) : undefined;
}

function collectServiceNamesForEndpointLookup(resource: string, objects: unknown[]): string[] {
  if (resource === 'services') {
    return objects.map((item) => toText(asRecord(asRecord(item)?.metadata)?.name)).filter(Boolean);
  }
  if (resource !== 'ingresses') {
    return [];
  }
  return objects.flatMap((item) => collectIngressBackendServiceNames(item));
}

function collectIngressBackendServiceNames(value: unknown): string[] {
  const spec = asRecord(asRecord(value)?.spec);
  if (!spec) {
    return [];
  }
  const defaultBackend = toText(asRecord(asRecord(spec.defaultBackend)?.service)?.name);
  const ruleBackends = asArray(spec.rules)
    .filter(isRecord)
    .flatMap((rule) => asArray(asRecord(rule.http)?.paths).filter(isRecord))
    .map((path) => toText(asRecord(asRecord(path.backend)?.service)?.name))
    .filter(Boolean);
  return [defaultBackend, ...ruleBackends].filter(Boolean);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
