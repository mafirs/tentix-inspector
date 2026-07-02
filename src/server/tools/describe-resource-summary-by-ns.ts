import { KubernetesClient } from '../kubernetes/client';
import { ResourceSummaryResponse } from '../kubernetes/types';
import { DescribeResourceSummaryByNsInput, DescribeResourceSummaryByNsInputSchema } from './types';
import { extractKubernetesError } from './common';

const ALLOWED_KINDS = new Set([
  'pod',
  'service',
  'deployment',
  'statefulset',
  'job',
  'cronjob',
  'ingress',
  'persistentvolumeclaim',
  'pvc',
  'cluster',
  'devbox',
  'objectstoragebucket',
  'certificate',
]);

export async function describeResourceSummaryByNamespace(
  client: KubernetesClient,
  input: DescribeResourceSummaryByNsInput
): Promise<ResourceSummaryResponse> {
  const { namespace, kind, name } = DescribeResourceSummaryByNsInputSchema.parse(input);
  const normalizedKind = kind.toLowerCase();
  if (!ALLOWED_KINDS.has(normalizedKind)) {
    return {
      namespace,
      kind,
      name,
      relatedEvents: [],
      error: { reason: 'Blocked', message: `kind is not allowed for summary: ${kind}` },
      success: false,
    };
  }

  try {
    const summary = await readAllowedSummary(client, namespace, normalizedKind, name);
    const eventsResult = await client.getApiClient().listNamespacedEvent(
      namespace,
      undefined,
      undefined,
      undefined,
      `involvedObject.name=${name}`
    );
    const relatedEvents = eventsResult.body.items.slice(0, 20).map((event: any) => ({
      severity: event.type || 'Unknown',
      reason: event.reason || 'Unknown',
      resourceKind: event.involvedObject?.kind || kind,
      resourceName: event.involvedObject?.name || name,
      subObject: event.involvedObject?.fieldPath || '',
      sourceComponent: event.source?.component || event.reportingComponent || '',
      sourceInstance: event.source?.host || event.reportingInstance || '',
      message: event.message || event.note || '',
      firstSeen: event.firstTimestamp ? new Date(event.firstTimestamp).toISOString() : '',
      lastSeen: event.lastTimestamp ? new Date(event.lastTimestamp).toISOString() : '',
      count: event.count || 1,
    }));
    return { namespace, kind, name, summary, relatedEvents, success: true };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    return { namespace, kind, name, relatedEvents: [], error: k8sError, success: false };
  }
}

async function readAllowedSummary(
  client: KubernetesClient,
  namespace: string,
  kind: string,
  name: string
): Promise<Record<string, unknown>> {
  if (kind === 'pod') {
    const response = await client.getApiClient().readNamespacedPod(name, namespace);
    const pod = response.body;
    return {
      phase: pod.status?.phase,
      reason: pod.status?.reason,
      message: pod.status?.message,
      conditions: pod.status?.conditions?.slice(0, 8),
      ownerReferences: pod.metadata?.ownerReferences,
      containerStatuses: pod.status?.containerStatuses?.map((status) => ({
        name: status.name,
        ready: status.ready,
        restartCount: status.restartCount,
        state: status.state,
        lastState: status.lastState,
      })),
    };
  }
  if (kind === 'service') {
    const response = await client.getApiClient().readNamespacedService(name, namespace);
    const service = response.body;
    return { type: service.spec?.type, ports: service.spec?.ports, selector: service.spec?.selector, clusterIP: service.spec?.clusterIP };
  }
  if (kind === 'deployment') {
    const response = await client.getAppsV1Api().readNamespacedDeployment(name, namespace);
    const deployment = response.body;
    return { replicas: deployment.spec?.replicas, readyReplicas: deployment.status?.readyReplicas, availableReplicas: deployment.status?.availableReplicas, conditions: deployment.status?.conditions };
  }
  throw new Error(`summary reader is not implemented for kind=${kind}`);
}
