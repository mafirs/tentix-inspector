import { KubernetesClient } from '../kubernetes/client';
import { ListInstancesResponse } from '../kubernetes/types';
import { ListInstancesByNsInput, ListInstancesByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError, pickConditions } from './common';

const INSTANCE_APIS = [
  { group: 'workloads.kubeblocks.io', version: 'v1alpha1', plural: 'instances' },
  { group: 'apps.kubeblocks.io', version: 'v1alpha1', plural: 'instances' },
];

export async function listInstancesByNamespace(
  client: KubernetesClient,
  input: ListInstancesByNsInput
): Promise<ListInstancesResponse> {
  const { namespace } = ListInstancesByNsInputSchema.parse(input);
  for (const api of INSTANCE_APIS) {
    try {
      const response = await client.getCustomObjectsApi().listNamespacedCustomObject(api.group, api.version, namespace, api.plural);
      const instances = ((response.body as any).items ?? []).map((item: any) => ({
        name: item.metadata?.name || 'unknown',
        namespace: item.metadata?.namespace || namespace,
        apiVersion: `${api.group}/${api.version}`,
        kind: item.kind,
        status: item.status?.phase || item.status?.status || item.status?.state,
        type: item.spec?.component || item.spec?.role || item.spec?.type,
        target: item.metadata?.labels?.['app.kubernetes.io/instance'] || item.spec?.clusterName,
        age: calculateAge(item.metadata?.creationTimestamp),
        conditions: pickConditions(item),
      }));
      return { namespace, instances, total: instances.length, sourceApi: `${api.group}/${api.version}/${api.plural}`, success: true };
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.response?.statusCode === 404) {
        continue;
      }
      const k8sError = extractKubernetesError(error);
      return { namespace, instances: [], total: 0, error: k8sError, success: false };
    }
  }
  return { namespace, instances: [], total: 0, error: { reason: 'NotFound', message: 'Instance CRD was not found in tried API versions' }, success: false };
}
