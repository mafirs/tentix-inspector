type RecordValue = Record<string, unknown>;

const MAX_ROWS = 20;
const MAX_OBSERVATION_CHARS = 6_000;
const MAX_LOG_CHARS = 2_000;
const MAX_TEXT_CHARS = 2_000;
const SENSITIVE_TEXT_PATTERN =
  /(authorization|token|password|passwd|secret|secretKey|accessKey|secretHeader|connectionString|dsn|kubeconfig)\s*[:=]\s*[^,\s"}]+/gi;

export function renderToolObservation(toolName: string, result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }

  const lines: string[] = [`tool=${toolName}`];
  const namespace = toText(record.namespace);
  if (namespace) {
    lines.push(`namespace=${namespace}`);
  }

  const target = formatTarget(record);
  if (target) {
    lines.push(target);
  }

  const success = record.success;
  if (success === false) {
    lines.push(`status=error${formatError(record.error) ? ` ${formatError(record.error)}` : ''}`);
    return finalizeObservation(lines);
  }

  const message = toText(record.message);
  if (message) {
    lines.push(`message=${message}`);
  }

  appendCollection(lines, 'matches', record.matches, renderTextMatchRow);
  appendCollection(lines, 'files', record.files, renderTextFileRow);
  appendCollection(lines, 'pods', record.pods, renderPodRow);
  appendCollection(lines, 'services', record.services, renderServiceRow);
  appendCollection(lines, 'ingresses', record.ingresses, renderIngressRow);
  appendCollection(lines, 'apps', record.apps, renderWorkloadRow);
  appendCollection(lines, 'deployments', record.deployments, renderWorkloadRow);
  appendCollection(lines, 'statefulsets', record.statefulsets, renderWorkloadRow);
  appendCollection(lines, 'events', record.events, renderEventRow);
  appendCollection(lines, 'items', record.items, renderKubernetesObjectRow);
  appendCollection(lines, 'relatedEvents', record.relatedEvents, renderEventRow);
  appendCollection(lines, 'sources', record.sources, renderLogSourceRow);
  appendCollection(lines, 'podCandidates', record.podCandidates, renderPodCandidateRow);

  const manifest = asRecord(record.manifest);
  if (manifest) {
    lines.push('manifest:');
    lines.push(`- ${renderKubernetesObjectRow(manifest)}`);
  }

  const resolution = toText(record.resolution);
  if (resolution) {
    lines.push(`resolution=${resolution}`);
  }
  appendCollection(lines, 'containerCandidates', record.containerCandidates, renderPrimitiveRow);
  appendTextBlock(lines, 'content', record.content, MAX_TEXT_CHARS);
  appendTextBlock(lines, 'logs', record.logs, MAX_LOG_CHARS);

  const total = toText(record.total);
  if (total && lines.length <= 3) {
    lines.push(`total=${total}`);
  }

  return finalizeObservation(lines);
}

function appendCollection(
  lines: string[],
  label: string,
  value: unknown,
  render: (item: unknown) => string
): void {
  const items = asArray(value);
  if (items.length === 0) {
    return;
  }

  lines.push(`${label}:`);
  for (const item of items.slice(0, MAX_ROWS)) {
    lines.push(`- ${render(item)}`);
  }
  if (items.length > MAX_ROWS) {
    lines.push(`- ... ${items.length - MAX_ROWS} more`);
  }
}

function renderPodRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('status', record.status),
    named('ip', record.ip),
    named('node', record.node),
  ]);
}

function renderServiceRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('type', record.type),
    named('clusterIP', record.clusterIP),
    named('ports', formatArray(record.ports)),
    named('selector', formatMap(record.selector)),
    named('readyEndpoints', record.readyEndpoints),
    named('notReadyEndpoints', record.notReadyEndpoints),
    named('age', record.age),
  ]);
}

function renderIngressRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('hosts', record.hosts),
    named('paths', record.paths),
    named('backend', formatBackend(record.backendService, record.backendPort)),
    named('class', record.ingressClass),
    named('address', record.address),
    named('age', record.age),
  ]);
}

function renderWorkloadRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('kind', record.kind),
    named('name', record.name),
    named('ready', record.ready),
    named('updated', record.updatedReplicas),
    named('available', record.availableReplicas),
    named('containers', record.containers),
    named('images', record.images),
    named('selector', record.selector),
    named('paused', record.paused),
    named('age', record.age),
  ]);
}

function renderEventRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const involvedObject = asRecord(record.involvedObject) ?? asRecord(record.regarding);
  return joinParts([
    named('severity', record.severity ?? record.type),
    named('reason', record.reason),
    named('resource', formatResourceRef(record.resourceKind ?? involvedObject?.kind, record.resourceName ?? involvedObject?.name)),
    named('subObject', record.subObject ?? involvedObject?.fieldPath),
    named('count', record.count ?? asRecord(record.series)?.count),
    named('lastSeen', record.lastSeen ?? record.lastTimestamp ?? record.eventTime),
    named('message', record.message ?? record.note),
  ]);
}

function renderLogSourceRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const logs = toText(record.logs);
  const logText = logs ? logs.slice(0, MAX_LOG_CHARS) : '<empty>';
  return joinParts([
    named('pod', record.podName),
    named('container', record.containerName),
    named('previous', record.previous),
    named('logs', logText),
  ]);
}

function renderTextMatchRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const snippet = toText(record.snippet);
  return joinParts([
    named('path', record.path),
    named('line', record.line),
    named('snippet', snippet.slice(0, MAX_TEXT_CHARS)),
  ]);
}

function renderTextFileRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('root', record.root),
    named('path', record.path),
  ]);
}

function renderPodCandidateRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('pod', record.podName),
    named('workload', record.workloadName),
    named('status', record.status),
    named('ready', record.ready),
    named('restarts', record.restarts),
    named('containers', formatArray(record.containers)),
    named('age', record.age),
  ]);
}

function renderKubernetesObjectRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const metadata = asRecord(record.metadata);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  return joinParts([
    named('kind', record.kind),
    named('name', metadata?.name),
    named('namespace', metadata?.namespace),
    named('phase', status?.phase),
    summarizePodStatus(status),
    summarizeWorkload(spec, status),
    summarizeService(spec),
    summarizeIngress(spec),
    named('owners', summarizeOwners(metadata?.ownerReferences)),
    named('labels', formatMap(metadata?.labels, 8)),
    named('conditions', summarizeConditions(status?.conditions)),
  ]);
}

function summarizePodStatus(status: RecordValue | undefined): string {
  if (!status) {
    return '';
  }

  const containerStatuses = asArray(status.containerStatuses).filter(isRecord);
  if (containerStatuses.length === 0) {
    return '';
  }

  const ready = containerStatuses.filter((item) => item.ready === true).length;
  const restarts = containerStatuses.reduce((sum, item) => sum + toNumber(item.restartCount), 0);
  const reasons = containerStatuses
    .map((item) => {
      const state = asRecord(item.state);
      const waiting = asRecord(state?.waiting);
      const terminated = asRecord(state?.terminated);
      return toText(waiting?.reason) || toText(terminated?.reason);
    })
    .filter(Boolean);

  return joinParts([
    `ready=${ready}/${containerStatuses.length}`,
    `restarts=${restarts}`,
    reasons.length > 0 ? `containerReasons=${reasons.join(',')}` : '',
  ]);
}

function summarizeWorkload(spec: RecordValue | undefined, status: RecordValue | undefined): string {
  if (!spec && !status) {
    return '';
  }
  return joinParts([
    named('replicas', spec?.replicas),
    named('readyReplicas', status?.readyReplicas),
    named('availableReplicas', status?.availableReplicas),
    named('updatedReplicas', status?.updatedReplicas),
  ]);
}

function summarizeService(spec: RecordValue | undefined): string {
  if (!spec || (!spec.type && !spec.ports && !spec.selector)) {
    return '';
  }
  return joinParts([
    named('type', spec.type),
    named('clusterIP', spec.clusterIP),
    named('ports', summarizeServicePorts(spec.ports)),
    named('selector', formatMap(spec.selector)),
  ]);
}

function summarizeIngress(spec: RecordValue | undefined): string {
  if (!spec || !spec.rules) {
    return '';
  }

  const rules = asArray(spec.rules).filter(isRecord);
  const hosts = rules.map((rule) => toText(rule.host)).filter(Boolean);
  const backends = rules.flatMap((rule) =>
    asArray(asRecord(rule.http)?.paths)
      .filter(isRecord)
      .map((path) => {
        const service = asRecord(asRecord(path.backend)?.service);
        return formatBackend(service?.name, asRecord(service?.port)?.number ?? asRecord(service?.port)?.name);
      })
      .filter(Boolean)
  );

  return joinParts([
    named('hosts', hosts.join(',')),
    named('backends', backends.join(',')),
  ]);
}

function summarizeServicePorts(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 8)
    .map((port) => joinParts([
      toText(port.name),
      toText(port.port),
      toText(port.targetPort) ? `target=${toText(port.targetPort)}` : '',
      toText(port.protocol),
    ], '/'))
    .filter(Boolean)
    .join(',');
}

function summarizeOwners(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 5)
    .map((owner) => formatResourceRef(owner.kind, owner.name))
    .filter(Boolean)
    .join(',');
}

function summarizeConditions(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 8)
    .map((condition) => joinParts([
      toText(condition.type),
      toText(condition.status),
      toText(condition.reason),
    ], '='))
    .filter(Boolean)
    .join(',');
}

function formatTarget(record: RecordValue): string {
  return joinParts([
    named('resource', record.resource),
    named('kind', record.kind),
    named('name', record.name),
    named('apiVersion', record.apiVersion),
    named('labelSelector', record.labelSelector),
    named('fieldSelector', record.fieldSelector),
  ]);
}

function formatError(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return toText(value);
  }
  return joinParts([
    named('code', record.code),
    named('reason', record.reason),
    named('message', record.message),
  ]);
}

function named(name: string, value: unknown): string {
  const text = toText(value);
  return text ? `${name}=${text}` : '';
}

function formatResourceRef(kind: unknown, name: unknown): string {
  const kindText = toText(kind);
  const nameText = toText(name);
  return [kindText, nameText].filter(Boolean).join('/');
}

function formatBackend(service: unknown, port: unknown): string {
  const serviceText = toText(service);
  const portText = toText(port);
  if (!serviceText) {
    return '';
  }
  return portText ? `${serviceText}:${portText}` : serviceText;
}

function formatArray(value: unknown): string {
  return asArray(value)
    .slice(0, 8)
    .map(toText)
    .filter(Boolean)
    .join(',');
}

function formatMap(value: unknown, maxEntries = 8): string {
  const record = asRecord(value);
  if (!record) {
    return '';
  }

  return Object.entries(record)
    .slice(0, maxEntries)
    .map(([key, rawValue]) => `${key}=${toText(rawValue)}`)
    .join(',');
}

function renderPrimitiveRow(value: unknown): string {
  return toText(value) || JSON.stringify(value);
}

function appendTextBlock(lines: string[], label: string, value: unknown, maxChars: number): void {
  const text = toText(value);
  if (!text) {
    return;
  }
  lines.push(`${label}:`);
  lines.push(text.length > maxChars ? `${text.slice(0, maxChars)}\n[${label} truncated ${text.length - maxChars} chars]` : text);
}

function finalizeObservation(lines: string[]): string {
  const text = redactSensitiveText(lines.filter(Boolean).join('\n'));
  if (text.length <= MAX_OBSERVATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OBSERVATION_CHARS)}\n[observation truncated ${text.length - MAX_OBSERVATION_CHARS} chars]`;
}

function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_TEXT_PATTERN, '$1=[redacted]');
}

function joinParts(parts: Array<string | undefined>, separator = ' '): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator);
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

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
