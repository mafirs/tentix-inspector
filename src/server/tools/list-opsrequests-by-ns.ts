import { KubernetesClient } from '../kubernetes/client';
import { ListOpsRequestsResponse } from '../kubernetes/types';
import { ListOpsRequestsByNsInput, ListOpsRequestsByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError, pickConditions } from './common';

const OPSREQUEST_APIS = [
  { group: 'apps.kubeblocks.io', version: 'v1alpha1', plural: 'opsrequests' },
  { group: 'apps.kubeblocks.io', version: 'v1', plural: 'opsrequests' },
];

export async function listOpsRequestsByNamespace(
  client: KubernetesClient,
  input: ListOpsRequestsByNsInput
): Promise<ListOpsRequestsResponse> {
  const { namespace } = ListOpsRequestsByNsInputSchema.parse(input);
  for (const api of OPSREQUEST_APIS) {
    try {
      const response = await client.getCustomObjectsApi().listNamespacedCustomObject(api.group, api.version, namespace, api.plural);
      const items = ((response.body as any).items ?? []).map((item: any) => ({
        name: item.metadata?.name || 'unknown',
        namespace: item.metadata?.namespace || namespace,
        apiVersion: `${api.group}/${api.version}`,
        kind: item.kind,
        status: item.status?.phase || item.status?.status || item.status?.state,
        type: item.spec?.type || item.spec?.opsType,
        target: item.spec?.clusterRef || item.spec?.targetRef?.name || item.spec?.clusterName,
        age: calculateAge(item.metadata?.creationTimestamp),
        conditions: pickConditions(item),
      }));
      return { namespace, opsrequests: items, total: items.length, sourceApi: `${api.group}/${api.version}/${api.plural}`, success: true };
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.response?.statusCode === 404) {
        continue;
      }
      const k8sError = extractKubernetesError(error);
      return { namespace, opsrequests: [], total: 0, error: k8sError, success: false };
    }
  }
  return { namespace, opsrequests: [], total: 0, error: { reason: 'NotFound', message: 'OpsRequest CRD was not found in tried API versions' }, success: false };
}
