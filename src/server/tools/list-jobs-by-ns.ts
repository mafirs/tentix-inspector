import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { JobSummary, ListJobsResponse } from '../kubernetes/types';
import { ListJobsByNsInput, ListJobsByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError, pickConditions } from './common';

export async function listJobsByNamespace(
  client: KubernetesClient,
  input: ListJobsByNsInput
): Promise<ListJobsResponse> {
  const { namespace } = ListJobsByNsInputSchema.parse(input);
  console.error(`[Server] Executing: kubectl get jobs -n ${namespace}`);
  try {
    const batchV1Api = client.getBatchV1Api();
    const jobList = await batchV1Api.listNamespacedJob(namespace);
    const jobs: JobSummary[] = jobList.body.items.map((job: k8s.V1Job) => ({
      name: job.metadata?.name || 'unknown',
      namespace: job.metadata?.namespace || namespace,
      completions: `${job.status?.succeeded ?? 0}/${job.spec?.completions ?? 1}`,
      succeeded: job.status?.succeeded ?? 0,
      failed: job.status?.failed ?? 0,
      active: job.status?.active ?? 0,
      startTime: job.status?.startTime ? new Date(job.status.startTime).toISOString() : undefined,
      completionTime: job.status?.completionTime ? new Date(job.status.completionTime).toISOString() : undefined,
      age: calculateAge(job.metadata?.creationTimestamp),
      conditions: pickConditions(job),
    }));
    return { namespace, jobs, total: jobs.length, success: true };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error listing jobs in namespace ${namespace}:`, {
      code: k8sError.code,
      reason: k8sError.reason,
      message: k8sError.message,
    });
    return { namespace, jobs: [], total: 0, error: k8sError, success: false };
  }
}
