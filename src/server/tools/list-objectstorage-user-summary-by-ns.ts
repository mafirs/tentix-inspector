import { KubernetesClient } from '../kubernetes/client';
import { ListObjectStorageUserSummaryResponse } from '../kubernetes/types';
import { ListObjectStorageUserSummaryByNsInput, ListObjectStorageUserSummaryByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError } from './common';

export async function listObjectStorageUserSummaryByNamespace(
  client: KubernetesClient,
  input: ListObjectStorageUserSummaryByNsInput
): Promise<ListObjectStorageUserSummaryResponse> {
  const { namespace } = ListObjectStorageUserSummaryByNsInputSchema.parse(input);
  console.error(`[Server] Executing: summarize object storage user state -n ${namespace}`);
  try {
    const response = await client.getCustomObjectsApi().listNamespacedCustomObject(
      'objectstorage.sealos.io',
      'v1',
      namespace,
      'objectstoragebuckets'
    );
    const buckets = ((response.body as any).items ?? []).map((bucket: any) => ({
      name: bucket.metadata?.name || 'unknown',
      policy: bucket.spec?.policy,
      size: bucket.status?.size ? String(bucket.status.size) : undefined,
      age: calculateAge(bucket.metadata?.creationTimestamp),
    }));
    return {
      namespace,
      users: [{
        name: namespace,
        namespace,
        bucketCount: buckets.length,
        buckets,
        status: buckets.length > 0 ? 'has_buckets' : 'no_buckets',
      }],
      total: 1,
      success: true,
    };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    return { namespace, users: [], total: 0, error: k8sError, success: false };
  }
}
