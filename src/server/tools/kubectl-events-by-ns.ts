import { KubernetesClient } from '../kubernetes/client';
import { EventInfo, KubectlEventsResult } from '../kubernetes/types';
import { buildEventSummary, extractKubernetesError } from './common';
import { findKubectlResource } from './kubectl-resource-registry';
import { KubectlEventsByNsInput, KubectlEventsByNsInputSchema } from './types';

const DEFAULT_LIMIT = 100;

export async function kubectlEventsByNamespace(
  client: KubernetesClient,
  input: KubectlEventsByNsInput
): Promise<KubectlEventsResult> {
  const validatedInput = KubectlEventsByNsInputSchema.parse(input);
  const { namespace, resource, name, apiVersion, type, reason } = validatedInput;
  const limit = validatedInput.limit ?? DEFAULT_LIMIT;
  const resourceDefinition = resource ? findKubectlResource(resource, apiVersion) : undefined;
  const fieldSelector = name ? `involvedObject.name=${name}` : undefined;

  if (resource && !resourceDefinition) {
    return {
      namespace,
      resource,
      name,
      events: [],
      total: 0,
      coverage: { returned: 0, limit, truncated: false, fieldSelector },
      success: false,
      error: { reason: 'Blocked', message: `resource is not supported: ${resource}` },
    };
  }

  console.error(`[Server] Executing: kubectl get events -n ${namespace}${name ? ` --field-selector involvedObject.name=${name}` : ''}`);

  try {
    const response = await client.getApiClient().listNamespacedEvent(
      namespace,
      undefined,
      undefined,
      undefined,
      fieldSelector
    );
    const filtered = response.body.items
      .map(buildEventSummary)
      .filter((event) => matchesResource(event, resourceDefinition?.kind))
      .filter((event) => !type || event.severity === type)
      .filter((event) => !reason || event.reason === reason)
      .sort((left, right) => new Date(right.lastSeen || 0).getTime() - new Date(left.lastSeen || 0).getTime());
    const events = filtered.slice(0, limit);
    return {
      namespace,
      resource: resourceDefinition?.resource ?? resource,
      name,
      events,
      total: events.length,
      coverage: {
        returned: events.length,
        limit,
        truncated: filtered.length > limit,
        fieldSelector,
      },
      success: true,
    };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error executing kubectl get events in namespace ${namespace}:`, {
      code: k8sError.code,
      reason: k8sError.reason,
      message: k8sError.message,
    });
    return {
      namespace,
      resource: resourceDefinition?.resource ?? resource,
      name,
      events: [],
      total: 0,
      coverage: { returned: 0, limit, truncated: false, fieldSelector },
      error: k8sError,
      success: false,
    };
  }
}

function matchesResource(event: EventInfo, kind: string | undefined): boolean {
  if (!kind) {
    return true;
  }
  return event.resourceKind.toLowerCase() === kind.toLowerCase();
}
