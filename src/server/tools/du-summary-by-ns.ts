import { KubernetesClient, PodExecCommandResult } from '../kubernetes/client';
import { DiskUsageSummary, DuSummaryResult } from '../kubernetes/types';
import { DuSummaryByNsInput, DuSummaryByNsInputSchema } from './types';
import {
  buildExecKubernetesError,
  emptyPodExecCoverage,
  ExecCommandCandidate,
  getDeniedDuPathReason,
  getExecFailureMessage,
  isCommandUnavailable,
  resolveSinglePodExecTarget,
  sanitizeExecText,
} from './pod-exec-common';

const DU_EXEC_TIMEOUT_MS = Number(process.env.AGENT_DU_EXEC_TIMEOUT_MS ?? 8_000);
const DU_EXEC_MAX_OUTPUT_BYTES = Number(process.env.AGENT_DU_EXEC_MAX_OUTPUT_BYTES ?? 16_000);

const DU_COMMAND_PATHS = ['/usr/bin/du', '/bin/du', '/usr/sbin/du', '/sbin/du'] as const;
const BUSYBOX_PATHS = ['/bin/busybox', '/busybox'] as const;

export async function duSummaryByNamespace(
  client: KubernetesClient,
  input: DuSummaryByNsInput
): Promise<DuSummaryResult> {
  const parsedInput = DuSummaryByNsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      success: false,
      namespace: getInputString(input, 'namespace') ?? '',
      podName: getInputString(input, 'podName'),
      labelSelector: getInputString(input, 'labelSelector'),
      container: getInputString(input, 'container'),
      path: getInputString(input, 'path') ?? '',
      total: 0,
      coverage: emptyPodExecCoverage(),
      resolution: 'invalid_input',
      error: buildExecKubernetesError('InvalidInput', parsedInput.error.issues.map((issue: { message: string }) => issue.message).join('; ')),
    };
  }

  const validatedInput = parsedInput.data;
  const deniedPathReason = getDeniedDuPathReason(validatedInput.path);
  if (deniedPathReason) {
    return {
      success: false,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      path: validatedInput.path,
      total: 0,
      coverage: emptyPodExecCoverage(),
      resolution: 'invalid_input',
      error: buildExecKubernetesError('InvalidPath', deniedPathReason),
    };
  }

  const target = await resolveSinglePodExecTarget(client, validatedInput);
  if (target.resolution !== 'resolved' || !target.resolvedPodName || !target.resolvedContainerName) {
    return {
      success: target.success,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      resolvedPodName: target.resolvedPodName,
      resolvedContainerName: target.resolvedContainerName,
      path: validatedInput.path,
      total: 0,
      coverage: target.coverage,
      resolution: target.resolution,
      podCandidates: target.podCandidates,
      containerCandidates: target.containerCandidates,
      message: target.message,
      error: target.error,
    };
  }

  const outcome = await runDuCandidates(
    client,
    validatedInput.namespace,
    target.resolvedPodName,
    target.resolvedContainerName,
    validatedInput.path
  );

  if (outcome.type === 'resolved') {
    return {
      success: true,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      resolvedPodName: target.resolvedPodName,
      resolvedContainerName: target.resolvedContainerName,
      path: validatedInput.path,
      diskUsage: outcome.diskUsage,
      total: 1,
      coverage: target.coverage,
      resolution: 'resolved',
      commandPath: outcome.commandPath,
    };
  }

  return {
    success: false,
    namespace: validatedInput.namespace,
    podName: validatedInput.podName,
    labelSelector: validatedInput.labelSelector,
    container: validatedInput.container,
    resolvedPodName: target.resolvedPodName,
    resolvedContainerName: target.resolvedContainerName,
    path: validatedInput.path,
    total: 0,
    coverage: target.coverage,
    resolution: outcome.commandUnavailable ? 'unavailable' : 'command_failed',
    error: buildExecKubernetesError(outcome.commandUnavailable ? 'CommandUnavailable' : 'CommandFailed', outcome.message),
  };
}

type DuOutcome =
  | { type: 'resolved'; diskUsage: DiskUsageSummary; commandPath: string }
  | { type: 'failed'; message: string; commandUnavailable: boolean };

async function runDuCandidates(
  client: KubernetesClient,
  namespace: string,
  podName: string,
  containerName: string,
  targetPath: string
): Promise<DuOutcome> {
  let lastUnavailable = 'du command was not available in the container';
  for (const candidate of buildDuCandidates(targetPath)) {
    const result = await client.execPodCommand({
      namespace,
      podName,
      containerName,
      command: candidate.argv,
      timeoutMs: DU_EXEC_TIMEOUT_MS,
      maxOutputBytes: DU_EXEC_MAX_OUTPUT_BYTES,
    });

    if (!result.timedOut && result.exitCode === 0) {
      const parsed = parseDuOutput(result, targetPath);
      if (parsed) {
        return {
          type: 'resolved',
          diskUsage: parsed,
          commandPath: candidate.commandPath,
        };
      }
      return { type: 'failed', commandUnavailable: false, message: 'du output could not be parsed' };
    }

    if (isCommandUnavailable(candidate, result)) {
      lastUnavailable = getExecFailureMessage(result);
      continue;
    }

    return {
      type: 'failed',
      commandUnavailable: false,
      message: getExecFailureMessage(result),
    };
  }

  return { type: 'failed', commandUnavailable: true, message: lastUnavailable };
}

function buildDuCandidates(targetPath: string): ExecCommandCandidate[] {
  return [
    ...DU_COMMAND_PATHS.map((commandPath) => ({
      commandPath,
      argv: [commandPath, '-s', '-h', '--', targetPath],
      probe: 'du',
    })),
    ...BUSYBOX_PATHS.map((commandPath) => ({
      commandPath,
      argv: [commandPath, 'du', '-s', '-h', targetPath],
      probe: 'busybox-du',
    })),
  ];
}

function parseDuOutput(result: PodExecCommandResult, requestedPath: string): DiskUsageSummary | undefined {
  const line = sanitizeExecText(result.stdout).trim().split(/\r?\n/)[0] ?? '';
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  return {
    path: requestedPath,
    sizeHuman: match[1],
    source: 'du',
  };
}

function getInputString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}
