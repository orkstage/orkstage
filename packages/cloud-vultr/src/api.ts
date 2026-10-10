import { HttpError, ProviderError, failureClassForStatus, requestJson, safeMessage } from '@orkstage/cloud-core';

export const VULTR_API = 'https://api.vultr.com/v2';

/** Fields of the credential secret behind the target's credentialRef. */
export type VultrCredentials = {
  /** Vultr API key (account or user key with the permissions listed in the README). */
  apiKey: string;
  /** Object Storage keys of the subscription that holds the state bucket. */
  stateAccessKeyId: string;
  stateSecretAccessKey: string;
};

/** Small client for the Vultr v2 REST API. Errors never carry the key or response secrets. */
export class VultrApi {
  constructor(
    private readonly apiKey: string,
    private readonly f: typeof fetch,
    private readonly signal?: AbortSignal,
  ) {}

  /** GET a resource; `null` when Vultr answers 404 and `allow404` is set. */
  get<T>(path: string, allow404 = false): Promise<T | null> {
    return this.call<T>('GET', path, undefined, allow404);
  }

  async send<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return (await this.call<T>(method, path, body, false)) as T;
  }

  private async call<T>(method: string, path: string, body: unknown, allow404: boolean): Promise<T | null> {
    try {
      return await requestJson<T>(`${VULTR_API}${path}`, {
        method,
        fetch: this.f,
        signal: this.signal,
        allow404,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw toVultrError(err);
    }
  }
}

export function toVultrError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HttpError) return new ProviderError('VULTR_API_ERROR', err.message, failureClassForStatus(err.status), 'vultr', { status: err.status });
  return new ProviderError('VULTR_API_UNREACHABLE', safeMessage(err), 'NETWORK_ERROR', 'vultr');
}

/** Status code of a Vultr API failure, when there was an HTTP answer. */
export function statusOf(err: unknown): number | undefined {
  const status = (err as ProviderError).details?.status;
  return typeof status === 'number' ? status : undefined;
}

// Response shapes (only the fields the adapter reads).

export interface VultrDatabase {
  id: string;
  status: string;
  database_engine: string;
  host: string;
  public_host?: string;
  port: string;
  user: string;
  password: string;
  dbname?: string;
}

export interface VultrInstance {
  id: string;
  power_status: string;
  server_status: string;
}

export interface VultrLoadBalancer {
  id: string;
  status: string;
  instances?: string[];
}

export interface VultrObjectStorage {
  id: string;
  status: string;
  s3_hostname: string;
  s3_access_key: string;
  s3_secret_key: string;
}

export interface VultrDatabasePlan {
  id: string;
  number_of_nodes: number;
  type: string;
  vcpu_count: number;
  /** MB. */
  ram: number;
  disk: number;
  monthly_cost: number;
  supported_engines: Partial<Record<'mysql' | 'pg' | 'valkey' | 'kafka', boolean | null>>;
  locations: string[];
}

export interface VultrObjectStorageCluster {
  id: number;
  region: string;
  hostname: string;
  deploy: string;
}

export interface VultrObjectStorageTier {
  id: number;
  slug: string;
  sales_name?: string;
  price: number;
}
