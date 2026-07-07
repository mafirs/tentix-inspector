import { KubernetesClient } from '../kubernetes/client';
import { ListeningPort, ListPodListeningPortsResult } from '../kubernetes/types';
import { ListPodListeningPortsByNsInput, ListPodListeningPortsByNsInputSchema } from './types';
import {
  buildExecKubernetesError,
  emptyPodExecCoverage,
  ExecCommandCandidate,
  getExecFailureMessage,
  isCommandUnavailable,
  resolveSinglePodExecTarget,
  sanitizeExecText,
} from './pod-exec-common';

const PORT_EXEC_TIMEOUT_MS = Number(process.env.AGENT_PORT_EXEC_TIMEOUT_MS ?? 5_000);
const PORT_EXEC_MAX_OUTPUT_BYTES = Number(process.env.AGENT_PORT_EXEC_MAX_OUTPUT_BYTES ?? 64_000);

type PortParser = 'ss' | 'netstat';
type PortCommandCandidate = ExecCommandCandidate & { parser: PortParser };
type PortProbeOutcome =
  | { type: 'resolved'; ports: ListeningPort[]; probe: string; commandPath: string }
  | { type: 'unavailable'; message: string };

const PORT_COMMANDS: PortCommandCandidate[] = [
  ...['/usr/sbin/ss', '/sbin/ss', '/usr/bin/ss', '/bin/ss'].map((commandPath) => ({
    commandPath,
    argv: [commandPath, '-H', '-l', '-n', '-t', '-u'],
    probe: 'ss',
    parser: 'ss' as const,
  })),
  ...['/usr/bin/netstat', '/bin/netstat', '/usr/sbin/netstat', '/sbin/netstat'].map((commandPath) => ({
    commandPath,
    argv: [commandPath, '-l', '-n', '-t', '-u'],
    probe: 'netstat',
    parser: 'netstat' as const,
  })),
  ...['/bin/busybox', '/busybox'].map((commandPath) => ({
    commandPath,
    argv: [commandPath, 'netstat', '-l', '-n', '-t', '-u'],
    probe: 'busybox-netstat',
    parser: 'netstat' as const,
  })),
];

const CAT_COMMANDS: ExecCommandCandidate[] = ['/bin/cat', '/usr/bin/cat', '/busybox', '/bin/busybox'].map((commandPath) => ({
  commandPath,
  argv: commandPath.endsWith('busybox') || commandPath === '/busybox' ? [commandPath, 'cat'] : [commandPath],
  probe: commandPath.endsWith('busybox') || commandPath === '/busybox' ? 'busybox-cat' : 'cat',
}));

const PROC_NET_FILES = ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6'] as const;

export async function listPodListeningPortsByNamespace(
  client: KubernetesClient,
  input: ListPodListeningPortsByNsInput
): Promise<ListPodListeningPortsResult> {
  const parsedInput = ListPodListeningPortsByNsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      success: false,
      namespace: getInputString(input, 'namespace') ?? '',
      podName: getInputString(input, 'podName'),
      labelSelector: getInputString(input, 'labelSelector'),
      container: getInputString(input, 'container'),
      ports: [],
      total: 0,
      coverage: emptyPodExecCoverage(),
      resolution: 'invalid_input',
      error: buildExecKubernetesError('InvalidInput', parsedInput.error.issues.map((issue: { message: string }) => issue.message).join('; ')),
    };
  }

  const validatedInput = parsedInput.data;
  const target = await resolveSinglePodExecTarget(client, validatedInput);
  if (target.resolution !== 'resolved' || !target.resolvedPodName || !target.resolvedContainerName) {
    return {
      success: target.success,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      resolvedPodName: target.resolvedPodName,
      resolvedContainerName: target.resolvedContainerName,
      ports: [],
      total: 0,
      coverage: target.coverage,
      resolution: target.resolution,
      podCandidates: target.podCandidates,
      containerCandidates: target.containerCandidates,
      message: target.message,
      error: target.error,
    };
  }

  const commandOutcome = await runPortCommands(
    client,
    validatedInput.namespace,
    target.resolvedPodName,
    target.resolvedContainerName
  );
  if (commandOutcome.type === 'resolved') {
    return {
      success: true,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      resolvedPodName: target.resolvedPodName,
      resolvedContainerName: target.resolvedContainerName,
      ports: commandOutcome.ports,
      total: commandOutcome.ports.length,
      coverage: target.coverage,
      resolution: 'resolved',
      probe: commandOutcome.probe,
      commandPath: commandOutcome.commandPath,
    };
  }

  const procOutcome = await runProcFallback(
    client,
    validatedInput.namespace,
    target.resolvedPodName,
    target.resolvedContainerName
  );
  if (procOutcome.type === 'resolved') {
    return {
      success: true,
      namespace: validatedInput.namespace,
      podName: validatedInput.podName,
      labelSelector: validatedInput.labelSelector,
      container: validatedInput.container,
      resolvedPodName: target.resolvedPodName,
      resolvedContainerName: target.resolvedContainerName,
      ports: procOutcome.ports,
      total: procOutcome.ports.length,
      coverage: target.coverage,
      resolution: 'resolved',
      probe: procOutcome.probe,
      commandPath: procOutcome.commandPath,
    };
  }

  return {
    success: false,
    namespace: validatedInput.namespace,
    podName: validatedInput.podName,
    labelSelector: validatedInput.labelSelector,
    container: validatedInput.container,
    resolvedPodName: target.resolvedPodName,
    resolvedContainerName: target.resolvedContainerName,
    ports: [],
    total: 0,
    coverage: target.coverage,
    resolution: 'unavailable',
    error: buildExecKubernetesError('CommandUnavailable', `${commandOutcome.message}; ${procOutcome.message}`),
  };
}

async function runPortCommands(
  client: KubernetesClient,
  namespace: string,
  podName: string,
  containerName: string
): Promise<PortProbeOutcome> {
  let lastFailure = 'no listening-port command was available';
  for (const candidate of PORT_COMMANDS) {
    const result = await client.execPodCommand({
      namespace,
      podName,
      containerName,
      command: candidate.argv,
      timeoutMs: PORT_EXEC_TIMEOUT_MS,
      maxOutputBytes: PORT_EXEC_MAX_OUTPUT_BYTES,
    });

    if (!result.timedOut && result.exitCode === 0) {
      return {
        type: 'resolved',
        ports: dedupePorts(parsePorts(candidate.parser, sanitizeExecText(result.stdout))),
        probe: candidate.probe,
        commandPath: candidate.commandPath,
      };
    }

    if (!isCommandUnavailable(candidate, result)) {
      lastFailure = getExecFailureMessage(result);
    }
  }
  return { type: 'unavailable', message: lastFailure };
}

async function runProcFallback(
  client: KubernetesClient,
  namespace: string,
  podName: string,
  containerName: string
): Promise<PortProbeOutcome> {
  const ports: ListeningPort[] = [];
  let commandPath = '';
  let readAny = false;

  for (const procFile of PROC_NET_FILES) {
    const output = await readProcFile(client, namespace, podName, containerName, procFile);
    if (!output) {
      continue;
    }
    readAny = true;
    commandPath = output.commandPath;
    ports.push(...parseProcPorts(procFile, output.stdout));
  }

  if (!readAny) {
    return { type: 'unavailable', message: 'no ss/netstat command and no readable /proc/net files were available' };
  }

  return {
    type: 'resolved',
    ports: dedupePorts(ports),
    probe: 'proc-net',
    commandPath,
  };
}

async function readProcFile(
  client: KubernetesClient,
  namespace: string,
  podName: string,
  containerName: string,
  procFile: string
): Promise<{ stdout: string; commandPath: string } | undefined> {
  for (const candidate of CAT_COMMANDS) {
    const result = await client.execPodCommand({
      namespace,
      podName,
      containerName,
      command: [...candidate.argv, procFile],
      timeoutMs: PORT_EXEC_TIMEOUT_MS,
      maxOutputBytes: PORT_EXEC_MAX_OUTPUT_BYTES,
    });
    if (!result.timedOut && result.exitCode === 0) {
      return { stdout: sanitizeExecText(result.stdout), commandPath: candidate.commandPath };
    }
    if (isCommandUnavailable(candidate, result)) {
      continue;
    }
    const message = getExecFailureMessage(result).toLowerCase();
    if (message.includes(procFile) && message.includes('no such file')) {
      return undefined;
    }
  }
  return undefined;
}

function parsePorts(parser: PortParser, stdout: string): ListeningPort[] {
  return parser === 'ss' ? parseSsPorts(stdout) : parseNetstatPorts(stdout);
}

function parseSsPorts(stdout: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const protocol = parts[0];
    const state = parts[1];
    const endpoint = parts[4];
    const parsed = parseEndpoint(endpoint);
    if (!parsed || parsed.port <= 0) {
      continue;
    }
    ports.push({
      protocol,
      state,
      localAddress: parsed.address,
      port: parsed.port,
      source: 'ss',
    });
  }
  return ports;
}

function parseNetstatPorts(stdout: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Proto') || trimmed.startsWith('Active')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const protocol = parts[0];
    const state = parts[5];
    if (protocol.startsWith('tcp') && state !== 'LISTEN') {
      continue;
    }
    const parsed = parseEndpoint(parts[3]);
    if (!parsed || parsed.port <= 0) {
      continue;
    }
    ports.push({
      protocol,
      state,
      localAddress: parsed.address,
      port: parsed.port,
      source: 'netstat',
    });
  }
  return ports;
}

function parseProcPorts(procFile: string, stdout: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  const protocol = procFile.endsWith('tcp')
    ? 'tcp'
    : procFile.endsWith('tcp6')
      ? 'tcp6'
      : procFile.endsWith('udp')
        ? 'udp'
        : 'udp6';

  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const state = parts[3];
    if (protocol.startsWith('tcp') && state !== '0A') {
      continue;
    }
    const [addressHex, portHex] = parts[1].split(':');
    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0) {
      continue;
    }
    ports.push({
      protocol,
      state: protocol.startsWith('tcp') ? 'LISTEN' : state,
      localAddress: formatProcAddress(protocol, addressHex),
      port,
      source: 'proc',
    });
  }
  return ports;
}

function parseEndpoint(endpoint: string): { address: string; port: number } | undefined {
  const match = endpoint.match(/:(\d+)$/);
  if (!match) {
    return undefined;
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port)) {
    return undefined;
  }
  const address = endpoint.slice(0, endpoint.length - match[0].length).replace(/^\[(.*)]$/, '$1') || '*';
  return { address, port };
}

function formatProcAddress(protocol: string, addressHex: string): string {
  if (protocol === 'tcp' || protocol === 'udp') {
    const bytes = addressHex.match(/.{2}/g);
    return bytes ? bytes.reverse().map((value) => Number.parseInt(value, 16)).join('.') : addressHex;
  }
  const groups = addressHex.match(/.{1,4}/g);
  return groups ? groups.join(':') : addressHex;
}

function dedupePorts(ports: ListeningPort[]): ListeningPort[] {
  const seen = new Set<string>();
  return ports
    .filter((port) => {
      const key = `${port.protocol}:${port.localAddress}:${port.port}:${port.state ?? ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

function getInputString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}
