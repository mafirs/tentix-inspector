export type KubectlBackend = 'core' | 'custom';

export type CoreResource =
  | 'pods'
  | 'services'
  | 'endpoints'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumeclaims'
  | 'serviceaccounts'
  | 'resourcequotas'
  | 'events';

export type KubectlOutputPolicy =
  | 'default'
  | 'configmap_keys'
  | 'secret_metadata'
  | 'objectstorageuser_safe'
  | 'terminal_safe'
  | 'license_safe';

export interface KubectlResourceDefinition {
  resource: string;
  kind: string;
  apiVersion: string;
  group: string;
  version: string;
  plural: string;
  aliases: string[];
  backend: KubectlBackend;
  coreResource?: CoreResource;
  category: 'kubernetes' | 'sealos' | 'kubeblocks' | 'cert_manager';
  outputPolicy: KubectlOutputPolicy;
}

export const KUBECTL_RESOURCE_REGISTRY: KubectlResourceDefinition[] = [
  core('pods', 'Pod', 'pods', ['pod', 'po']),
  core('services', 'Service', 'services', ['service', 'svc']),
  core('endpoints', 'Endpoints', 'endpoints', ['endpoint', 'ep']),
  core('configmaps', 'ConfigMap', 'configmaps', ['configmap', 'cm'], 'configmap_keys'),
  core('secrets', 'Secret', 'secrets', ['secret'], 'secret_metadata'),
  core('persistentvolumeclaims', 'PersistentVolumeClaim', 'persistentvolumeclaims', ['persistentvolumeclaim', 'pvc']),
  core('serviceaccounts', 'ServiceAccount', 'serviceaccounts', ['serviceaccount', 'sa']),
  core('resourcequotas', 'ResourceQuota', 'resourcequotas', ['resourcequota', 'quota', 'quotas']),
  core('events', 'Event', 'events', ['event', 'ev']),

  custom('deployments', 'Deployment', 'apps/v1', 'apps', 'v1', 'deployments', ['deployment', 'deploy']),
  custom('statefulsets', 'StatefulSet', 'apps/v1', 'apps', 'v1', 'statefulsets', ['statefulset', 'sts']),
  custom('replicasets', 'ReplicaSet', 'apps/v1', 'apps', 'v1', 'replicasets', ['replicaset', 'rs']),
  custom('daemonsets', 'DaemonSet', 'apps/v1', 'apps', 'v1', 'daemonsets', ['daemonset', 'ds']),
  custom('jobs', 'Job', 'batch/v1', 'batch', 'v1', 'jobs', ['job']),
  custom('cronjobs', 'CronJob', 'batch/v1', 'batch', 'v1', 'cronjobs', ['cronjob', 'cj']),
  custom('ingresses', 'Ingress', 'networking.k8s.io/v1', 'networking.k8s.io', 'v1', 'ingresses', ['ingress', 'ing']),
  custom('networkpolicies', 'NetworkPolicy', 'networking.k8s.io/v1', 'networking.k8s.io', 'v1', 'networkpolicies', ['networkpolicy', 'netpol']),
  custom('horizontalpodautoscalers', 'HorizontalPodAutoscaler', 'autoscaling/v2', 'autoscaling', 'v2', 'horizontalpodautoscalers', ['horizontalpodautoscaler', 'hpa']),
  custom('endpointslices', 'EndpointSlice', 'discovery.k8s.io/v1', 'discovery.k8s.io', 'v1', 'endpointslices', ['endpointslice']),
  custom('roles', 'Role', 'rbac.authorization.k8s.io/v1', 'rbac.authorization.k8s.io', 'v1', 'roles', ['role']),
  custom('rolebindings', 'RoleBinding', 'rbac.authorization.k8s.io/v1', 'rbac.authorization.k8s.io', 'v1', 'rolebindings', ['rolebinding']),

  custom('certificates', 'Certificate', 'cert-manager.io/v1', 'cert-manager.io', 'v1', 'certificates', ['certificate', 'cert'], 'cert_manager'),
  custom('issuers', 'Issuer', 'cert-manager.io/v1', 'cert-manager.io', 'v1', 'issuers', ['issuer'], 'cert_manager'),

  custom('clusters', 'Cluster', 'apps.kubeblocks.io/v1alpha1', 'apps.kubeblocks.io', 'v1alpha1', 'clusters', ['cluster', 'kbcluster'], 'kubeblocks'),
  custom('opsrequests', 'OpsRequest', 'apps.kubeblocks.io/v1alpha1', 'apps.kubeblocks.io', 'v1alpha1', 'opsrequests', ['opsrequest'], 'kubeblocks'),
  custom('backups', 'Backup', 'dataprotection.kubeblocks.io/v1alpha1', 'dataprotection.kubeblocks.io', 'v1alpha1', 'backups', ['backup'], 'kubeblocks'),
  custom('migrationtasks', 'MigrationTask', 'datamigration.apecloud.io/v1alpha1', 'datamigration.apecloud.io', 'v1alpha1', 'migrationtasks', ['migrationtask'], 'kubeblocks'),
  custom('kubeblocksinstances', 'Instance', 'workloads.kubeblocks.io/v1alpha1', 'workloads.kubeblocks.io', 'v1alpha1', 'instances', ['kbinstances', 'workloadinstances'], 'kubeblocks'),

  custom('devboxes', 'Devbox', 'devbox.sealos.io/v1alpha2', 'devbox.sealos.io', 'v1alpha2', 'devboxes', ['devbox'], 'sealos'),
  custom('devboxreleases', 'DevboxRelease', 'devbox.sealos.io/v1alpha1', 'devbox.sealos.io', 'v1alpha1', 'devboxreleases', ['devboxrelease'], 'sealos'),
  custom('objectstoragebuckets', 'ObjectStorageBucket', 'objectstorage.sealos.io/v1', 'objectstorage.sealos.io', 'v1', 'objectstoragebuckets', ['objectstoragebucket', 'bucket'], 'sealos'),
  custom('objectstorageusers', 'ObjectStorageUser', 'objectstorage.sealos.io/v1', 'objectstorage.sealos.io', 'v1', 'objectstorageusers', ['objectstorageuser'], 'sealos', 'objectstorageuser_safe'),
  custom('terminals', 'Terminal', 'terminal.sealos.io/v1', 'terminal.sealos.io', 'v1', 'terminals', ['terminal'], 'sealos', 'terminal_safe'),
  custom('licenses', 'License', 'license.sealos.io/v1', 'license.sealos.io', 'v1', 'licenses', ['license'], 'sealos', 'license_safe'),
  custom('apps', 'App', 'app.sealos.io/v1', 'app.sealos.io', 'v1', 'apps', ['app'], 'sealos'),
  custom('appinstances', 'Instance', 'app.sealos.io/v1', 'app.sealos.io', 'v1', 'instances', ['instance', 'instances', 'appinstance', 'appinstances', 'templateinstance', 'templateinstances'], 'sealos'),
  custom('templates', 'Template', 'app.sealos.io/v1', 'app.sealos.io', 'v1', 'templates', ['template'], 'sealos'),
  custom('debts', 'Debt', 'account.sealos.io/v1', 'account.sealos.io', 'v1', 'debts', ['debt'], 'sealos'),
  custom('accounts', 'Account', 'account.sealos.io/v1', 'account.sealos.io', 'v1', 'accounts', ['account'], 'sealos'),
  custom('payments', 'Payment', 'account.sealos.io/v1', 'account.sealos.io', 'v1', 'payments', ['payment'], 'sealos'),
];

export function findKubectlResource(
  resource: string,
  apiVersion?: string
): KubectlResourceDefinition | undefined {
  const normalizedResource = normalizeResourceName(resource);
  const candidates = KUBECTL_RESOURCE_REGISTRY.filter((item) =>
    [item.resource, item.plural, item.kind, ...item.aliases].some(
      (value) => normalizeResourceName(value) === normalizedResource
    )
  );
  if (apiVersion) {
    return candidates.find((item) => item.apiVersion === apiVersion);
  }
  if (normalizedResource === 'instance' || normalizedResource === 'instances') {
    return candidates.find((item) => item.apiVersion === 'app.sealos.io/v1' && item.plural === 'instances');
  }
  return candidates.length === 1 ? candidates[0] : candidates.find((item) => item.resource === normalizedResource);
}

export function listSupportedKubectlResources(): Array<Omit<KubectlResourceDefinition, 'backend' | 'coreResource'>> {
  return KUBECTL_RESOURCE_REGISTRY.map(({ backend, coreResource, ...item }) => item);
}

function core(
  resource: CoreResource,
  kind: string,
  plural: string,
  aliases: string[],
  outputPolicy: KubectlOutputPolicy = 'default'
): KubectlResourceDefinition {
  return {
    resource,
    kind,
    apiVersion: 'v1',
    group: '',
    version: 'v1',
    plural,
    aliases,
    backend: 'core',
    coreResource: resource,
    category: 'kubernetes',
    outputPolicy,
  };
}

function custom(
  resource: string,
  kind: string,
  apiVersion: string,
  group: string,
  version: string,
  plural: string,
  aliases: string[],
  category: KubectlResourceDefinition['category'] = 'kubernetes',
  outputPolicy: KubectlOutputPolicy = 'default'
): KubectlResourceDefinition {
  return { resource, kind, apiVersion, group, version, plural, aliases, backend: 'custom', category, outputPolicy };
}

function normalizeResourceName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
}
