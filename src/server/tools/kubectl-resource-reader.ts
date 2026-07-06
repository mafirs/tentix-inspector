import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { EndpointProjection } from '../kubernetes/types';
import { KubectlResourceDefinition } from './kubectl-resource-registry';

export interface KubectlListOptions {
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  continueToken?: string;
}

export interface KubectlListAllResult {
  items: unknown[];
  pageCount: number;
  remainingItemCount?: number;
}

type RecordValue = Record<string, unknown>;

export async function listKubectlResource(
  client: KubernetesClient,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<unknown[]> {
  const page = await listKubectlResourcePage(client, resource, namespace, options);
  return page.items;
}

export async function listAllKubectlResource(
  client: KubernetesClient,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<KubectlListAllResult> {
  const items: unknown[] = [];
  let continueToken: string | undefined;
  let pageCount = 0;
  let remainingItemCount: number | undefined;

  do {
    const page = await listKubectlResourcePage(client, resource, namespace, {
      ...options,
      continueToken,
    });
    items.push(...page.items);
    pageCount += 1;
    remainingItemCount = page.remainingItemCount;
    continueToken = page.continueToken;
  } while (continueToken);

  return { items, pageCount, remainingItemCount };
}

async function listKubectlResourcePage(
  client: KubernetesClient,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<{ items: unknown[]; continueToken?: string; remainingItemCount?: number }> {
  if (resource.backend === 'core') {
    const response = await listCoreResource(client.getApiClient(), resource, namespace, options);
    return getListPage(response.body);
  }

  const response = await client.getCustomObjectsApi().listNamespacedCustomObject(
    resource.group,
    resource.version,
    namespace,
    resource.plural,
    undefined,
    undefined,
    options.continueToken,
    options.fieldSelector,
    options.labelSelector,
    options.limit
  );
  return getListPage(response.body);
}

export async function readKubectlResource(
  client: KubernetesClient,
  resource: KubectlResourceDefinition,
  namespace: string,
  name: string
): Promise<unknown> {
  if (resource.backend === 'core') {
    const response = await readCoreResource(client.getApiClient(), resource, namespace, name);
    return response.body;
  }
  const response = await client.getCustomObjectsApi().getNamespacedCustomObject(
    resource.group,
    resource.version,
    namespace,
    resource.plural,
    name
  );
  return response.body;
}

export async function listRelatedEvents(
  client: KubernetesClient,
  namespace: string,
  name: string
): Promise<unknown[]> {
  const response = await client.getApiClient().listNamespacedEvent(
    namespace,
    undefined,
    undefined,
    undefined,
    `involvedObject.name=${name}`
  );
  return response.body.items.slice(0, 20);
}

export async function listServiceEndpointReadiness(
  client: KubernetesClient,
  namespace: string,
  serviceNames: string[]
): Promise<Map<string, EndpointProjection>> {
  const uniqueServiceNames = Array.from(new Set(serviceNames.filter(Boolean)));
  const result: Map<string, EndpointProjection> = new Map(uniqueServiceNames.map((serviceName) => [
    serviceName,
    { serviceName, ready: 0, notReady: 0, ports: [], source: 'none' },
  ]));
  if (uniqueServiceNames.length === 0) {
    return result;
  }

  const [endpointsResult, endpointSlicesResult] = await Promise.allSettled([
    client.getApiClient().listNamespacedEndpoints(namespace),
    client.getCustomObjectsApi().listNamespacedCustomObject(
      'discovery.k8s.io',
      'v1',
      namespace,
      'endpointslices'
    ),
  ]);

  if (endpointsResult.status === 'fulfilled') {
    for (const endpoint of endpointsResult.value.body.items) {
      const serviceName = endpoint.metadata?.name;
      if (!serviceName || !result.has(serviceName)) {
        continue;
      }
      const projection = result.get(serviceName);
      if (!projection) {
        continue;
      }
      const subsets = endpoint.subsets ?? [];
      projection.ready += subsets.reduce((sum, subset) => sum + (subset.addresses?.length ?? 0), 0);
      projection.notReady += subsets.reduce((sum, subset) => sum + (subset.notReadyAddresses?.length ?? 0), 0);
      projection.ports.push(...subsets.flatMap((subset) => (subset.ports ?? []).map(formatEndpointPort)));
      projection.source = 'endpoints';
    }
  }

  if (endpointSlicesResult.status === 'fulfilled') {
    const body = endpointSlicesResult.value.body;
    const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
    for (const item of items) {
      const record = isRecord(item) ? item : {};
      const metadata = isRecord(record.metadata) ? record.metadata : {};
      const labels = isRecord(metadata.labels) ? metadata.labels : {};
      const serviceName = typeof labels['kubernetes.io/service-name'] === 'string'
        ? labels['kubernetes.io/service-name']
        : '';
      if (!serviceName || !result.has(serviceName)) {
        continue;
      }
      const projection = result.get(serviceName);
      if (!projection) {
        continue;
      }
      const endpoints = Array.isArray(record.endpoints) ? record.endpoints.filter(isRecord) : [];
      projection.ready += endpoints.filter((endpoint) => isEndpointSliceReady(endpoint)).length;
      projection.notReady += endpoints.filter((endpoint) => !isEndpointSliceReady(endpoint)).length;
      projection.ports.push(...(Array.isArray(record.ports) ? record.ports.filter(isRecord).map(formatEndpointSlicePort) : []));
      projection.source = 'endpointslice';
    }
  }

  return result;
}

function listCoreResource(
  api: k8s.CoreV1Api,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<{ body: { items?: unknown[] } }> {
  const fieldSelector = options.fieldSelector;
  const labelSelector = options.labelSelector;
  const limit = options.limit;
  const continueToken = options.continueToken;
  switch (resource.coreResource) {
    case 'pods':
      return api.listNamespacedPod(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'services':
      return api.listNamespacedService(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'endpoints':
      return api.listNamespacedEndpoints(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'configmaps':
      return api.listNamespacedConfigMap(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'secrets':
      return api.listNamespacedSecret(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'persistentvolumeclaims':
      return api.listNamespacedPersistentVolumeClaim(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'serviceaccounts':
      return api.listNamespacedServiceAccount(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'resourcequotas':
      return api.listNamespacedResourceQuota(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    case 'events':
      return api.listNamespacedEvent(namespace, undefined, undefined, continueToken, fieldSelector, labelSelector, limit);
    default:
      throw new Error(`unsupported core resource: ${resource.resource}`);
  }
}

function readCoreResource(
  api: k8s.CoreV1Api,
  resource: KubectlResourceDefinition,
  namespace: string,
  name: string
): Promise<{ body: unknown }> {
  switch (resource.coreResource) {
    case 'pods':
      return api.readNamespacedPod(name, namespace);
    case 'services':
      return api.readNamespacedService(name, namespace);
    case 'endpoints':
      return api.readNamespacedEndpoints(name, namespace);
    case 'configmaps':
      return api.readNamespacedConfigMap(name, namespace);
    case 'secrets':
      return api.readNamespacedSecret(name, namespace);
    case 'persistentvolumeclaims':
      return api.readNamespacedPersistentVolumeClaim(name, namespace);
    case 'serviceaccounts':
      return api.readNamespacedServiceAccount(name, namespace);
    case 'resourcequotas':
      return api.readNamespacedResourceQuota(name, namespace);
    case 'events':
      return api.readNamespacedEvent(name, namespace);
    default:
      throw new Error(`unsupported core resource: ${resource.resource}`);
  }
}

function getListPage(body: unknown): { items: unknown[]; continueToken?: string; remainingItemCount?: number } {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as { items?: unknown[]; metadata?: { continue?: string; remainingItemCount?: number } }
    : {};
  const metadata = typeof record.metadata === 'object' && record.metadata !== null
    ? record.metadata as { continue?: string; remainingItemCount?: number }
    : {};
  return {
    items: Array.isArray(record.items) ? record.items : [],
    continueToken: metadata.continue || undefined,
    remainingItemCount: typeof metadata.remainingItemCount === 'number' ? metadata.remainingItemCount : undefined,
  };
}

function formatEndpointPort(port: k8s.CoreV1EndpointPort): string {
  return [port.name, port.port, port.protocol].filter(Boolean).join('/');
}

function formatEndpointSlicePort(port: RecordValue): string {
  return [port.name, port.port, port.protocol].map(toText).filter(Boolean).join('/');
}

function isEndpointSliceReady(endpoint: RecordValue): boolean {
  const conditions = isRecord(endpoint.conditions) ? endpoint.conditions : {};
  return conditions.ready !== false;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
