import { KubernetesClient } from '../kubernetes/client';
import { ResourceSummaryResponse } from '../kubernetes/types';
import { DescribeResourceSummaryByNsInput, DescribeResourceSummaryByNsInputSchema } from './types';
import { kubectlDescribeByNamespace } from './kubectl-describe-by-ns';

export async function describeResourceSummaryByNamespace(
  client: KubernetesClient,
  input: DescribeResourceSummaryByNsInput
): Promise<ResourceSummaryResponse> {
  const { namespace, kind, name, apiVersion } = DescribeResourceSummaryByNsInputSchema.parse(input);
  const result = await kubectlDescribeByNamespace(client, {
    namespace,
    resource: kind,
    name,
    apiVersion,
  });
  if (typeof result === 'object' && result !== null && (result as { success?: boolean }).success === false) {
    return {
      namespace,
      kind,
      name,
      relatedEvents: [],
      error: (result as { error?: any }).error,
      success: false,
    };
  }
  return {
    namespace,
    kind,
    name,
    summary: (result as { manifest?: Record<string, unknown> }).manifest ?? {},
    relatedEvents: ((result as { relatedEvents?: any[] }).relatedEvents ?? []) as any,
    success: true,
  };
}
