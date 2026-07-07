export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  age?: string;
  ip?: string;
  node?: string;
}

export interface KubernetesError {
  code?: number;
  reason?: string;
  message: string;
  details?: any;
}

export interface ResourceRef {
  apiVersion?: string;
  kind: string;
  namespace?: string;
  name: string;
  role?: string;
}

export interface OmittedField {
  path: string;
  reason: string;
  count?: number;
}

export interface ContainerStatusProjection {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: string;
  reason?: string;
  message?: string;
  lastTerminationReason?: string;
}

export interface EndpointProjection {
  serviceName: string;
  ready: number;
  notReady: number;
  ports: string[];
  source: 'endpoints' | 'endpointslice' | 'none';
  error?: KubernetesError;
}

export interface ReplicaProjection {
  desired?: number;
  ready?: number;
  available?: number;
  updated?: number;
  unavailable?: number;
}

export interface StatusProjection {
  phase?: string;
  ready?: string | boolean;
  reason?: string;
  message?: string;
  conditions: ConditionSummary[];
  replicas?: ReplicaProjection;
  containers?: ContainerStatusProjection[];
  endpoints?: EndpointProjection[];
}

export interface SpecProjection {
  selector?: Record<string, string>;
  ports?: string[];
  images?: string[];
  hosts?: string[];
  paths?: string[];
  backendServices?: ResourceRef[];
  tlsSecrets?: ResourceRef[];
  uses?: {
    configMaps?: ResourceRef[];
    secrets?: ResourceRef[];
    pvcs?: ResourceRef[];
    serviceAccount?: ResourceRef;
  };
}

export interface KubernetesResourceSummary {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  age?: string;
  labels?: Record<string, string>;
  annotationKeys?: string[];
  owners: ResourceRef[];
  status: StatusProjection;
  spec: SpecProjection;
  diagnosticSignals: string[];
  refs: ResourceRef[];
  omitted: OmittedField[];
}

export interface KubernetesListCoverage {
  status: 'complete' | 'partial';
  pages: number;
  returned: number;
  remainingItemCount?: number;
  truncated: boolean;
  message?: string;
}

export interface KubernetesDetailCoverage {
  status: 'complete' | 'partial';
  truncated: boolean;
  omittedSections: string[];
  message?: string;
}

export interface KubectlGetListResult {
  success: boolean;
  namespace: string;
  resource: string;
  apiVersion: string;
  kind: string;
  mode: 'list';
  output: 'summary';
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  items: KubernetesResourceSummary[];
  total: number;
  coverage: KubernetesListCoverage;
  redactions: Array<{ path: string; reason: string }>;
  error?: KubernetesError;
}

export interface KubectlGetDetailResult {
  success: boolean;
  namespace: string;
  resource: string;
  apiVersion: string;
  kind: string;
  name: string;
  mode: 'detail';
  output: 'yaml';
  manifest?: unknown;
  summary?: KubernetesResourceSummary;
  redactions: Array<{ path: string; reason: string }>;
  omitted: OmittedField[];
  coverage: KubernetesDetailCoverage;
  error?: KubernetesError;
}

export interface DescribeDiagnosis {
  health: 'healthy' | 'degraded' | 'unknown';
  primarySignals: string[];
  failedConditions: ConditionSummary[];
  nextChecks: string[];
  evidenceGaps: string[];
}

export interface RelatedResourceBlock {
  role: string;
  items: ResourceRef[];
  truncated: boolean;
  error?: KubernetesError;
}

export interface KubectlDescribeResult {
  success: boolean;
  namespace: string;
  resource: string;
  apiVersion: string;
  kind: string;
  name: string;
  summary?: KubernetesResourceSummary;
  diagnosis?: DescribeDiagnosis;
  relatedEvents: EventInfo[];
  relatedResources?: RelatedResourceBlock[];
  manifest?: unknown;
  redactions?: Array<{ path: string; reason: string }>;
  omitted?: OmittedField[];
  error?: KubernetesError;
}

export interface LogSourceResult {
  podName: string;
  containerName: string;
  previous: boolean;
  logs: string;
  lineCount: number;
  empty: boolean;
  truncated: boolean;
  error?: KubernetesError;
}

export interface PodLogCandidate {
  podName: string;
  status?: string;
  ready?: string;
  restarts?: number;
  containers: string[];
  age?: string;
}

export interface LogsCoverage {
  matchedPods: number;
  queriedPods: number;
  omittedPods: string[];
  queriedSources: number;
  truncated: boolean;
  message?: string;
}

export interface KubectlLogsResult {
  success: boolean;
  namespace: string;
  podName?: string;
  labelSelector?: string;
  container?: string;
  allContainers?: boolean;
  previous?: boolean;
  tailLines: number;
  sinceSeconds?: number;
  timestamps: boolean;
  limitBytes?: number;
  sources: LogSourceResult[];
  podCandidates?: PodLogCandidate[];
  containerCandidates?: string[];
  coverage: LogsCoverage;
  resolution?: 'resolved' | 'no_match' | 'ambiguous_container' | 'partial';
  message?: string;
  error?: KubernetesError;
}

export interface PodExecTargetCandidate {
  podName: string;
  status?: string;
  ready?: string;
  restarts?: number;
  containers: string[];
  age?: string;
}

export interface PodExecTargetCoverage {
  matchedPods: number;
  queriedPods: number;
  omittedPods: string[];
  truncated: boolean;
  message?: string;
}

export type PodExecToolResolution =
  | 'resolved'
  | 'no_match'
  | 'ambiguous_pod'
  | 'ambiguous_container'
  | 'invalid_container'
  | 'pod_not_running'
  | 'invalid_input'
  | 'unavailable'
  | 'command_failed';

export interface ListeningPort {
  protocol: string;
  localAddress: string;
  port: number;
  state?: string;
  source: 'ss' | 'netstat' | 'proc';
}

export interface ListPodListeningPortsResult {
  success: boolean;
  namespace: string;
  podName?: string;
  labelSelector?: string;
  container?: string;
  resolvedPodName?: string;
  resolvedContainerName?: string;
  ports: ListeningPort[];
  total: number;
  coverage: PodExecTargetCoverage;
  resolution: PodExecToolResolution;
  probe?: string;
  commandPath?: string;
  podCandidates?: PodExecTargetCandidate[];
  containerCandidates?: string[];
  message?: string;
  error?: KubernetesError;
}

export interface DiskUsageSummary {
  path: string;
  sizeHuman: string;
  source: 'du';
}

export interface DuSummaryResult {
  success: boolean;
  namespace: string;
  podName?: string;
  labelSelector?: string;
  container?: string;
  resolvedPodName?: string;
  resolvedContainerName?: string;
  path: string;
  diskUsage?: DiskUsageSummary;
  total: number;
  coverage: PodExecTargetCoverage;
  resolution: PodExecToolResolution;
  commandPath?: string;
  podCandidates?: PodExecTargetCandidate[];
  containerCandidates?: string[];
  message?: string;
  error?: KubernetesError;
}

export interface EventsCoverage {
  returned: number;
  limit: number;
  truncated: boolean;
  fieldSelector?: string;
}

export interface KubectlEventsResult {
  success: boolean;
  namespace: string;
  resource?: string;
  name?: string;
  events: EventInfo[];
  total: number;
  coverage: EventsCoverage;
  error?: KubernetesError;
}

export interface ListPodsResponse {
  namespace: string;
  pods: PodInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface QuotaInfo {
  name: string;
  namespace: string;
  details: string;
}

export interface ListQuotaResponse {
  namespace: string;
  quotas: QuotaInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface IngressInfo {
  name: string;
  namespace: string;
  hosts: string;
  paths: string;
  backendService: string;
  backendPort: string;
  ingressClass?: string;
  address?: string;
  age?: string;
}

export interface ListIngressResponse {
  namespace: string;
  ingresses: IngressInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// Node resource types
export interface NodeInfo {
  name: string;
  status: string;
  roles: string;
  age?: string;
  ip?: string;
  osImage?: string;
}

export interface ListNodesResponse {
  nodes: NodeInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// CronJob resource types
export interface CronJobInfo {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  active: number;
  lastSchedule?: string;
  age?: string;
}

export interface ListCronJobsResponse {
  namespace: string;
  cronjobs: CronJobInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// Event resource types
export interface EventInfo {
  severity: string;
  reason: string;
  resourceKind: string;
  resourceName: string;
  subObject: string;
  sourceComponent: string;
  sourceInstance: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export interface ListEventsResponse {
  namespace: string;
  events: EventInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// Account resource types
export interface ChargeListItem {
  type: string;
  amount: number;
  currency?: string;
}

export interface AccountStatus {
  type?: string;
  balance?: number;
  creationTime?: string;
  chargeList?: ChargeListItem[];
  [key: string]: any;
}

export interface AccountInfo {
  name: string;
  namespace: string;
  status?: AccountStatus;
  age?: string;
}

export interface ListAccountResponse {
  namespace: string;
  accounts: AccountInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// Debt resource types
export interface DebtStatusRecord {
  type: string;
  amount: number;
  status: string;
  dueDate?: string;
  [key: string]: any;
}

export interface DebtStatus {
  type?: string;
  totalDebt?: number;
  debtStatusRecords?: DebtStatusRecord[];
  [key: string]: any;
}

export interface DebtInfo {
  name: string;
  namespace: string;
  status?: DebtStatus;
  age?: string;
}

export interface ListDebtResponse {
  namespace: string;
  debts: DebtInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface KubeConfigInfo {
  cluster: string;
  user: string;
  namespace: string;
}

// ObjectStorageBucket resource types
export interface ObjectStorageBucketInfo {
  name: string;
  namespace: string;
  policy: string;
  size: string;
  bucketName: string;
  age?: string;
}

export interface ListObjectStorageBucketResponse {
  namespace: string;
  objectstoragebuckets: ObjectStorageBucketInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

// Certificate resource types
export interface CertificateInfo {
  name: string;
  namespace: string;
  ready: string;
  secret: string;
  issuer: string;
  notAfter: string;
  age?: string;
}

export interface ListCertificateResponse {
  namespace: string;
  certificates: CertificateInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface DeploymentInfo {
  name: string;
  ready: string;
  updatedReplicas: number;
  availableReplicas: number;
  age?: string;
  containers: string;
  images: string;
  selector: string;
  paused: boolean;
}

export interface ListDeploymentsResponse {
  namespace: string;
  deployments: DeploymentInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface StatefulSetInfo {
  name: string;
  ready: string;
  age?: string;
  containers: string;
  images: string;
  storage: string;
  paused: boolean;
}

export interface ListStatefulSetsResponse {
  namespace: string;
  statefulsets: StatefulSetInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export type AppInfo =
  | ({ kind: 'Deployment' } & DeploymentInfo)
  | ({ kind: 'StatefulSet' } & StatefulSetInfo);

export interface ListAppsResponse {
  namespace: string;
  apps: AppInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface PVCInfo {
  name: string;
  status: string;
  volume: string;
  capacity: string;
  accessModes: string;
  storageClass: string;
  age?: string;
  volumeMode: string;
}

export interface ListPvcsResponse {
  namespace: string;
  pvcs: PVCInfo[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface LogPodCandidate {
  podName: string;
  workloadName: string;
  status: string;
  ready: string;
  restarts: number;
  containers: string[];
  age?: string;
}

export interface GetLogsResponse {
  namespace: string;
  moduleHint: string;
  resolution: 'resolved' | 'ambiguous_pod' | 'ambiguous_container' | 'no_match';
  query: string;
  message: string;
  selectedPod?: string;
  selectedContainer?: string;
  logSource?: 'current' | 'previous';
  logs?: string;
  podCandidates?: LogPodCandidate[];
  containerCandidates?: string[];
  error?: KubernetesError;
  success: boolean;
}

export interface ConditionSummary {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ServiceSummary {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  externalIPs: string[];
  ports: string[];
  selector: Record<string, string>;
  readyEndpoints: number;
  notReadyEndpoints: number;
  age?: string;
}

export interface ListServicesResponse {
  namespace: string;
  services: ServiceSummary[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface JobSummary {
  name: string;
  namespace: string;
  completions: string;
  succeeded: number;
  failed: number;
  active: number;
  startTime?: string;
  completionTime?: string;
  age?: string;
  conditions: ConditionSummary[];
}

export interface ListJobsResponse {
  namespace: string;
  jobs: JobSummary[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface CrdResourceSummary {
  name: string;
  namespace: string;
  apiVersion?: string;
  kind?: string;
  status?: string;
  phase?: string;
  type?: string;
  target?: string;
  age?: string;
  conditions: ConditionSummary[];
}

export interface ListOpsRequestsResponse {
  namespace: string;
  opsrequests: CrdResourceSummary[];
  total: number;
  sourceApi?: string;
  error?: KubernetesError;
  success: boolean;
}

export interface ListBackupsResponse {
  namespace: string;
  backups: CrdResourceSummary[];
  total: number;
  sourceApi?: string;
  error?: KubernetesError;
  success: boolean;
}

export interface ListInstancesResponse {
  namespace: string;
  instances: CrdResourceSummary[];
  total: number;
  sourceApi?: string;
  error?: KubernetesError;
  success: boolean;
}

export interface ObjectStorageUserSummary {
  name: string;
  namespace: string;
  bucketCount?: number;
  buckets?: Array<{ name: string; policy?: string; size?: string; age?: string }>;
  status?: string;
  age?: string;
}

export interface ListObjectStorageUserSummaryResponse {
  namespace: string;
  users: ObjectStorageUserSummary[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}

export interface ResourceSummaryResponse {
  namespace: string;
  kind: string;
  name: string;
  summary?: Record<string, unknown>;
  relatedEvents: EventInfo[];
  error?: KubernetesError;
  success: boolean;
}

export interface SearchResultMatch {
  root: string;
  path: string;
  line?: number;
  snippet: string;
}

export interface SearchToolResponse {
  query: string;
  matches: SearchResultMatch[];
  total: number;
  error?: KubernetesError;
  success: boolean;
}
