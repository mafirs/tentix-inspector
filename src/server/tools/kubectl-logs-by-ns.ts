import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { LogSourceResult } from '../kubernetes/types';
import { extractKubernetesError } from './common';
import { KubectlLogsByNsInput, KubectlLogsByNsInputSchema } from './types';
import { sanitizeLogText } from './kubectl-sanitize';

const DEFAULT_TAIL_LINES = 200;
const MAX_LABEL_PODS = 5;
const POD_QUERY_LIMIT = MAX_LABEL_PODS + 1;

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
      : (await k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector, POD_QUERY_LIMIT)).body.items;
    const selectedPods = pods.slice(0, MAX_LABEL_PODS);
    const omittedPods = pods.slice(MAX_LABEL_PODS).map((pod) => pod.metadata?.name).filter((name): name is string => Boolean(name));

    if (pods.length === 0) {
      return {
        namespace,
        podName,
        labelSelector,
        sources: [],
        total: 0,
        coverage: {
          matchedPods: 0,
          queriedPods: 0,
          omittedPods: [],
          queriedSources: 0,
          truncated: false,
        },
        resolution: 'no_match',
        success: true,
        message: 'No matching pods were found.',
      };
    }

    const sources: LogSourceResult[] = [];
    for (const pod of selectedPods) {
      const selectedContainers = resolveContainers(pod, container, Boolean(allContainers));
      if (selectedContainers.type === 'ambiguous') {
        return {
          namespace,
          podName: pod.metadata?.name,
          labelSelector,
          resolution: 'ambiguous_container',
          containerCandidates: selectedContainers.containerCandidates,
          sources: [],
          total: 0,
          coverage: {
            matchedPods: pods.length,
            queriedPods: 0,
            omittedPods,
            queriedSources: 0,
            truncated: omittedPods.length > 0,
            message: omittedPods.length > 0 ? 'Some matching pods were omitted from log query' : undefined,
          },
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
        const logs = sanitizeLogText((response.body || '').trim());
        sources.push({
          podName: pod.metadata?.name ?? '',
          containerName,
          previous: Boolean(previous),
          logs,
          lineCount: countLogLines(logs),
          empty: logs.length === 0,
          truncated: false,
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
      limitBytes,
      sources,
      total: sources.length,
      coverage: {
        matchedPods: pods.length,
        queriedPods: selectedPods.length,
        omittedPods,
        queriedSources: sources.length,
        truncated: omittedPods.length > 0,
        message: omittedPods.length > 0 ? 'Some matching pods were omitted from log query' : undefined,
      },
      resolution: 'resolved',
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
      coverage: {
        matchedPods: 0,
        queriedPods: 0,
        omittedPods: [],
        queriedSources: 0,
        truncated: false,
      },
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
  const regularContainerNames = (pod.spec?.containers ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  const initContainerNames = (pod.spec?.initContainers ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (requestedContainer) {
    return { type: 'resolved', containerNames: [requestedContainer] };
  }
  if (allContainers) {
    return { type: 'resolved', containerNames: regularContainerNames };
  }
  if (regularContainerNames.length <= 1) {
    return { type: 'resolved', containerNames: regularContainerNames };
  }
  const mainContainer = pickLikelyMainContainer(regularContainerNames, initContainerNames);
  if (mainContainer) {
    return { type: 'resolved', containerNames: [mainContainer] };
  }
  return { type: 'ambiguous', containerCandidates: regularContainerNames };
}

function pickLikelyMainContainer(regularContainerNames: string[], initContainerNames: string[]): string | undefined {
  const ignored = /^(istio-proxy|linkerd-proxy|envoy|sidecar|metrics|exporter|prometheus|filebeat|fluent-bit)$/i;
  const candidates = regularContainerNames.filter((name) => !ignored.test(name) && !initContainerNames.includes(name));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function countLogLines(value: string): number {
  if (!value) {
    return 0;
  }
  return value.split(/\r?\n/).length;
}
