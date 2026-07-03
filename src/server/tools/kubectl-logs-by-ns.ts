import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { extractKubernetesError } from './common';
import { KubectlLogsByNsInput, KubectlLogsByNsInputSchema } from './types';
import { sanitizeLogText } from './kubectl-sanitize';

const DEFAULT_TAIL_LINES = 200;
const MAX_LABEL_PODS = 5;

export async function kubectlLogsByNamespace(
  client: KubernetesClient,
  input: KubectlLogsByNsInput
): Promise<unknown> {
  const validatedInput = KubectlLogsByNsInputSchema.parse(input);
  const {
    namespace,
    podName,
    labelSelector,
    container,
    allContainers,
    previous,
    sinceSeconds,
    timestamps,
  } = validatedInput;
  const tailLines = validatedInput.tailLines ?? DEFAULT_TAIL_LINES;
  const limitBytes = validatedInput.limitBytes;
  const k8sApi = client.getApiClient();

  console.error(`[Server] Executing: kubectl logs ${podName ?? `-l ${labelSelector}`} -n ${namespace}`);

  try {
    const pods = podName
      ? [(await k8sApi.readNamespacedPod(podName, namespace)).body]
      : (await k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector, MAX_LABEL_PODS)).body.items;

    if (pods.length === 0) {
      return {
        namespace,
        podName,
        labelSelector,
        sources: [],
        total: 0,
        success: true,
        message: 'No matching pods were found.',
      };
    }

    const sources = [];
    for (const pod of pods.slice(0, MAX_LABEL_PODS)) {
      const selectedContainers = resolveContainers(pod, container, Boolean(allContainers));
      if (selectedContainers.type === 'ambiguous') {
        return {
          namespace,
          podName: pod.metadata?.name,
          labelSelector,
          resolution: 'ambiguous_container',
          containerCandidates: selectedContainers.containerCandidates,
          success: true,
        };
      }
      for (const containerName of selectedContainers.containerNames) {
        const response = await k8sApi.readNamespacedPodLog(
          pod.metadata?.name ?? '',
          namespace,
          containerName,
          false,
          undefined,
          limitBytes,
          undefined,
          Boolean(previous),
          sinceSeconds,
          tailLines,
          Boolean(timestamps)
        );
        sources.push({
          podName: pod.metadata?.name ?? '',
          containerName,
          previous: Boolean(previous),
          logs: sanitizeLogText((response.body || '').trim()),
        });
      }
    }

    return {
      namespace,
      podName,
      labelSelector,
      previous: Boolean(previous),
      tailLines,
      sinceSeconds,
      timestamps: Boolean(timestamps),
      sources,
      total: sources.length,
      truncatedPods: pods.length > MAX_LABEL_PODS,
      success: true,
    };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error executing kubectl logs in namespace ${namespace}:`, {
      code: k8sError.code,
      reason: k8sError.reason,
      message: k8sError.message,
    });
    return {
      namespace,
      podName,
      labelSelector,
      sources: [],
      total: 0,
      error: k8sError,
      success: false,
    };
  }
}

type ContainerResolution =
  | { type: 'resolved'; containerNames: string[] }
  | { type: 'ambiguous'; containerCandidates: string[] };

function resolveContainers(
  pod: k8s.V1Pod,
  requestedContainer: string | undefined,
  allContainers: boolean
): ContainerResolution {
  const containerNames = [
    ...(pod.spec?.initContainers ?? []).map((item) => item.name),
    ...(pod.spec?.containers ?? []).map((item) => item.name),
  ].filter((name): name is string => Boolean(name));
  if (requestedContainer) {
    return { type: 'resolved', containerNames: [requestedContainer] };
  }
  if (allContainers || containerNames.length <= 1) {
    return { type: 'resolved', containerNames };
  }
  return { type: 'ambiguous', containerCandidates: containerNames };
}
