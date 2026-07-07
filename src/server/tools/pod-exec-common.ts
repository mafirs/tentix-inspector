import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, PodExecCommandResult } from '../kubernetes/client';
import { KubernetesError, PodExecTargetCandidate, PodExecTargetCoverage, PodExecToolResolution } from '../kubernetes/types';
import { calculateAge, extractKubernetesError } from './common';
import { sanitizeLogText } from './kubectl-sanitize';

const MAX_TARGET_POD_CANDIDATES = 5;
const POD_QUERY_LIMIT = MAX_TARGET_POD_CANDIDATES + 1;
const EXEC_ERROR_TEXT_LIMIT = 600;
const DENIED_DU_EXACT_PATHS = new Set(['/']);
const DENIED_DU_PATH_PREFIXES = [
  '/proc',
  '/sys',
  '/dev',
  '/run/secrets',
  '/var/run/secrets',
  '/var/run/secrets/kubernetes.io/serviceaccount',
  '/etc/secrets',
  '/secrets',
  '/etc/kubernetes',
  '/var/lib/kubelet',
  '/var/lib/containerd',
  '/var/lib/docker',
];

export interface PodExecTargetInput {
  namespace: string;
  podName?: string;
  labelSelector?: string;
  container?: string;
}

export interface PodExecTargetResolution {
  success: boolean;
  namespace: string;
  podName?: string;
  labelSelector?: string;
  container?: string;
  resolvedPodName?: string;
  resolvedContainerName?: string;
  coverage: PodExecTargetCoverage;
  resolution: PodExecToolResolution;
  podCandidates?: PodExecTargetCandidate[];
  containerCandidates?: string[];
  message?: string;
  error?: KubernetesError;
}

export interface ExecCommandCandidate {
  commandPath: string;
  argv: string[];
  probe: string;
}

type ContainerResolution =
  | { type: 'resolved'; containerName: string }
  | { type: 'ambiguous_container'; containerCandidates: string[] }
  | { type: 'invalid_container'; containerCandidates: string[] };

export async function resolveSinglePodExecTarget(
  client: KubernetesClient,
  input: PodExecTargetInput
): Promise<PodExecTargetResolution> {
  const k8sApi = client.getApiClient();
  const { namespace, podName, labelSelector, container } = input;
  try {
    const pods = podName
      ? [(await k8sApi.readNamespacedPod(podName, namespace)).body]
      : (await k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector, POD_QUERY_LIMIT)).body.items;
    const coverage = buildCoverage(pods, 0);

    if (pods.length === 0) {
      return {
        success: true,
        namespace,
        podName,
        labelSelector,
        container,
        coverage,
        resolution: 'no_match',
        message: 'No matching pods were found.',
      };
    }

    if (pods.length > 1) {
      return {
        success: true,
        namespace,
        podName,
        labelSelector,
        container,
        podCandidates: buildPodCandidates(pods.slice(0, MAX_TARGET_POD_CANDIDATES)),
        coverage,
        resolution: 'ambiguous_pod',
        message: 'Multiple matching pods were found; provide an exact podName.',
      };
    }

    const pod = pods[0];
    const resolvedPodName = pod.metadata?.name ?? podName;
    if (!resolvedPodName) {
      return {
        success: true,
        namespace,
        podName,
        labelSelector,
        container,
        coverage,
        resolution: 'no_match',
        message: 'The matching pod has no metadata.name.',
      };
    }

    if (pod.status?.phase && pod.status.phase !== 'Running') {
      return {
        success: true,
        namespace,
        podName,
        labelSelector,
        container,
        resolvedPodName,
        podCandidates: buildPodCandidates([pod]),
        coverage,
        resolution: 'pod_not_running',
        message: `Pod is not Running: ${pod.status.phase}`,
      };
    }

    const containerResolution = resolveContainer(pod, container);
    if (containerResolution.type !== 'resolved') {
      return {
        success: true,
        namespace,
        podName,
        labelSelector,
        container,
        resolvedPodName,
        containerCandidates: containerResolution.containerCandidates,
        coverage,
        resolution: containerResolution.type,
        message: containerResolution.type === 'ambiguous_container'
          ? 'Multiple regular containers were found; provide container.'
          : 'Requested container was not found in regular containers.',
      };
    }

    return {
      success: true,
      namespace,
      podName,
      labelSelector,
      container,
      resolvedPodName,
      resolvedContainerName: containerResolution.containerName,
      coverage: { ...coverage, queriedPods: 1 },
      resolution: 'resolved',
    };
  } catch (error) {
    return {
      success: false,
      namespace,
      podName,
      labelSelector,
      container,
      coverage: emptyPodExecCoverage(),
      resolution: 'unavailable',
      error: extractKubernetesError(error),
    };
  }
}

export function emptyPodExecCoverage(): PodExecTargetCoverage {
  return {
    matchedPods: 0,
    queriedPods: 0,
    omittedPods: [],
    truncated: false,
  };
}

export function sanitizeExecText(value: string): string {
  return sanitizeLogText(value).replace(/\0/g, '').slice(0, EXEC_ERROR_TEXT_LIMIT);
}

export function getExecFailureMessage(result: PodExecCommandResult): string {
  return sanitizeExecText([
    result.error,
    result.stderr,
    result.status?.message,
    result.status?.reason,
  ].filter(Boolean).join('\n') || 'pod exec failed');
}

export function buildExecKubernetesError(reason: string, message: string): KubernetesError {
  return {
    reason,
    message: sanitizeExecText(message),
  };
}

export function isCommandUnavailable(candidate: ExecCommandCandidate, result: PodExecCommandResult): boolean {
  if (result.timedOut) {
    return false;
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    return true;
  }
  const text = getExecFailureMessage(result).toLowerCase();
  const commandPath = candidate.commandPath.toLowerCase();
  return (
    text.includes('executable file not found') ||
    text.includes(`stat ${commandPath}`) ||
    ((text.includes('not found') || text.includes('no such file')) && text.includes(commandPath))
  );
}

export function getDeniedDuPathReason(rawPath: string): string | undefined {
  const normalized = normalizeContainerPathForPolicy(rawPath);
  if (DENIED_DU_EXACT_PATHS.has(normalized)) {
    return 'path is too broad';
  }
  if (normalized.split('/').filter(Boolean).includes('..')) {
    return 'path must not contain .. segments';
  }
  for (const prefix of DENIED_DU_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return `path is denied: ${prefix}`;
    }
  }
  return undefined;
}

function buildCoverage(pods: k8s.V1Pod[], queriedPods: number): PodExecTargetCoverage {
  const omittedPods = pods
    .slice(MAX_TARGET_POD_CANDIDATES)
    .map((pod) => pod.metadata?.name)
    .filter((name): name is string => Boolean(name));
  return {
    matchedPods: pods.length,
    queriedPods,
    omittedPods,
    truncated: omittedPods.length > 0,
    message: omittedPods.length > 0 ? 'Some matching pods were omitted from candidates.' : undefined,
  };
}

function buildPodCandidates(pods: k8s.V1Pod[]): PodExecTargetCandidate[] {
  return pods.map((pod) => ({
    podName: pod.metadata?.name ?? 'unknown',
    status: pod.status?.phase,
    ready: formatReady(pod),
    restarts: countRestarts(pod),
    containers: (pod.spec?.containers ?? []).map((container) => container.name).filter((name): name is string => Boolean(name)),
    age: calculateAge(pod.metadata?.creationTimestamp),
  }));
}

function resolveContainer(pod: k8s.V1Pod, requestedContainer: string | undefined): ContainerResolution {
  const regularContainerNames = (pod.spec?.containers ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  const initContainerNames = (pod.spec?.initContainers ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (requestedContainer) {
    return regularContainerNames.includes(requestedContainer)
      ? { type: 'resolved', containerName: requestedContainer }
      : { type: 'invalid_container', containerCandidates: regularContainerNames };
  }
  if (regularContainerNames.length === 1) {
    return { type: 'resolved', containerName: regularContainerNames[0] };
  }
  const mainContainer = pickLikelyMainContainer(regularContainerNames, initContainerNames);
  if (mainContainer) {
    return { type: 'resolved', containerName: mainContainer };
  }
  return { type: 'ambiguous_container', containerCandidates: regularContainerNames };
}

function pickLikelyMainContainer(regularContainerNames: string[], initContainerNames: string[]): string | undefined {
  const ignored = /^(istio-proxy|linkerd-proxy|envoy|sidecar|metrics|exporter|prometheus|filebeat|fluent-bit)$/i;
  const candidates = regularContainerNames.filter((name) => !ignored.test(name) && !initContainerNames.includes(name));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function formatReady(pod: k8s.V1Pod): string {
  const statuses = pod.status?.containerStatuses ?? [];
  const total = pod.spec?.containers?.length ?? statuses.length;
  const ready = statuses.filter((status) => status.ready).length;
  return `${ready}/${total}`;
}

function countRestarts(pod: k8s.V1Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce((sum, status) => sum + (status.restartCount ?? 0), 0);
}

function normalizeContainerPathForPolicy(rawPath: string): string {
  const collapsed = rawPath.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, '') : collapsed;
}
