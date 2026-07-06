import {
  ConditionSummary,
  DescribeDiagnosis,
  EndpointProjection,
  EventInfo,
  KubernetesError,
  KubernetesResourceSummary,
  OmittedField,
  RelatedResourceBlock,
  ResourceRef,
} from '../kubernetes/types';
import { KubectlResourceDefinition } from './kubectl-resource-registry';

export function extractKubernetesError(error: any): KubernetesError {
  if (error && error.response && error.body) {
    const statusCode = error.statusCode || (error.response && error.response.statusCode);
    let k8sError: KubernetesError = {
      code: statusCode,
      message: 'Unknown Kubernetes error',
    };

    try {
      if (typeof error.body === 'string') {
        const errorBody = JSON.parse(error.body);
        k8sError = {
          code: errorBody.code || statusCode,
          reason: errorBody.reason,
          message: errorBody.message || error.body,
          details: errorBody.details,
        };
      } else if (typeof error.body === 'object') {
        k8sError = {
          code: error.body.code || statusCode,
          reason: error.body.reason,
          message: error.body.message || JSON.stringify(error.body),
          details: error.body.details,
        };
      }
    } catch {
      k8sError.message = error.message || 'Failed to parse Kubernetes error';
    }

    return k8sError;
  }

  return {
    message: error instanceof Error ? error.message : 'Unknown error occurred',
  };
}

export function calculateAge(value: string | Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const created = value instanceof Date ? value : new Date(value);
  const diff = Date.now() - created.getTime();
  if (!Number.isFinite(diff) || diff < 0) {
    return undefined;
  }
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days > 0) {
    return `${days}d`;
  }
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${Math.floor(diff / (1000 * 60))}m`;
}

export function pickConditions(value: any): ConditionSummary[] {
  const conditions = Array.isArray(value?.status?.conditions) ? value.status.conditions : [];
  return conditions.slice(0, 8).map((condition: any) => ({
    type: condition.type || 'Unknown',
    status: condition.status || 'Unknown',
    reason: condition.reason,
    message: condition.message,
  }));
}

export function safeMetadataName(value: any): string {
  return typeof value?.metadata?.name === 'string' ? value.metadata.name : 'unknown';
}

export function safeNamespace(value: any, fallback: string): string {
  return typeof value?.metadata?.namespace === 'string' ? value.metadata.namespace : fallback;
}

type RecordValue = Record<string, unknown>;

interface ResourceSummaryContext {
  endpointReadinessByService?: Map<string, EndpointProjection>;
}

export function buildResourceSummary(
  value: unknown,
  resource: KubectlResourceDefinition,
  namespace: string,
  context: ResourceSummaryContext = {}
): KubernetesResourceSummary {
  const record = asRecord(value) ?? {};
  const metadata = asRecord(record.metadata) ?? {};
  const spec = asRecord(record.spec) ?? {};
  const status = asRecord(record.status) ?? {};
  const name = toText(metadata.name) || 'unknown';
  const objectNamespace = toText(metadata.namespace) || namespace;
  const conditions = pickConditions(record);
  const containers = collectContainerStatuses(status);
  const backendServices = collectBackendServices(spec, objectNamespace);
  const endpoints = collectEndpointReadiness(resource, name, backendServices, context.endpointReadinessByService);
  const diagnosticSignals = buildDiagnosticSignals(record, conditions, containers, endpoints);
  const refs = collectResourceRefs(spec, objectNamespace);
  const owners = collectOwnerRefs(metadata.ownerReferences, objectNamespace);
  const omitted: OmittedField[] = [];

  return {
    apiVersion: toText(record.apiVersion) || resource.apiVersion,
    kind: toText(record.kind) || resource.kind,
    name,
    namespace: objectNamespace,
    age: calculateAge(toText(metadata.creationTimestamp)),
    labels: pickStringMap(metadata.labels, 12),
    annotationKeys: Object.keys(asRecord(metadata.annotations) ?? {}).slice(0, 20),
    owners,
    status: {
      phase: toText(status.phase),
      ready: buildReadyText(status, containers),
      reason: toText(status.reason),
      message: toText(status.message),
      conditions,
      replicas: buildReplicaProjection(spec, status),
      containers,
      endpoints,
    },
    spec: {
      selector: pickStringMap(asRecord(spec.selector)?.matchLabels ?? spec.selector, 12),
      ports: collectPorts(spec),
      images: collectImages(spec),
      hosts: collectIngressHosts(spec),
      paths: collectIngressPaths(spec),
      backendServices,
      tlsSecrets: collectTlsSecrets(spec, objectNamespace),
      uses: collectUses(spec, objectNamespace),
    },
    diagnosticSignals,
    refs: [...owners, ...refs],
    omitted,
  };
}

function collectEndpointReadiness(
  resource: KubectlResourceDefinition,
  name: string,
  backendServices: ResourceRef[],
  endpointReadinessByService: Map<string, EndpointProjection> | undefined
): EndpointProjection[] | undefined {
  if (!endpointReadinessByService) {
    return undefined;
  }
  const serviceNames = resource.resource === 'services'
    ? [name]
    : backendServices.map((service) => service.name);
  const endpoints = serviceNames
    .map((serviceName) => endpointReadinessByService.get(serviceName))
    .filter((item): item is EndpointProjection => Boolean(item));
  return endpoints.length > 0 ? endpoints : undefined;
}

export function buildEventSummary(event: unknown): EventInfo {
  const record = asRecord(event) ?? {};
  const involvedObject = asRecord(record.involvedObject) ?? asRecord(record.regarding) ?? {};
  const lastSeenRaw = record.lastTimestamp ?? record.deprecatedLastTimestamp ?? asRecord(record.series)?.lastObservedTime ?? record.eventTime;
  const firstSeenRaw = record.firstTimestamp ?? record.deprecatedFirstTimestamp ?? lastSeenRaw;
  return {
    severity: toText(record.type) || 'Unknown',
    reason: toText(record.reason) || 'Unknown',
    resourceKind: toText(involvedObject.kind) || 'Unknown',
    resourceName: toText(involvedObject.name) || 'Unknown',
    subObject: toText(involvedObject.fieldPath),
    sourceComponent: toText(asRecord(record.source)?.component) || toText(record.reportingComponent) || toText(record.reportingController),
    sourceInstance: toText(asRecord(record.source)?.host) || toText(record.reportingInstance),
    message: toText(record.message) || toText(record.note) || 'No message',
    firstSeen: formatTime(firstSeenRaw),
    lastSeen: formatTime(lastSeenRaw),
    count: toNumber(record.count ?? record.deprecatedCount ?? asRecord(record.series)?.count) || 1,
  };
}

export function buildDescribeDiagnosis(
  summary: KubernetesResourceSummary,
  events: EventInfo[]
): DescribeDiagnosis {
  const failedConditions = summary.status.conditions.filter((condition) =>
    condition.status === 'False' || condition.status === 'Unknown'
  );
  const warningEvents = events
    .filter((event) => event.severity === 'Warning')
    .slice(0, 5)
    .map((event) => `${event.reason}: ${event.message}`);
  const primarySignals = [...summary.diagnosticSignals, ...warningEvents].slice(0, 12);
  return {
    health: primarySignals.length > 0 || failedConditions.length > 0 ? 'degraded' : 'unknown',
    primarySignals,
    failedConditions,
    nextChecks: buildNextChecks(summary),
    evidenceGaps: [],
  };
}

export function buildRelatedResourceBlocks(summary: KubernetesResourceSummary): RelatedResourceBlock[] {
  const groups = new Map<string, ResourceRef[]>();
  for (const ref of summary.refs) {
    const role = ref.role || 'related';
    groups.set(role, [...(groups.get(role) ?? []), ref]);
  }
  return Array.from(groups.entries()).map(([role, items]) => ({
    role,
    items: items.slice(0, 20),
    truncated: items.length > 20,
  }));
}

function buildDiagnosticSignals(
  record: RecordValue,
  conditions: ConditionSummary[],
  containers: NonNullable<KubernetesResourceSummary['status']['containers']>,
  endpoints: EndpointProjection[] | undefined
): string[] {
  const status = asRecord(record.status) ?? {};
  const signals: string[] = [];
  const phase = toText(status.phase);
  if (phase && !['Running', 'Succeeded', 'Bound', 'Ready'].includes(phase)) {
    signals.push(`phase=${phase}`);
  }
  for (const condition of conditions) {
    if (condition.status === 'False' || condition.status === 'Unknown') {
      signals.push(`condition ${condition.type}=${condition.status}${condition.reason ? ` reason=${condition.reason}` : ''}`);
    }
  }
  for (const container of containers) {
    if (container.ready === false || container.reason || container.restartCount) {
      signals.push(`container ${container.name} ready=${container.ready} restarts=${container.restartCount ?? 0}${container.reason ? ` reason=${container.reason}` : ''}`);
    }
  }
  const replicas = buildReplicaProjection(asRecord(record.spec) ?? {}, status);
  if (replicas?.desired !== undefined && replicas.ready !== undefined && replicas.ready < replicas.desired) {
    signals.push(`replicas ready=${replicas.ready}/${replicas.desired}`);
  }
  for (const endpoint of endpoints ?? []) {
    if (endpoint.ready === 0) {
      signals.push(`service ${endpoint.serviceName} has no ready endpoints notReady=${endpoint.notReady}`);
    }
  }
  return signals.slice(0, 20);
}

function collectContainerStatuses(status: RecordValue): NonNullable<KubernetesResourceSummary['status']['containers']> {
  return [...asArray(status.initContainerStatuses), ...asArray(status.containerStatuses)]
    .filter(isRecord)
    .slice(0, 20)
    .map((container) => {
      const state = asRecord(container.state) ?? {};
      const waiting = asRecord(state.waiting);
      const terminated = asRecord(state.terminated);
      const running = asRecord(state.running);
      const lastTerminated = asRecord(asRecord(container.lastState)?.terminated);
      return {
        name: toText(container.name) || 'unknown',
        ready: typeof container.ready === 'boolean' ? container.ready : undefined,
        restartCount: typeof container.restartCount === 'number' ? container.restartCount : undefined,
        state: waiting ? 'waiting' : terminated ? 'terminated' : running ? 'running' : undefined,
        reason: toText(waiting?.reason) || toText(terminated?.reason),
        message: toText(waiting?.message) || toText(terminated?.message),
        lastTerminationReason: toText(lastTerminated?.reason),
      };
    });
}

function buildReplicaProjection(spec: RecordValue, status: RecordValue): KubernetesResourceSummary['status']['replicas'] {
  const desired = toNumber(spec.replicas ?? status.replicas);
  const ready = toNumber(status.readyReplicas);
  const available = toNumber(status.availableReplicas);
  const updated = toNumber(status.updatedReplicas);
  const unavailable = toNumber(status.unavailableReplicas);
  if ([desired, ready, available, updated, unavailable].every((value) => value === undefined)) {
    return undefined;
  }
  return { desired, ready, available, updated, unavailable };
}

function buildReadyText(
  status: RecordValue,
  containers: NonNullable<KubernetesResourceSummary['status']['containers']>
): string | undefined {
  if (containers.length > 0) {
    return `${containers.filter((container) => container.ready === true).length}/${containers.length}`;
  }
  const replicas = buildReplicaProjection({}, status);
  if (replicas?.desired !== undefined || replicas?.ready !== undefined) {
    return `${replicas.ready ?? 0}/${replicas.desired ?? replicas.ready ?? 0}`;
  }
  return undefined;
}

function collectOwnerRefs(value: unknown, namespace: string): ResourceRef[] {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 10)
    .map((owner) => ({
      apiVersion: toText(owner.apiVersion),
      kind: toText(owner.kind) || 'Unknown',
      namespace,
      name: toText(owner.name) || 'unknown',
      role: 'owner',
    }));
}

function collectResourceRefs(spec: RecordValue, namespace: string): ResourceRef[] {
  const uses = collectUses(spec, namespace);
  return [
    ...collectBackendServices(spec, namespace),
    ...collectTlsSecrets(spec, namespace),
    ...(uses.configMaps ?? []),
    ...(uses.secrets ?? []),
    ...(uses.pvcs ?? []),
    ...(uses.serviceAccount ? [uses.serviceAccount] : []),
  ];
}

function collectBackendServices(spec: RecordValue, namespace: string): ResourceRef[] {
  const defaultBackend = asRecord(asRecord(spec.defaultBackend)?.service);
  const defaultRef = defaultBackend
    ? [{
        kind: 'Service',
        namespace,
        name: toText(defaultBackend.name) || 'unknown',
        role: 'backendService',
      }]
    : [];
  const ruleRefs = asArray(spec.rules)
    .filter(isRecord)
    .flatMap((rule) => asArray(asRecord(rule.http)?.paths).filter(isRecord))
    .map((path) => asRecord(asRecord(path.backend)?.service))
    .filter(isRecord)
    .map((service) => ({
      kind: 'Service',
      namespace,
      name: toText(service.name) || 'unknown',
      role: 'backendService',
    }));
  return [...defaultRef, ...ruleRefs];
}

function collectTlsSecrets(spec: RecordValue, namespace: string): ResourceRef[] {
  return asArray(spec.tls)
    .filter(isRecord)
    .map((tls) => toText(tls.secretName))
    .filter(Boolean)
    .map((name) => ({ kind: 'Secret', namespace, name, role: 'tlsSecret' }));
}

function collectUses(spec: RecordValue, namespace: string): NonNullable<KubernetesResourceSummary['spec']['uses']> {
  const podSpec = asRecord(asRecord(spec.template)?.spec) ?? spec;
  const volumes = asArray(podSpec.volumes).filter(isRecord);
  const containers = [...asArray(podSpec.initContainers), ...asArray(podSpec.containers)].filter(isRecord);
  return {
    configMaps: [
      ...volumes.map((volume) => toText(asRecord(volume.configMap)?.name)),
      ...containers.flatMap((container) => asArray(container.envFrom).filter(isRecord).map((envFrom) => toText(asRecord(envFrom.configMapRef)?.name))),
    ].filter(Boolean).slice(0, 20).map((name) => ({ kind: 'ConfigMap', namespace, name, role: 'configMapRef' })),
    secrets: [
      ...volumes.map((volume) => toText(asRecord(volume.secret)?.secretName)),
      ...containers.flatMap((container) => asArray(container.envFrom).filter(isRecord).map((envFrom) => toText(asRecord(envFrom.secretRef)?.name))),
    ].filter(Boolean).slice(0, 20).map((name) => ({ kind: 'Secret', namespace, name, role: 'secretRef' })),
    pvcs: volumes.map((volume) => toText(asRecord(volume.persistentVolumeClaim)?.claimName)).filter(Boolean).slice(0, 20).map((name) => ({ kind: 'PersistentVolumeClaim', namespace, name, role: 'pvcRef' })),
    serviceAccount: toText(podSpec.serviceAccountName) ? { kind: 'ServiceAccount', namespace, name: toText(podSpec.serviceAccountName), role: 'serviceAccount' } : undefined,
  };
}

function collectPorts(spec: RecordValue): string[] {
  return asArray(spec.ports).filter(isRecord).slice(0, 20).map((port) =>
    [port.name, port.port, port.targetPort, port.protocol].map(toText).filter(Boolean).join('/')
  );
}

function collectImages(spec: RecordValue): string[] {
  const podSpec = asRecord(asRecord(spec.template)?.spec) ?? spec;
  return [...asArray(podSpec.initContainers), ...asArray(podSpec.containers)]
    .filter(isRecord)
    .map((container) => toText(container.image))
    .filter(Boolean)
    .slice(0, 20);
}

function collectIngressHosts(spec: RecordValue): string[] {
  return asArray(spec.rules).filter(isRecord).map((rule) => toText(rule.host)).filter(Boolean).slice(0, 20);
}

function collectIngressPaths(spec: RecordValue): string[] {
  return asArray(spec.rules)
    .filter(isRecord)
    .flatMap((rule) => asArray(asRecord(rule.http)?.paths).filter(isRecord))
    .map((path) => toText(path.path) || '/')
    .slice(0, 40);
}

function buildNextChecks(summary: KubernetesResourceSummary): string[] {
  const checks: string[] = [];
  if (summary.kind === 'Pod') {
    checks.push('kubectl_logs_by_ns current logs');
    checks.push('kubectl_logs_by_ns previous logs when restarts are present');
  }
  if (summary.spec.backendServices?.length || summary.kind === 'Service' || summary.kind === 'Ingress') {
    checks.push('kubectl_get_by_ns related service/endpoints/pods');
  }
  if (summary.diagnosticSignals.length > 0) {
    checks.push('kubectl_events_by_ns for the same resource');
  }
  return checks.slice(0, 8);
}

function pickStringMap(value: unknown, maxEntries: number): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record).slice(0, maxEntries).map(([key, rawValue]) => [key, toText(rawValue)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatTime(value: unknown): string {
  const text = toText(value);
  if (!text) {
    return '';
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
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

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
