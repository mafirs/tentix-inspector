import { KubernetesClient } from '../kubernetes/client';
import { ListBackupsResponse } from '../kubernetes/types';
import { ListBackupsByNsInput, ListBackupsByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError, pickConditions } from './common';

const BACKUP_APIS = [
  { group: 'dataprotection.kubeblocks.io', version: 'v1alpha1', plural: 'backups' },
  { group: 'dataprotection.kubeblocks.io', version: 'v1', plural: 'backups' },
];

export async function listBackupsByNamespace(
  client: KubernetesClient,
  input: ListBackupsByNsInput
): Promise<ListBackupsResponse> {
  const { namespace } = ListBackupsByNsInputSchema.parse(input);
  for (const api of BACKUP_APIS) {
    try {
      const response = await client.getCustomObjectsApi().listNamespacedCustomObject(api.group, api.version, namespace, api.plural);
      const backups = ((response.body as any).items ?? []).map((item: any) => ({
        name: item.metadata?.name || 'unknown',
        namespace: item.metadata?.namespace || namespace,
        apiVersion: `${api.group}/${api.version}`,
        kind: item.kind,
        status: item.status?.phase || item.status?.status || item.status?.state,
        target: item.spec?.backupPolicyName || item.spec?.target?.name || item.spec?.source?.name,
        age: calculateAge(item.metadata?.creationTimestamp),
        conditions: pickConditions(item),
      }));
      return { namespace, backups, total: backups.length, sourceApi: `${api.group}/${api.version}/${api.plural}`, success: true };
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.response?.statusCode === 404) {
        continue;
      }
      const k8sError = extractKubernetesError(error);
      return { namespace, backups: [], total: 0, error: k8sError, success: false };
    }
  }
  return { namespace, backups: [], total: 0, error: { reason: 'NotFound', message: 'Backup CRD was not found in tried API versions' }, success: false };
}
