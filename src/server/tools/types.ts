import { z } from 'zod';

export const ListPodsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});


export type ListPodsByNsInput = z.infer<typeof ListPodsByNsInputSchema>;

export const LIST_PODS_BY_NS_TOOL = {
  name: 'list_pods_by_ns',
  description: 'List all pods in a namespace. Prefer this for first-pass runtime overview and abnormal target identification, especially when users report symptoms like "公网准备中", "网站打不开", "应用起不来", "服务异常", "一直重启", or "不知道是哪一个实例有问题". Use this before events or logs when the exact abnormal workload is still unclear.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list pods from',
      },
    },
    required: ['namespace'],
  },
};


export const ListDevboxByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListDevboxByNsInput = z.infer<typeof ListDevboxByNsInputSchema>;

export const LIST_DEVBOX_BY_NS_TOOL = {
  name: 'list_devbox_by_ns',
  description: 'List all DevBox CRD instances in a namespace. Prefer this for DevBox product-level diagnosis, especially when users report DevBox stuck in executing or starting, unable to boot, release or deploy stuck, SSH or IDE connection problems, public access problems, or general DevBox environment availability issues. This is not the primary tool for container stdout/stderr; use logs when runtime process evidence inside the DevBox workload is needed.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list devboxes from',
      },
    },
    required: ['namespace'],
  },
};

// 4) Cluster 资源（KubeBlocks CRD）- 与 Pod 工具结构完全相同
export const ListClusterByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListClusterByNsInput = z.infer<typeof ListClusterByNsInputSchema>;

export const LIST_CLUSTER_BY_NS_TOOL = {
  name: 'list_cluster_by_ns',
  description: 'List database clusters (KubeBlocks) in a namespace. Prefer this for Sealos Database (数据库) resource-level diagnosis, such as instance status, deployment phase, component health, timeout-related resource abnormality, connection information, scaling state, monitoring-related state, or whether the database resource itself is abnormal. Use logs only when runtime database process output is needed after the instance has been identified.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list clusters from',
      },
    },
    required: ['namespace'],
  },
};

// 5) Quota 资源 - 与 Pod 工具结构完全相同
export const ListQuotaByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListQuotaByNsInput = z.infer<typeof ListQuotaByNsInputSchema>;

export const LIST_QUOTA_BY_NS_TOOL = {
  name: 'list_quota_by_ns',
  description: 'List resource quotas in a namespace. Prefer this when users report that apps, databases, or DevBox instances cannot be created, expanded, or started because of resource limits, insufficient CPU or memory, storage quota exhaustion, or platform-side capacity restrictions. This is not the tool for application runtime errors inside containers.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list quotas from',
      },
    },
    required: ['namespace'],
  },
};

// 6) Ingress 资源 - 与 Pod 工具结构完全相同
export const ListIngressByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListIngressByNsInput = z.infer<typeof ListIngressByNsInputSchema>;

export const LIST_INGRESS_BY_NS_TOOL = {
  name: 'list_ingress_by_ns',
  description: 'List Ingress resources in a namespace. Prefer this when users report custom domain, external access (外网访问), CNAME resolution, HTTPS, host routing, or port exposure problems, especially for cases like "域名解析正常但还是访问不了", "公网访问不到服务", or "证书/域名配置后仍无法从外部访问". This is not the first tool for application runtime exceptions inside the container.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list Ingress resources from',
      },
    },
    required: ['namespace'],
  },
};

export const NONE_TOOL = {
  name: 'none',
  description: 'Return this tool when the current user input does not require querying cluster resources right now, such as greetings, thanks, or discussion/questions that can be answered from existing context. Also use this when the current turn is only continuing an explanation of already retrieved results and no fresh cluster state is needed. Do not use this tool if the user is correcting, clarifying, or refining a previous query target, refusing escalation but still expecting troubleshooting to continue, or if the previous diagnosis was directed at the wrong resource and the user is redirecting to a different one. Do not use this tool if answering the current request depends on checking live cluster or namespace state.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ============================================================================
// 工具组 3：按 namespace 列出 Kubernetes 原生资源（续）
// ============================================================================

// 8) CronJob 资源 - 与 Pod 工具结构完全相同
export const ListCronjobsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListCronjobsByNsInput = z.infer<typeof ListCronjobsByNsInputSchema>;

export const LIST_CRONJOBS_BY_NS_TOOL = {
  name: 'list_cronjobs_by_ns',
  description: 'List CronJob resources in a namespace. Prefer this when users report scheduled tasks not running, tasks running at the wrong time, repeated scheduled job failures, missing batch executions, or Laf Cron Trigger (定时任务) problems. This is the scheduling-layer tool, not the primary tool for diagnosing runtime stdout/stderr inside an already identified pod.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list CronJob resources from',
      },
    },
    required: ['namespace'],
  },
};

// 9) Events 资源 - 与 Pod 工具结构完全相同
export const ListEventsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListEventsByNsInput = z.infer<typeof ListEventsByNsInputSchema>;

export const LIST_EVENTS_BY_NS_TOOL = {
  name: 'list_events_by_ns',
  description: 'List recent Kubernetes events (last 100) in a namespace. Prefer this when the platform is likely blocking, killing, or rejecting the workload, such as Pending, FailedScheduling, ErrImagePull, ImagePullBackOff, Evicted, OOMKilled, mount failures, probe failures, node issues, or resource-related startup failures. Do not use this as the default first step for generic "公网准备中", "网站打不开", or "服务起不来" unless there is reason to suspect a Kubernetes lifecycle failure.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list Event resources from',
      },
    },
    required: ['namespace'],
  },
};

// ============================================================================
// 工具组 4：按 namespace 列出 CRD 资源
// ============================================================================

// 10) Debt CRD - 与 Pod 工具结构完全相同
export const ListDebtByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListDebtByNsInput = z.infer<typeof ListDebtByNsInputSchema>;

export const LIST_DEBT_BY_NS_TOOL = {
  name: 'list_debt_by_ns',
  description: 'List Debt CRD resources in a namespace. Prefer this when users report instances being suspended, stopped, deleted, still abnormal after recharge, or showing signs of billing-related shutdown. Use this to diagnose arrears (欠费), grace-period, or post-recharge recovery issues rather than application runtime failures.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list Debt CRD resources from',
      },
    },
    required: ['namespace'],
  },
};

// 11) ObjectStorageBucket CRD - 与 Pod 工具结构完全相同
export const ListObjectStorageBucketByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListObjectStorageBucketByNsInput = z.infer<typeof ListObjectStorageBucketByNsInputSchema>;

export const LIST_OBJECTSTORAGEBUCKET_BY_NS_TOOL = {
  name: 'list_objectstoragebucket_by_ns',
  description: 'List ObjectStorageBucket CRD resources in a namespace. Prefer this when users report Sealos Object Storage (对象存储) problems such as bucket not existing, bucket access permission issues, public/private policy problems, static website hosting problems, SDK connection errors, or bucket-level configuration issues. Do not use PVC tools for these object storage bucket problems.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list ObjectStorageBucket CRD resources from',
      },
    },
    required: ['namespace'],
  },
};

// 12) Certificate CRD - 与 Pod 工具结构完全相同
export const ListCertificateByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListCertificateByNsInput = z.infer<typeof ListCertificateByNsInputSchema>;

export const LIST_CERTIFICATE_BY_NS_TOOL = {
  name: 'list_certificate_by_ns',
  description: 'List Certificate CRD resources in a namespace. Prefer this when users report HTTPS failures, SSL certificate issuance or renewal problems, custom domain certificate errors, or ICP filing (备案) related certificate issues, especially when the domain is configured but secure access is still failing.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list Certificate CRD resources from',
      },
    },
    required: ['namespace'],
  },
};

export const ListDeploymentsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListDeploymentsByNsInput = z.infer<typeof ListDeploymentsByNsInputSchema>;

export const LIST_DEPLOYMENTS_BY_NS_TOOL = {
  name: 'list_deployments_by_ns',
  description: 'List Deployment resources in a namespace. Prefer this when you specifically need to isolate stateless application workloads after identifying that the issue belongs to Sealos App Launchpad (应用管理), especially for configuration diagnosis such as replica state, image rollout, stateless workload readiness, or confirming that the target app is managed as a Deployment. Prefer list_apps_by_ns first unless stateless workloads must be isolated.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list Deployment resources from',
      },
    },
    required: ['namespace'],
  },
};

export const ListStatefulSetsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListStatefulSetsByNsInput = z.infer<typeof ListStatefulSetsByNsInputSchema>;

export const LIST_STATEFULSETS_BY_NS_TOOL = {
  name: 'list_statefulsets_by_ns',
  description: 'List StatefulSet resources in a namespace. Prefer this when you specifically need to isolate stateful application workloads after identifying that the issue belongs to Sealos App Launchpad (应用管理), especially for persistent storage, mounted data paths, volume-backed workloads, replica identity, or confirming that the target app is managed as a StatefulSet. Prefer list_apps_by_ns first unless stateful workloads must be isolated.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list StatefulSet resources from',
      },
    },
    required: ['namespace'],
  },
};

export const ListAppsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListAppsByNsInput = z.infer<typeof ListAppsByNsInputSchema>;

export const LIST_APPS_BY_NS_TOOL = {
  name: 'list_apps_by_ns',
  description: 'List application workloads (combined Deployments and StatefulSets) in a namespace. This is the PRIMARY tool for configuration-level diagnosis of Sealos App Launchpad (应用管理) apps, especially when users report environment variables not taking effect, startup commands being wrong, image names or versions being incorrect, ports being misconfigured, storage settings being wrong, or general app configuration changes not applying as expected. This is not the primary tool for runtime stdout/stderr evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list application workloads from',
      },
    },
    required: ['namespace'],
  },
};

export const ListPvcsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type ListPvcsByNsInput = z.infer<typeof ListPvcsByNsInputSchema>;

export const LIST_PVCS_BY_NS_TOOL = {
  name: 'list_pvcs_by_ns',
  description: 'List PersistentVolumeClaim (PVC) resources in a namespace. Prefer this when users report 本地存储, 持久化存储, 存储卷, 挂载路径, volume mount, 重启后数据丢失, disk full, storage exhaustion, or PVC Pending/Bound issues, especially for Sealos App Launchpad (应用管理) and Database workloads. STRICTLY DO NOT use this for Object Storage (对象存储) bucket issues.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to list PVC resources from',
      },
    },
    required: ['namespace'],
  },
};

export const GetLogsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});

export type GetLogsByNsInput = z.infer<typeof GetLogsByNsInputSchema>;

export const GET_LOGS_BY_NS_TOOL = {
  name: 'get_logs_by_ns',
  description: 'Get recent container logs from the most relevant runtime workload in a namespace. The tool can automatically resolve the target pod and container from ticket context, so the user does NOT need to provide an exact pod name. Prefer this when the problem likely comes from the application or process itself, such as startup failures, repeated restarts, CrashLoopBackOff, entrypoint or command errors, runtime exceptions, backend startup failures, "local works but Sealos fails", application-level connection/subscription errors, or cases where the service is running but business behavior is abnormal. Do NOT prefer this as the first step for Pending, FailedScheduling, ImagePullBackOff, PVC/storage, custom domain/Ingress/SSL, quota, or billing issues unless runtime stdout/stderr evidence is clearly needed after other checks.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to get logs from',
      },
    },
    required: ['namespace'],
  },
};

export const ListServicesByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListServicesByNsInput = z.infer<typeof ListServicesByNsInputSchema>;
export const LIST_SERVICES_BY_NS_TOOL = {
  name: 'list_services_by_ns',
  description: 'List Services and endpoint readiness in a namespace. Prefer this after ingress or app checks when external or internal access may fail because service selectors, ports, or endpoints are wrong.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const ListJobsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListJobsByNsInput = z.infer<typeof ListJobsByNsInputSchema>;
export const LIST_JOBS_BY_NS_TOOL = {
  name: 'list_jobs_by_ns',
  description: 'List Kubernetes Jobs in a namespace. Prefer this for one-off task failures, backup jobs, restore jobs, migration jobs, and CronJob-created workload failures.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const ListOpsRequestsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListOpsRequestsByNsInput = z.infer<typeof ListOpsRequestsByNsInputSchema>;
export const LIST_OPSREQUESTS_BY_NS_TOOL = {
  name: 'list_opsrequests_by_ns',
  description: 'List database OpsRequest-like CRDs in a namespace. Prefer this for database start, stop, scale, upgrade, restart, backup, restore, or operation stuck cases.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const ListBackupsByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListBackupsByNsInput = z.infer<typeof ListBackupsByNsInputSchema>;
export const LIST_BACKUPS_BY_NS_TOOL = {
  name: 'list_backups_by_ns',
  description: 'List backup-like CRDs in a namespace. Prefer this when database or app data backup, restore, snapshot, or backup retention is involved.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const ListInstancesByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListInstancesByNsInput = z.infer<typeof ListInstancesByNsInputSchema>;
export const LIST_INSTANCES_BY_NS_TOOL = {
  name: 'list_instances_by_ns',
  description: 'List instance-like database runtime CRDs in a namespace. Prefer this after cluster checks when database runtime instance status or per-instance readiness is needed.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const ListObjectStorageUserSummaryByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
});
export type ListObjectStorageUserSummaryByNsInput = z.infer<typeof ListObjectStorageUserSummaryByNsInputSchema>;
export const LIST_OBJECTSTORAGE_USER_SUMMARY_BY_NS_TOOL = {
  name: 'list_objectstorage_user_summary_by_ns',
  description: 'Summarize object storage user and bucket status in a namespace without returning access keys, secret keys, tokens, or connection strings.',
  inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] },
};

export const DescribeResourceSummaryByNsInputSchema = z.object({
  namespace: z.string().min(1, 'Namespace is required'),
  kind: z.string().min(1, 'Kind is required'),
  name: z.string().min(1, 'Name is required'),
  apiVersion: z.string().optional(),
});
export type DescribeResourceSummaryByNsInput = z.infer<typeof DescribeResourceSummaryByNsInputSchema>;
export const DESCRIBE_RESOURCE_SUMMARY_BY_NS_TOOL = {
  name: 'describe_resource_summary_by_ns',
  description: 'Describe a single allowed namespace-scoped resource by kind/name and return status, conditions, owner references, selected labels, and related events only. Never returns full manifests or Secret data.',
  inputSchema: {
    type: 'object',
    properties: { namespace: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' }, apiVersion: { type: 'string' } },
    required: ['namespace', 'kind', 'name'],
  },
};

export const SearchKnowledgeInputSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  limit: z.number().int().positive().max(10).optional(),
});
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInputSchema>;
export const SEARCH_KNOWLEDGE_TOOL = {
  name: 'search_knowledge',
  description: 'Search mounted Sealos support knowledge markdown or text files. Use it for SOP, product behavior, and troubleshooting framework; do not treat it as live cluster evidence.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
};

export const SearchSealosSourceInputSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  limit: z.number().int().positive().max(10).optional(),
  pathHint: z.string().optional(),
});
export type SearchSealosSourceInput = z.infer<typeof SearchSealosSourceInputSchema>;
export const SEARCH_SEALOS_SOURCE_TOOL = {
  name: 'search_sealos_source',
  description: 'Search mounted Sealos source code text snippets for platform behavior confirmation. It is not live cluster evidence and must not read secret-like files.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, pathHint: { type: 'string' } }, required: ['query'] },
};
