type RecordValue = Record<string, unknown>;

const MAX_ROWS = 20;
const MAX_INDEX_ROWS = 120;
const MAX_DETAIL_ROWS = 8;
const MAX_OBSERVATION_CHARS = parsePositiveIntegerEnv(process.env.AGENT_TOOL_OBSERVATION_CHARS, 48_000, 120_000);
const MAX_LOG_CHARS = parsePositiveIntegerEnv(process.env.AGENT_TOOL_LOG_CHARS, 12_000, 80_000);
const MAX_TEXT_CHARS = parsePositiveIntegerEnv(process.env.AGENT_TOOL_TEXT_CHARS, 8_000, 40_000);
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

  const coverageStatus = toText(record.coverageStatus);
  if (coverageStatus) {
    lines.push(`coverageStatus=${coverageStatus}`);
  }
  appendCoverage(lines, record.coverage);
  appendSummary(lines, record.summary);
  appendDiagnosis(lines, record.diagnosis);

  appendCollection(lines, 'matches', record.matches, renderTextMatchRow);
  appendCollection(lines, 'files', record.files, renderTextFileRow);
  appendCollection(lines, 'searchedResources', record.searchedResources, renderSearchedResourceRow);
  appendCollection(lines, 'unsupportedResourceTypes', record.unsupportedResourceTypes, renderPrimitiveRow);
  appendCollection(lines, 'errors', record.errors, renderResourceErrorRow);
  appendCollection(lines, 'resourceMatches', record.resourceMatches, renderResourceMatchRow);
  appendIndexedCollection(lines, 'pods', record.pods, renderPodIndexRow, renderPodRow);
  appendIndexedCollection(lines, 'services', record.services, renderServiceIndexRow, renderServiceRow);
  appendIndexedCollection(lines, 'ingresses', record.ingresses, renderIngressIndexRow, renderIngressRow);
  appendIndexedCollection(lines, 'apps', record.apps, renderWorkloadIndexRow, renderWorkloadRow);
  appendIndexedCollection(lines, 'deployments', record.deployments, renderWorkloadIndexRow, renderWorkloadRow);
  appendIndexedCollection(lines, 'statefulsets', record.statefulsets, renderWorkloadIndexRow, renderWorkloadRow);
  appendCollection(lines, 'events', record.events, renderEventRow);
  appendIndexedCollection(lines, 'items', record.items, renderKubernetesObjectIndexRow, renderKubernetesObjectRow);
  appendCollection(lines, 'relatedEvents', record.relatedEvents, renderEventRow);
  appendCollection(lines, 'relatedResources', record.relatedResources, renderRelatedResourceBlockRow);
  appendCollection(lines, 'omitted', record.omitted, renderOmittedRow);
  appendCollection(lines, 'sources', record.sources, renderLogSourceRow);
  appendCollection(lines, 'podCandidates', record.podCandidates, renderPodCandidateRow);
  appendCollection(lines, 'ports', record.ports, renderListeningPortRow);

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
  appendSingle(lines, 'diskUsage', record.diskUsage, renderDiskUsageRow);
  appendTextBlock(lines, 'content', record.content, MAX_TEXT_CHARS);
  appendTextBlock(lines, 'logs', record.logs, MAX_LOG_CHARS);

  const total = toText(record.total);
  if (total && lines.length <= 3) {
    lines.push(`total=${total}`);
  }
  if (lines.length <= 2) {
    lines.push(`keys=${Object.keys(record).slice(0, 20).join(',')}`);
  }

  return finalizeObservation(lines);
}

function appendCoverage(lines: string[], value: unknown): void {
  const record = asRecord(value);
  if (!record) {
    return;
  }
  lines.push(joinParts([
    'coverage:',
    named('status', record.status),
    named('pages', record.pages),
    named('returned', record.returned),
    named('remainingItemCount', record.remainingItemCount),
    named('matchedPods', record.matchedPods),
    named('queriedPods', record.queriedPods),
    named('queriedSources', record.queriedSources),
    named('limit', record.limit),
    named('truncated', record.truncated),
    named('fieldSelector', record.fieldSelector),
    named('message', record.message),
  ]));
  appendCollection(lines, 'omittedPods', record.omittedPods, renderPrimitiveRow);
  appendCollection(lines, 'omittedSections', record.omittedSections, renderPrimitiveRow);
}

function appendSummary(lines: string[], value: unknown): void {
  const record = asRecord(value);
  if (!record) {
    return;
  }
  lines.push('summary:');
  lines.push(`- ${renderKubernetesObjectRow(record)}`);
  appendCollection(lines, 'diagnosticSignals', record.diagnosticSignals, renderPrimitiveRow);
}

function appendDiagnosis(lines: string[], value: unknown): void {
  const record = asRecord(value);
  if (!record) {
    return;
  }
  lines.push(joinParts([
    'diagnosis:',
    named('health', record.health),
  ]));
  appendCollection(lines, 'primarySignals', record.primarySignals, renderPrimitiveRow);
  appendCollection(lines, 'failedConditions', record.failedConditions, renderConditionRow);
  appendCollection(lines, 'nextChecks', record.nextChecks, renderPrimitiveRow);
  appendCollection(lines, 'evidenceGaps', record.evidenceGaps, renderPrimitiveRow);
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

function appendSingle(
  lines: string[],
  label: string,
  value: unknown,
  render: (item: unknown) => string
): void {
  if (value === undefined || value === null) {
    return;
  }
  lines.push(`${label}:`);
  lines.push(`- ${render(value)}`);
}

function appendIndexedCollection(
  lines: string[],
  label: string,
  value: unknown,
  renderIndex: (item: unknown) => string,
  renderDetail: (item: unknown) => string
): void {
  const items = asArray(value);
  if (items.length === 0) {
    return;
  }

  lines.push(`${label}Index total=${items.length}:`);
  for (const item of items.slice(0, MAX_INDEX_ROWS)) {
    lines.push(`- ${renderIndex(item)}`);
  }
  if (items.length > MAX_INDEX_ROWS) {
    lines.push(`- ... ${items.length - MAX_INDEX_ROWS} more not indexed`);
  }

  const detailRows = items.slice(0, MAX_DETAIL_ROWS);
  lines.push(`${label}Details shown=${detailRows.length} total=${items.length}:`);
  for (const item of detailRows) {
    lines.push(`- ${renderDetail(item)}`);
  }
  if (items.length > MAX_DETAIL_ROWS) {
    lines.push(`- ... ${items.length - MAX_DETAIL_ROWS} more details omitted; use exact name, labelSelector, kubectl_describe_by_ns, or find_k8s_resources_by_ns for drilldown`);
  }
}

function renderPodIndexRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('status', record.status),
    named('node', record.node),
  ]);
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

function renderServiceIndexRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('type', record.type),
    named('ports', formatArray(record.ports)),
    named('endpoints', formatEndpointReady(record.readyEndpoints, record.notReadyEndpoints)),
    named('selector', formatMap(record.selector, 4)),
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

function renderIngressIndexRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('name', record.name),
    named('hosts', record.hosts),
    named('backend', formatBackend(record.backendService, record.backendPort)),
    named('class', record.ingressClass),
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

function renderWorkloadIndexRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('kind', record.kind),
    named('name', record.name),
    named('ready', record.ready),
    named('selector', record.selector),
    named('paused', record.paused),
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

function renderResourceMatchRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const summary = asRecord(record.summary);
  return joinParts([
    named('resource', record.resource),
    named('kind', record.kind),
    named('name', record.name),
    named('namespace', record.namespace),
    named('score', record.score),
    named('matchedFields', formatArray(record.matchedFields)),
    named('owners', summary?.owners),
    named('labels', formatMap(summary?.labels, 6)),
    named('hosts', formatArray(summary?.hosts)),
    named('backends', formatArray(summary?.backends)),
    named('selector', formatMap(summary?.selector, 6)),
    named('ready', summary?.ready),
    named('phase', summary?.phase),
    named('conditions', summary?.conditions),
  ]);
}

function renderSearchedResourceRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('resource', record.resource),
    named('apiVersion', record.apiVersion),
    named('searched', record.searched),
    named('pages', record.pages),
    named('remainingItemCount', record.remainingItemCount),
  ]);
}

function renderResourceErrorRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const error = asRecord(record.error);
  return joinParts([
    named('resource', record.resource),
    named('apiVersion', record.apiVersion),
    named('code', error?.code),
    named('reason', error?.reason),
    named('message', error?.message),
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
    named('lineCount', record.lineCount),
    named('empty', record.empty),
    named('truncated', record.truncated),
    named('error', formatError(record.error)),
    named('logs', logText),
  ]);
}

function renderListeningPortRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('protocol', record.protocol),
    named('address', record.localAddress),
    named('port', record.port),
    named('state', record.state),
    named('source', record.source),
  ]);
}

function renderDiskUsageRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  return joinParts([
    named('path', record.path),
    named('size', record.sizeHuman),
    named('source', record.source),
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

function renderKubernetesObjectIndexRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const metadata = asRecord(record.metadata);
  if (!metadata && (record.name || record.status || record.spec)) {
    return renderResourceSummaryIndexRow(record);
  }
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  return joinParts([
    named('kind', record.kind),
    named('name', metadata?.name),
    named('namespace', metadata?.namespace),
    named('phase', status?.phase),
    summarizePodStatus(status),
    summarizeService(spec),
    summarizeIngress(spec),
    summarizeWorkload(spec, status),
    named('owners', summarizeOwners(metadata?.ownerReferences)),
    named('labels', formatMap(metadata?.labels, 4)),
    named('conditions', summarizeConditions(status?.conditions)),
  ]);
}

function renderKubernetesObjectRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }

  const metadata = asRecord(record.metadata);
  if (!metadata && (record.name || record.status || record.spec)) {
    return renderResourceSummaryRow(record);
  }
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

function renderResourceSummaryIndexRow(record: RecordValue): string {
  const status = asRecord(record.status);
  const spec = asRecord(record.spec);
  return joinParts([
    named('kind', record.kind),
    named('name', record.name),
    named('namespace', record.namespace),
    named('phase', status?.phase),
    named('ready', status?.ready),
    named('replicas', formatMap(status?.replicas, 6)),
    named('endpoints', renderEndpoints(status?.endpoints)),
    named('containers', renderContainers(status?.containers)),
    named('hosts', formatArray(spec?.hosts)),
    named('backends', renderRefs(spec?.backendServices)),
    named('owners', renderRefs(record.owners)),
    named('signals', formatArray(record.diagnosticSignals)),
  ]);
}

function renderResourceSummaryRow(record: RecordValue): string {
  const status = asRecord(record.status);
  const spec = asRecord(record.spec);
  return joinParts([
    renderResourceSummaryIndexRow(record),
    named('labels', formatMap(record.labels, 8)),
    named('conditions', renderConditions(status?.conditions)),
    named('endpoints', renderEndpoints(status?.endpoints)),
    named('ports', formatArray(spec?.ports)),
    named('images', formatArray(spec?.images)),
    named('paths', formatArray(spec?.paths)),
    named('tlsSecrets', renderRefs(spec?.tlsSecrets)),
    named('refs', renderRefs(record.refs)),
    named('age', record.age),
  ]);
}

function renderConditionRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }
  return joinParts([
    named('type', record.type),
    named('status', record.status),
    named('reason', record.reason),
    named('message', record.message),
  ]);
}

function renderRelatedResourceBlockRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }
  return joinParts([
    named('role', record.role),
    named('items', renderRefs(record.items)),
    named('truncated', record.truncated),
    named('error', formatError(record.error)),
  ]);
}

function renderOmittedRow(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return renderPrimitiveRow(value);
  }
  return joinParts([
    named('path', record.path),
    named('reason', record.reason),
    named('count', record.count),
  ]);
}

function renderRefs(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 12)
    .map((ref) => joinParts([
      toText(ref.role),
      formatResourceRef(ref.kind, ref.name),
    ], ':'))
    .filter(Boolean)
    .join(',');
}

function renderContainers(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 8)
    .map((container) => joinParts([
      toText(container.name),
      named('ready', container.ready),
      named('restarts', container.restartCount),
      named('state', container.state),
      named('reason', container.reason),
    ], '/'))
    .filter(Boolean)
    .join(',');
}

function renderEndpoints(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, 12)
    .map((endpoint) => joinParts([
      toText(endpoint.serviceName),
      `ready=${toText(endpoint.ready) || '0'}`,
      `notReady=${toText(endpoint.notReady) || '0'}`,
      named('source', endpoint.source),
      named('ports', formatArray(endpoint.ports)),
      named('error', formatError(endpoint.error)),
    ], '/'))
    .filter(Boolean)
    .join(',');
}

function renderConditions(value: unknown): string {
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

function formatEndpointReady(ready: unknown, notReady: unknown): string {
  return joinParts([
    named('ready', ready),
    named('notReady', notReady),
  ], ',');
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
  return toText(value) || JSON.stringify(value) || '';
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

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, max: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}
