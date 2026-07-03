import { KubernetesClient } from '../kubernetes/client';
import { extractKubernetesError } from './common';
import { KubectlResourceDefinition, findKubectlResource } from './kubectl-resource-registry';
import { listAllKubectlResource } from './kubectl-resource-reader';
import { sanitizeKubernetesObject } from './kubectl-sanitize';
import { FindK8sResourcesByNsInput, FindK8sResourcesByNsInputSchema } from './types';

const DEFAULT_RESOURCE_TYPES = [
  'ingresses',
  'services',
  'endpoints',
  'endpointslices',
  'apps',
  'appinstances',
  'deployments',
  'statefulsets',
  'pods',
  'certificates',
  'issuers',
  'configmaps',
  'persistentvolumeclaims',
];
const DEFAULT_PAGE_SIZE = 100;
const MAX_RESOURCE_MATCHES = 40;
const MAX_MATCHED_FIELDS = 8;
const MAX_SUMMARY_ENTRIES = 8;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'app',
  'application',
  'service',
  'pod',
  'node',
  'not',
  'ready',
  'error',
  'failed',
  'issue',
  'problem',
]);

type RecordValue = Record<string, unknown>;

interface SearchField {
  name: string;
  value: string;
  weight: number;
}

interface ResourceCandidate {
  resource: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  summary: Record<string, unknown>;
  fields: SearchField[];
}

interface ResourceSearchMatch {
  resource: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  score: number;
  matchedFields: string[];
  summary: Record<string, unknown>;
}

export async function findK8sResourcesByNamespace(
  client: KubernetesClient,
  input: FindK8sResourcesByNsInput
): Promise<unknown> {
  const validatedInput = FindK8sResourcesByNsInputSchema.parse(input);
  const { namespace } = validatedInput;
  const query = validatedInput.query.trim();
  const pageSize = validatedInput.pageSize ?? DEFAULT_PAGE_SIZE;
  const { resources, unsupportedResourceTypes } = resolveResourceDefinitions(validatedInput.resourceTypes);

  if (!query) {
    return {
      namespace,
      query,
      resourceMatches: [],
      total: 0,
      success: false,
      error: { reason: 'InvalidInput', message: 'query is empty' },
    };
  }

  if (resources.length === 0) {
    return {
      namespace,
      query,
      resourceMatches: [],
      total: 0,
      unsupportedResourceTypes,
      success: false,
      error: { reason: 'Blocked', message: 'no supported resource type selected' },
    };
  }

  const needles = buildNeedles(query);
  console.error(`[Server] Executing: find k8s resources for query="${sanitizeLogValue(query)}" -n ${namespace}`);

  if (needles.length === 0) {
    return {
      namespace,
      query,
      resourceTypes: resources.map((resource) => resource.resource),
      unsupportedResourceTypes,
      resourceMatches: [],
      total: 0,
      success: true,
    };
  }

  const settled = await Promise.allSettled(
    resources.map(async (resourceDefinition) => {
      const listResult = await listAllKubectlResource(client, resourceDefinition, namespace, {
        limit: pageSize,
      });
      const resourceMatches = listResult.items
        .map((item) => {
          const sanitized = sanitizeKubernetesObject(item, resourceDefinition);
          return buildCandidate(resourceDefinition, sanitized.object, namespace);
        })
        .map((candidate) => matchCandidate(candidate, needles))
        .filter((match): match is ResourceSearchMatch => Boolean(match));

      return {
        resource: resourceDefinition.resource,
        apiVersion: resourceDefinition.apiVersion,
        searched: listResult.items.length,
        pages: listResult.pageCount,
        remainingItemCount: listResult.remainingItemCount,
        resourceMatches,
      };
    })
  );

  const resourceMatches: ResourceSearchMatch[] = [];
  const searchedResources: Array<{ resource: string; apiVersion: string; searched: number; pages: number; remainingItemCount?: number }> = [];
  const errors: Array<{ resource: string; apiVersion: string; error: unknown }> = [];

  for (let index = 0; index < settled.length; index += 1) {
    const resourceDefinition = resources[index];
    const result = settled[index];
    if (!resourceDefinition || !result) {
      continue;
    }
    if (result.status === 'fulfilled') {
      searchedResources.push({
        resource: result.value.resource,
        apiVersion: result.value.apiVersion,
        searched: result.value.searched,
        pages: result.value.pages,
        remainingItemCount: result.value.remainingItemCount,
      });
      resourceMatches.push(...result.value.resourceMatches);
      continue;
    }
    errors.push({
      resource: resourceDefinition.resource,
      apiVersion: resourceDefinition.apiVersion,
      error: extractKubernetesError(result.reason),
    });
  }

  resourceMatches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.name.localeCompare(right.name);
  });

  return {
    namespace,
    query,
    resourceTypes: resources.map((resource) => resource.resource),
    unsupportedResourceTypes,
    searchedResources,
    resourceMatches: resourceMatches.slice(0, MAX_RESOURCE_MATCHES),
    total: resourceMatches.length,
    limit: MAX_RESOURCE_MATCHES,
    errors: errors.length > 0 ? errors : undefined,
    coverageStatus: errors.length > 0 || unsupportedResourceTypes.length > 0 ? 'partial' : 'complete',
    success: true,
  };
}

function resolveResourceDefinitions(resourceTypes: string[] | undefined): {
  resources: KubectlResourceDefinition[];
  unsupportedResourceTypes: string[];
} {
  const requestedResourceTypes = resourceTypes && resourceTypes.length > 0
    ? resourceTypes
    : DEFAULT_RESOURCE_TYPES;
  const resources: KubectlResourceDefinition[] = [];
  const unsupportedResourceTypes: string[] = [];
  const seen = new Set<string>();

  for (const requestedResourceType of requestedResourceTypes) {
    const resourceDefinition = findKubectlResource(requestedResourceType);
    if (!resourceDefinition) {
      unsupportedResourceTypes.push(requestedResourceType);
      continue;
    }

    const key = `${resourceDefinition.apiVersion}/${resourceDefinition.resource}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resources.push(resourceDefinition);
  }

  return { resources, unsupportedResourceTypes };
}

function buildCandidate(
  resource: KubectlResourceDefinition,
  object: unknown,
  namespace: string
): ResourceCandidate {
  const record = asRecord(object) ?? {};
  const metadata = asRecord(record.metadata);
  const spec = asRecord(record.spec);
  const status = asRecord(record.status);
  const labels = asRecord(metadata?.labels);
  const annotations = asRecord(metadata?.annotations);
  const name = toText(metadata?.name) || 'unknown';
  const objectNamespace = toText(metadata?.namespace) || namespace;
  const kind = toText(record.kind) || resource.kind;
  const owners = summarizeOwners(metadata?.ownerReferences);
  const conditions = summarizeConditions(status?.conditions);
  const fields: SearchField[] = [];
  const summary: Record<string, unknown> = {
    labels: pickMap(labels),
    owners,
    conditions,
  };

  pushField(fields, 'name', name, 100);
  pushField(fields, 'namespace', objectNamespace, 20);
  pushField(fields, 'kind', kind, 40);
  pushField(fields, 'resource', resource.resource, 40);
  pushField(fields, 'labels', formatMap(labels, 20), 80);
  pushField(fields, 'owners', owners, 70);
  pushField(fields, 'annotationKeys', annotations ? Object.keys(annotations).join(',') : '', 20);

  const serviceSummary = buildServiceSummary(spec);
  Object.assign(summary, serviceSummary.summary);
  pushField(fields, 'selector', serviceSummary.selectorText, 85);
  pushField(fields, 'ports', serviceSummary.portsText, 50);

  const ingressSummary = buildIngressSummary(spec);
  Object.assign(summary, ingressSummary.summary);
  pushField(fields, 'hosts', ingressSummary.hostsText, 95);
  pushField(fields, 'backends', ingressSummary.backendsText, 90);

  const workloadSummary = buildWorkloadSummary(spec, status);
  Object.assign(summary, workloadSummary.summary);
  pushField(fields, 'workloadSelector', workloadSummary.selectorText, 85);
  pushField(fields, 'templateLabels', workloadSummary.templateLabelsText, 75);

  const podSummary = buildPodSummary(spec, status);
  Object.assign(summary, podSummary.summary);
  pushField(fields, 'containers', podSummary.containersText, 60);
  pushField(fields, 'nodeName', podSummary.nodeName, 35);

  return {
    resource: resource.resource,
    apiVersion: resource.apiVersion,
    kind,
    name,
    namespace: objectNamespace,
    summary,
    fields: fields.filter((field) => field.value),
  };
}

function buildServiceSummary(spec: RecordValue | undefined): {
  summary: Record<string, unknown>;
  selectorText: string;
  portsText: string;
} {
  const selector = asRecord(spec?.selector);
  const portsText = summarizeServicePorts(spec?.ports);
  return {
    summary: {
      type: spec?.type,
      selector: pickMap(selector),
      ports: portsText,
    },
    selectorText: formatMap(selector, 20),
    portsText,
  };
}

function buildIngressSummary(spec: RecordValue | undefined): {
  summary: Record<string, unknown>;
  hostsText: string;
  backendsText: string;
} {
  const rules = asArray(spec?.rules).filter(isRecord);
  const hosts = rules.map((rule) => toText(rule.host)).filter(Boolean);
  const backends = rules.flatMap((rule) =>
    asArray(asRecord(rule.http)?.paths)
      .filter(isRecord)
      .map((path) => {
        const service = asRecord(asRecord(path.backend)?.service);
        const port = asRecord(service?.port);
        return [toText(service?.name), toText(port?.number ?? port?.name)].filter(Boolean).join(':');
      })
      .filter(Boolean)
  );

  return {
    summary: {
      hosts,
      backends,
    },
    hostsText: hosts.join(','),
    backendsText: backends.join(','),
  };
}

function buildWorkloadSummary(
  spec: RecordValue | undefined,
  status: RecordValue | undefined
): {
  summary: Record<string, unknown>;
  selectorText: string;
  templateLabelsText: string;
} {
  const selector = asRecord(asRecord(spec?.selector)?.matchLabels);
  const template = asRecord(spec?.template);
  const templateMetadata = asRecord(template?.metadata);
  const templateLabels = asRecord(templateMetadata?.labels);
  const totalReplicas = toText(status?.replicas ?? spec?.replicas);
  const readyReplicas = toText(status?.readyReplicas);
  const ready = totalReplicas || readyReplicas ? `${readyReplicas || '0'}/${totalReplicas || '?'}` : '';

  return {
    summary: {
      ready,
      selector: pickMap(selector),
      templateLabels: pickMap(templateLabels),
    },
    selectorText: formatMap(selector, 20),
    templateLabelsText: formatMap(templateLabels, 20),
  };
}

function buildPodSummary(
  spec: RecordValue | undefined,
  status: RecordValue | undefined
): {
  summary: Record<string, unknown>;
  containersText: string;
  nodeName: string;
} {
  const containers = asArray(spec?.containers)
    .filter(isRecord)
    .map((container) => toText(container.name))
    .filter(Boolean);
  const containerStatuses = asArray(status?.containerStatuses).filter(isRecord);
  const ready = containerStatuses.length > 0
    ? `${containerStatuses.filter((item) => item.ready === true).length}/${containerStatuses.length}`
    : '';
  const phase = toText(status?.phase);
  const nodeName = toText(spec?.nodeName);

  return {
    summary: {
      phase,
      ready,
      nodeName,
      containers,
    },
    containersText: containers.join(','),
    nodeName,
  };
}

function matchCandidate(candidate: ResourceCandidate, needles: string[]): ResourceSearchMatch | undefined {
  let score = 0;
  const matchedFields = new Set<string>();

  for (const field of candidate.fields) {
    const haystack = normalizeSearchText(field.value);
    for (const needle of needles) {
      if (!haystack.includes(needle)) {
        continue;
      }
      matchedFields.add(field.name);
      score = Math.max(score, field.weight + (haystack === needle ? 20 : 0));
    }
  }

  if (matchedFields.size === 0) {
    return undefined;
  }

  return {
    resource: candidate.resource,
    apiVersion: candidate.apiVersion,
    kind: candidate.kind,
    name: candidate.name,
    namespace: candidate.namespace,
    score,
    matchedFields: Array.from(matchedFields).slice(0, MAX_MATCHED_FIELDS),
    summary: candidate.summary,
  };
}

function buildNeedles(query: string): string[] {
  const normalized = normalizeSearchText(query);
  const latinTokens = query.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) ?? [];
  const splitTokens = normalized.split(/[^a-z0-9._-]+/);
  return Array.from(new Set([normalized, ...splitTokens, ...latinTokens.map(normalizeSearchText)]))
    .filter((value) => value.length >= 2 && !STOP_WORDS.has(value));
}

function pushField(fields: SearchField[], name: string, value: unknown, weight: number): void {
  const text = toText(value);
  if (!text) {
    return;
  }
  fields.push({ name, value: text, weight });
}

function summarizeOwners(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, MAX_SUMMARY_ENTRIES)
    .map((owner) => [toText(owner.kind), toText(owner.name)].filter(Boolean).join('/'))
    .filter(Boolean)
    .join(',');
}

function summarizeConditions(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, MAX_SUMMARY_ENTRIES)
    .map((condition) => [toText(condition.type), toText(condition.status), toText(condition.reason)].filter(Boolean).join('='))
    .filter(Boolean)
    .join(',');
}

function summarizeServicePorts(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .slice(0, MAX_SUMMARY_ENTRIES)
    .map((port) => [
      toText(port.name),
      toText(port.port),
      toText(port.targetPort) ? `target=${toText(port.targetPort)}` : '',
      toText(port.protocol),
    ].filter(Boolean).join('/'))
    .filter(Boolean)
    .join(',');
}

function pickMap(value: unknown, maxEntries = MAX_SUMMARY_ENTRIES): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record)
    .slice(0, maxEntries)
    .map(([key, rawValue]) => [key, toText(rawValue)])
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatMap(value: unknown, maxEntries = MAX_SUMMARY_ENTRIES): string {
  const record = asRecord(value);
  if (!record) {
    return '';
  }
  return Object.entries(record)
    .slice(0, maxEntries)
    .map(([key, rawValue]) => `${key}=${toText(rawValue)}`)
    .join(',');
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeLogValue(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 120);
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
