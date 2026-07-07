import * as k8s from '@kubernetes/client-node';
import * as path from 'path';
import { Writable } from 'stream';

const K8S_REQUEST_TIMEOUT_MS = Number(process.env.K8S_REQUEST_TIMEOUT_MS ?? 60_000);
const DEFAULT_KUBECONFIG_PATH = path.join(process.cwd(), 'kubeconfig', 'hzh-kubeconfig');

export interface PodExecCommandRequest {
  namespace: string;
  podName: string;
  containerName: string;
  command: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface PodExecCommandStatus {
  status?: string;
  reason?: string;
  message?: string;
}

export interface PodExecCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
  status?: PodExecCommandStatus;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
  elapsedMs: number;
}

type PodExecConnection = {
  close: () => void;
  once: (event: 'close' | 'error', listener: (...args: unknown[]) => void) => unknown;
};

function attachRequestTimeout(
  client:
    | k8s.CoreV1Api
    | k8s.CustomObjectsApi
    | k8s.NetworkingV1Api
    | k8s.BatchV1Api
    | k8s.AppsV1Api,
  timeoutMs: number
): void {
  client.addInterceptor((requestOptions) => {
    requestOptions.timeout = timeoutMs;
  });
}

export class KubernetesClient {
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.CoreV1Api;
  private customObjectsApi: k8s.CustomObjectsApi;
  private networkingV1Api: k8s.NetworkingV1Api;
  private batchV1Api: k8s.BatchV1Api;
  private appsV1Api: k8s.AppsV1Api;
  private execClient: k8s.Exec;

  constructor(kubeconfigPath?: string, kubeconfigContent?: string) {
    this.kc = new k8s.KubeConfig();

    // Load from kubeconfig content first (highest priority), then file, then default
    if (kubeconfigContent) {
      this.kc.loadFromString(kubeconfigContent);
    } else if (kubeconfigPath) {
      this.kc.loadFromFile(kubeconfigPath);
    } else {
      this.kc.loadFromDefault();
    }

    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    this.networkingV1Api = this.kc.makeApiClient(k8s.NetworkingV1Api);
    this.batchV1Api = this.kc.makeApiClient(k8s.BatchV1Api);
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    this.execClient = new k8s.Exec(this.kc);

    attachRequestTimeout(this.k8sApi, K8S_REQUEST_TIMEOUT_MS);
    attachRequestTimeout(this.customObjectsApi, K8S_REQUEST_TIMEOUT_MS);
    attachRequestTimeout(this.networkingV1Api, K8S_REQUEST_TIMEOUT_MS);
    attachRequestTimeout(this.batchV1Api, K8S_REQUEST_TIMEOUT_MS);
    attachRequestTimeout(this.appsV1Api, K8S_REQUEST_TIMEOUT_MS);
  }

  /**
   * Get the Kubernetes API client
   */
  getApiClient(): k8s.CoreV1Api {
    return this.k8sApi;
  }

  /**
   * Get the Custom Objects API client for CRDs
   */
  getCustomObjectsApi(): k8s.CustomObjectsApi {
    return this.customObjectsApi;
  }

  /**
   * Get the Networking V1 API client for Ingress resources
   */
  getNetworkingV1Api(): k8s.NetworkingV1Api {
    return this.networkingV1Api;
  }

  /**
   * Get the Batch V1 API client for CronJob resources
   */
  getBatchV1Api(): k8s.BatchV1Api {
    return this.batchV1Api;
  }

  /**
   * Get the Apps V1 API client for Deployment resources
   */
  getAppsV1Api(): k8s.AppsV1Api {
    return this.appsV1Api;
  }

  async execPodCommand(request: PodExecCommandRequest): Promise<PodExecCommandResult> {
    const startedAt = Date.now();
    const stdout = new BoundedStringWritable(request.maxOutputBytes);
    const stderr = new BoundedStringWritable(request.maxOutputBytes);
    let status: k8s.V1Status | undefined;
    let settled = false;
    let connection: PodExecConnection | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    return await new Promise<PodExecCommandResult>((resolve) => {
      const finish = (partial: Partial<PodExecCommandResult> = {}) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          stdout: stdout.toStringValue(),
          stderr: stderr.toStringValue(),
          exitCode: getPodExecExitCode(status),
          status: toPodExecCommandStatus(status),
          timedOut: partial.timedOut ?? false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          error: partial.error,
          elapsedMs: Date.now() - startedAt,
        });
      };

      timeout = setTimeout(() => {
        connection?.close();
        finish({ timedOut: true, error: `pod exec timed out after ${request.timeoutMs}ms` });
      }, request.timeoutMs);

      this.execClient
        .exec(
          request.namespace,
          request.podName,
          request.containerName,
          [...request.command],
          stdout,
          stderr,
          null,
          false,
          (execStatus) => {
            status = execStatus;
            finish();
          }
        )
        .then((execConnection) => {
          if (settled) {
            execConnection.close();
            return;
          }
          connection = execConnection as PodExecConnection;
          connection.once('close', () => finish());
          connection.once('error', (error: unknown) => finish({ error: getErrorMessage(error) }));
        })
        .catch((error: unknown) => finish({ error: getErrorMessage(error) }));
    });
  }

  /**
   * Test connection to the cluster
   */
  async testConnection(): Promise<boolean> {
    try {
      // Try a simple API call to check connectivity
      await this.k8sApi.getAPIResources();
      return true;
    } catch (error: any) {
      // Extract meaningful error information without printing full stack trace
      let errorMessage = 'Unknown connection error';

      if (error.response && error.response.body && error.response.body.message) {
        errorMessage = error.response.body.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      console.error(`[KubernetesClient] Connection test failed: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Get current context information
   */
  getCurrentContext(): any {
    return this.kc.getCurrentContext();
  }
}

type DefaultKubernetesClientFacade = Pick<
  KubernetesClient,
  | 'getApiClient'
  | 'getCustomObjectsApi'
  | 'getNetworkingV1Api'
  | 'getBatchV1Api'
  | 'getAppsV1Api'
  | 'execPodCommand'
  | 'testConnection'
  | 'getCurrentContext'
>;

let defaultKubernetesClientInstance: KubernetesClient | null = null;

function getDefaultKubernetesClient(): KubernetesClient {
  if (!defaultKubernetesClientInstance) {
    defaultKubernetesClientInstance = new KubernetesClient(DEFAULT_KUBECONFIG_PATH);
  }

  return defaultKubernetesClientInstance;
}

export const kubernetesClient: DefaultKubernetesClientFacade = {
  getApiClient() {
    return getDefaultKubernetesClient().getApiClient();
  },
  getCustomObjectsApi() {
    return getDefaultKubernetesClient().getCustomObjectsApi();
  },
  getNetworkingV1Api() {
    return getDefaultKubernetesClient().getNetworkingV1Api();
  },
  getBatchV1Api() {
    return getDefaultKubernetesClient().getBatchV1Api();
  },
  getAppsV1Api() {
    return getDefaultKubernetesClient().getAppsV1Api();
  },
  execPodCommand(request: PodExecCommandRequest) {
    return getDefaultKubernetesClient().execPodCommand(request);
  },
  testConnection() {
    return getDefaultKubernetesClient().testConnection();
  },
  getCurrentContext() {
    return getDefaultKubernetesClient().getCurrentContext();
  },
};

class BoundedStringWritable extends Writable {
  private chunks: Buffer[] = [];
  private capturedBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const remaining = Math.max(this.maxBytes - this.capturedBytes, 0);
    if (remaining > 0) {
      const captured = buffer.subarray(0, remaining);
      this.chunks.push(captured);
      this.capturedBytes += captured.length;
    }
    if (buffer.length > remaining) {
      this.truncated = true;
    }
    callback();
  }

  toStringValue(): string {
    return Buffer.concat(this.chunks, this.capturedBytes).toString('utf8');
  }
}

function getPodExecExitCode(status: k8s.V1Status | undefined): number | undefined {
  const exitCodeCause = status?.details?.causes?.find((cause) => cause.reason === 'ExitCode');
  const parsed = Number(exitCodeCause?.message);
  if (Number.isInteger(parsed)) {
    return parsed;
  }
  return status?.status === 'Success' ? 0 : undefined;
}

function toPodExecCommandStatus(status: k8s.V1Status | undefined): PodExecCommandStatus | undefined {
  if (!status) {
    return undefined;
  }
  return {
    status: status.status,
    reason: status.reason,
    message: status.message,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'pod exec failed';
}
