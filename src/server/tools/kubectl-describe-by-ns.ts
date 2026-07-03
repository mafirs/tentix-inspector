import { KubernetesClient } from '../kubernetes/client';
import { extractKubernetesError } from './common';
import { KubectlDescribeByNsInput, KubectlDescribeByNsInputSchema } from './types';
import { findKubectlResource } from './kubectl-resource-registry';
import { listRelatedEvents, readKubectlResource } from './kubectl-resource-reader';
import { sanitizeKubernetesObject } from './kubectl-sanitize';

export async function kubectlDescribeByNamespace(
  client: KubernetesClient,
  input: KubectlDescribeByNsInput
): Promise<unknown> {
  const { namespace, resource, name, apiVersion } = KubectlDescribeByNsInputSchema.parse(input);
  const resourceDefinition = findKubectlResource(resource, apiVersion);

  if (!resourceDefinition) {
    return {
      namespace,
      resource,
      name,
      relatedEvents: [],
      success: false,
      error: { reason: 'Blocked', message: `resource is not supported: ${resource}` },
    };
  }

  console.error(`[Server] Executing: kubectl describe ${resourceDefinition.resource}/${name} -n ${namespace}`);

  try {
    const rawObject = await readKubectlResource(client, resourceDefinition, namespace, name);
    const sanitized = sanitizeKubernetesObject(rawObject, resourceDefinition);
    const relatedEvents = await listRelatedEvents(client, namespace, name);

    return {
      namespace,
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      kind: resourceDefinition.kind,
      name,
      manifest: sanitized.object,
      relatedEvents,
      redactions: sanitized.redactions,
      success: true,
    };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error executing kubectl describe ${resourceDefinition.resource}/${name} in namespace ${namespace}:`, {
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
      relatedEvents: [],
      error: k8sError,
      success: false,
    };
  }
}
