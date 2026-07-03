import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { KubectlResourceDefinition } from './kubectl-resource-registry';

export interface KubectlListOptions {
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
}

export async function listKubectlResource(
  client: KubernetesClient,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<unknown[]> {
  if (resource.backend === 'core') {
    const response = await listCoreResource(client.getApiClient(), resource, namespace, options);
    return getItems(response.body);
  }

  const response = await client.getCustomObjectsApi().listNamespacedCustomObject(
    resource.group,
    resource.version,
    namespace,
    resource.plural,
    undefined,
    undefined,
    undefined,
    options.fieldSelector,
    options.labelSelector,
    options.limit
  );
  return getItems(response.body);
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

function listCoreResource(
  api: k8s.CoreV1Api,
  resource: KubectlResourceDefinition,
  namespace: string,
  options: KubectlListOptions
): Promise<{ body: { items?: unknown[] } }> {
  const fieldSelector = options.fieldSelector;
  const labelSelector = options.labelSelector;
  const limit = options.limit;
  switch (resource.coreResource) {
    case 'pods':
      return api.listNamespacedPod(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'services':
      return api.listNamespacedService(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'endpoints':
      return api.listNamespacedEndpoints(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'configmaps':
      return api.listNamespacedConfigMap(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'secrets':
      return api.listNamespacedSecret(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'persistentvolumeclaims':
      return api.listNamespacedPersistentVolumeClaim(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'serviceaccounts':
      return api.listNamespacedServiceAccount(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'resourcequotas':
      return api.listNamespacedResourceQuota(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
    case 'events':
      return api.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector, labelSelector, limit);
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

function getItems(body: unknown): unknown[] {
  return typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown[] }).items)
    ? (body as { items: unknown[] }).items
    : [];
}
