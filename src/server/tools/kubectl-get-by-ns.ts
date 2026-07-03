import { KubernetesClient } from '../kubernetes/client';
import { extractKubernetesError } from './common';
import { KubectlGetByNsInput, KubectlGetByNsInputSchema } from './types';
import { findKubectlResource } from './kubectl-resource-registry';
import { listKubectlResource, readKubectlResource } from './kubectl-resource-reader';
import { KubectlRedaction, sanitizeKubernetesObject } from './kubectl-sanitize';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function kubectlGetByNamespace(
  client: KubernetesClient,
  input: KubectlGetByNsInput
): Promise<unknown> {
  const validatedInput = KubectlGetByNsInputSchema.parse(input);
  const { namespace, resource, name, apiVersion, labelSelector, fieldSelector } = validatedInput;
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

  console.error(`[Server] Executing: kubectl get ${resourceDefinition.resource}${name ? `/${name}` : ''} -n ${namespace}`);

  try {
    const rawItems = name
      ? [await readKubectlResource(client, resourceDefinition, namespace, name)]
      : await listKubectlResource(client, resourceDefinition, namespace, { labelSelector, fieldSelector, limit });
    const redactions: KubectlRedaction[] = [];
    const items = rawItems.map((item) => {
      const sanitized = sanitizeKubernetesObject(item, resourceDefinition);
      redactions.push(...sanitized.redactions);
      return sanitized.object;
    });

    return {
      namespace,
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      kind: resourceDefinition.kind,
      name,
      labelSelector,
      fieldSelector,
      limit: name ? undefined : limit,
      items,
      total: items.length,
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
      items: [],
      total: 0,
      error: k8sError,
      success: false,
    };
  }
}
