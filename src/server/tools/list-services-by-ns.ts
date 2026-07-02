import * as k8s from '@kubernetes/client-node';
import { KubernetesClient } from '../kubernetes/client';
import { ListServicesResponse, ServiceSummary } from '../kubernetes/types';
import { ListServicesByNsInput, ListServicesByNsInputSchema } from './types';
import { calculateAge, extractKubernetesError } from './common';

export async function listServicesByNamespace(
  client: KubernetesClient,
  input: ListServicesByNsInput
): Promise<ListServicesResponse> {
  const { namespace } = ListServicesByNsInputSchema.parse(input);
  console.error(`[Server] Executing: kubectl get services,endpoints -n ${namespace}`);
  try {
    const k8sApi = client.getApiClient();
    const [servicesResult, endpointsResult] = await Promise.all([
      k8sApi.listNamespacedService(namespace),
      k8sApi.listNamespacedEndpoints(namespace),
    ]);
    const endpointsByName = new Map(endpointsResult.body.items.map((item) => [item.metadata?.name ?? '', item]));
    const services: ServiceSummary[] = servicesResult.body.items.map((service: k8s.V1Service) => {
      const endpoints = endpointsByName.get(service.metadata?.name ?? '');
      const subsets = endpoints?.subsets ?? [];
      return {
        name: service.metadata?.name || 'unknown',
        namespace: service.metadata?.namespace || namespace,
        type: service.spec?.type || 'Unknown',
        clusterIP: service.spec?.clusterIP || '',
        externalIPs: service.spec?.externalIPs ?? [],
        ports: (service.spec?.ports ?? []).map((port) => `${port.name || ''}:${port.port}->${port.targetPort ?? ''}/${port.protocol ?? ''}`),
        selector: service.spec?.selector ?? {},
        readyEndpoints: subsets.reduce((sum, subset) => sum + (subset.addresses?.length ?? 0), 0),
        notReadyEndpoints: subsets.reduce((sum, subset) => sum + (subset.notReadyAddresses?.length ?? 0), 0),
        age: calculateAge(service.metadata?.creationTimestamp),
      };
    });
    return { namespace, services, total: services.length, success: true };
  } catch (error) {
    const k8sError = extractKubernetesError(error);
    console.error(`[Server] Error listing services in namespace ${namespace}:`, {
      code: k8sError.code,
      reason: k8sError.reason,
      message: k8sError.message,
    });
    return { namespace, services: [], total: 0, error: k8sError, success: false };
  }
}
