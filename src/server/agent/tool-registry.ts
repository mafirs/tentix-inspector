import { KubernetesClient } from '../kubernetes/client';
import {
  LIST_PODS_BY_NS_TOOL,
  LIST_DEVBOX_BY_NS_TOOL,
  LIST_CLUSTER_BY_NS_TOOL,
  LIST_QUOTA_BY_NS_TOOL,
  LIST_INGRESS_BY_NS_TOOL,
  LIST_CRONJOBS_BY_NS_TOOL,
  LIST_EVENTS_BY_NS_TOOL,
  LIST_DEBT_BY_NS_TOOL,
  LIST_OBJECTSTORAGEBUCKET_BY_NS_TOOL,
  LIST_CERTIFICATE_BY_NS_TOOL,
  LIST_DEPLOYMENTS_BY_NS_TOOL,
  LIST_STATEFULSETS_BY_NS_TOOL,
  LIST_APPS_BY_NS_TOOL,
  LIST_PVCS_BY_NS_TOOL,
  GET_LOGS_BY_NS_TOOL,
  NONE_TOOL,
  LIST_SERVICES_BY_NS_TOOL,
  LIST_JOBS_BY_NS_TOOL,
  LIST_OPSREQUESTS_BY_NS_TOOL,
  LIST_BACKUPS_BY_NS_TOOL,
  LIST_INSTANCES_BY_NS_TOOL,
  LIST_OBJECTSTORAGE_USER_SUMMARY_BY_NS_TOOL,
  DESCRIBE_RESOURCE_SUMMARY_BY_NS_TOOL,
  KUBECTL_GET_BY_NS_TOOL,
  KUBECTL_DESCRIBE_BY_NS_TOOL,
  KUBECTL_LOGS_BY_NS_TOOL,
  LIST_SUPPORTED_K8S_RESOURCES_TOOL,
  SEARCH_TEXT_TOOL,
  READ_TEXT_SLICE_TOOL,
  LIST_TEXT_FILES_TOOL,
} from '../tools/types';
import { listPodsByNamespace } from '../tools/list-pods-by-ns';
import { listDevboxByNamespace } from '../tools/list-devbox-by-ns';
import { listClusterByNamespace } from '../tools/list-cluster-by-ns';
import { listQuotaByNamespace } from '../tools/list-quota-by-ns';
import { listIngressByNamespace } from '../tools/list-ingress-by-ns';
import { listCronjobsByNamespace } from '../tools/list-cronjobs-by-ns';
import { listEventsByNamespace } from '../tools/list-events-by-ns';
import { listDebtByNamespace } from '../tools/list-debt-by-ns';
import { listObjectStorageBucketByNamespace } from '../tools/list-objectstoragebucket-by-ns';
import { listCertificateByNamespace } from '../tools/list-certificate-by-ns';
import { listDeploymentsByNamespace } from '../tools/list-deployments-by-ns';
import { listStatefulSetsByNamespace } from '../tools/list-statefulsets-by-ns';
import { listAppsByNamespace } from '../tools/list-apps-by-ns';
import { listPvcsByNamespace } from '../tools/list-pvcs-by-ns';
import { getLogsByNamespace } from '../tools/get-logs-by-ns';
import { returnNoneResult } from '../tools/none-tool';
import { listServicesByNamespace } from '../tools/list-services-by-ns';
import { listJobsByNamespace } from '../tools/list-jobs-by-ns';
import { listOpsRequestsByNamespace } from '../tools/list-opsrequests-by-ns';
import { listBackupsByNamespace } from '../tools/list-backups-by-ns';
import { listInstancesByNamespace } from '../tools/list-instances-by-ns';
import { listObjectStorageUserSummaryByNamespace } from '../tools/list-objectstorage-user-summary-by-ns';
import { describeResourceSummaryByNamespace } from '../tools/describe-resource-summary-by-ns';
import { kubectlGetByNamespace } from '../tools/kubectl-get-by-ns';
import { kubectlDescribeByNamespace } from '../tools/kubectl-describe-by-ns';
import { kubectlLogsByNamespace } from '../tools/kubectl-logs-by-ns';
import { listSupportedK8sResources } from '../tools/list-supported-k8s-resources';
import { searchText, readTextSlice, listTextFiles } from '../tools/text-file-tools';

export type AgentToolSafety = 'read_only';
export type AgentToolScope = 'namespace' | 'session' | 'local_file';
export type AgentToolCategory = 'kubernetes' | 'sealos_crd' | 'session' | 'local_file';

export interface AgentToolRunParams {
  client: KubernetesClient;
  input: Record<string, unknown>;
}

export interface AgentToolSpec {
  name: string;
  description: string;
  category: AgentToolCategory;
  safety: AgentToolSafety;
  scope: AgentToolScope;
  enabledInV1: boolean;
  requiresNamespace: boolean;
  run: (params: AgentToolRunParams) => Promise<unknown>;
}

const registry = [
  namespaceTool(LIST_SUPPORTED_K8S_RESOURCES_TOOL, 'kubernetes', async (_client, input) => listSupportedK8sResources(input)),
  namespaceTool(KUBECTL_GET_BY_NS_TOOL, 'kubernetes', kubectlGetByNamespace),
  namespaceTool(KUBECTL_DESCRIBE_BY_NS_TOOL, 'kubernetes', kubectlDescribeByNamespace),
  namespaceTool(KUBECTL_LOGS_BY_NS_TOOL, 'kubernetes', kubectlLogsByNamespace),
  namespaceTool(LIST_PODS_BY_NS_TOOL, 'kubernetes', listPodsByNamespace),
  namespaceTool(LIST_DEVBOX_BY_NS_TOOL, 'sealos_crd', listDevboxByNamespace),
  namespaceTool(LIST_CLUSTER_BY_NS_TOOL, 'sealos_crd', listClusterByNamespace),
  namespaceTool(LIST_QUOTA_BY_NS_TOOL, 'kubernetes', listQuotaByNamespace),
  namespaceTool(LIST_INGRESS_BY_NS_TOOL, 'kubernetes', listIngressByNamespace),
  namespaceTool(LIST_CRONJOBS_BY_NS_TOOL, 'kubernetes', listCronjobsByNamespace),
  namespaceTool(LIST_EVENTS_BY_NS_TOOL, 'kubernetes', listEventsByNamespace),
  namespaceTool(LIST_DEBT_BY_NS_TOOL, 'sealos_crd', listDebtByNamespace),
  namespaceTool(LIST_OBJECTSTORAGEBUCKET_BY_NS_TOOL, 'sealos_crd', listObjectStorageBucketByNamespace),
  namespaceTool(LIST_CERTIFICATE_BY_NS_TOOL, 'sealos_crd', listCertificateByNamespace),
  namespaceTool(LIST_DEPLOYMENTS_BY_NS_TOOL, 'kubernetes', listDeploymentsByNamespace),
  namespaceTool(LIST_STATEFULSETS_BY_NS_TOOL, 'kubernetes', listStatefulSetsByNamespace),
  namespaceTool(LIST_APPS_BY_NS_TOOL, 'kubernetes', listAppsByNamespace),
  namespaceTool(LIST_PVCS_BY_NS_TOOL, 'kubernetes', listPvcsByNamespace),
  namespaceTool(GET_LOGS_BY_NS_TOOL, 'kubernetes', getLogsByNamespace),
  namespaceTool(LIST_SERVICES_BY_NS_TOOL, 'kubernetes', listServicesByNamespace),
  namespaceTool(LIST_JOBS_BY_NS_TOOL, 'kubernetes', listJobsByNamespace),
  namespaceTool(LIST_OPSREQUESTS_BY_NS_TOOL, 'sealos_crd', listOpsRequestsByNamespace),
  namespaceTool(LIST_BACKUPS_BY_NS_TOOL, 'sealos_crd', listBackupsByNamespace),
  namespaceTool(LIST_INSTANCES_BY_NS_TOOL, 'sealos_crd', listInstancesByNamespace),
  namespaceTool(LIST_OBJECTSTORAGE_USER_SUMMARY_BY_NS_TOOL, 'sealos_crd', listObjectStorageUserSummaryByNamespace),
  namespaceTool(DESCRIBE_RESOURCE_SUMMARY_BY_NS_TOOL, 'kubernetes', describeResourceSummaryByNamespace),
  {
    name: NONE_TOOL.name,
    description: NONE_TOOL.description,
    category: 'session',
    safety: 'read_only',
    scope: 'session',
    enabledInV1: true,
    requiresNamespace: false,
    run: async () => returnNoneResult(),
  },
  {
    name: SEARCH_TEXT_TOOL.name,
    description: SEARCH_TEXT_TOOL.description,
    category: 'local_file',
    safety: 'read_only',
    scope: 'local_file',
    enabledInV1: true,
    requiresNamespace: false,
    run: async ({ input }) => searchText(input),
  },
  {
    name: READ_TEXT_SLICE_TOOL.name,
    description: READ_TEXT_SLICE_TOOL.description,
    category: 'local_file',
    safety: 'read_only',
    scope: 'local_file',
    enabledInV1: true,
    requiresNamespace: false,
    run: async ({ input }) => readTextSlice(input),
  },
  {
    name: LIST_TEXT_FILES_TOOL.name,
    description: LIST_TEXT_FILES_TOOL.description,
    category: 'local_file',
    safety: 'read_only',
    scope: 'local_file',
    enabledInV1: true,
    requiresNamespace: false,
    run: async ({ input }) => listTextFiles(input),
  },
] as const satisfies readonly AgentToolSpec[];

export const AGENT_TOOL_REGISTRY = registry;
export type AgentToolName = typeof registry[number]['name'];
export const AGENT_TOOL_NAMES = registry.map((tool) => tool.name) as [AgentToolName, ...AgentToolName[]];

export function getAgentTool(name: string): AgentToolSpec | undefined {
  return registry.find((tool) => tool.name === name);
}

export function listEnabledAgentTools(): AgentToolSpec[] {
  return registry.filter((tool) => tool.enabledInV1);
}

export function buildAgentToolsDescription(overrides: Record<string, string>): string {
  return listEnabledAgentTools()
    .map((tool, index) => `${index + 1}. ${tool.name}: ${overrides[tool.name] ?? tool.description}`)
    .join('\n');
}

function namespaceTool(
  metadata: { name: string; description: string },
  category: AgentToolCategory,
  run: (client: KubernetesClient, input: any) => Promise<unknown>
): AgentToolSpec {
  return {
    name: metadata.name,
    description: metadata.description,
    category,
    safety: 'read_only',
    scope: 'namespace',
    enabledInV1: true,
    requiresNamespace: true,
    run: async ({ client, input }) => run(client, input),
  };
}
