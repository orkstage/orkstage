// SPDX-License-Identifier: AGPL-3.0-only
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Where a provider keeps OpenTofu state and the configuration applied beside it: always in the
 * customer's own storage (S3 compatible bucket, Azure Blob container, GCS bucket). The control
 * plane reads state through this to answer "does it exist" and "what are its outputs" without
 * starting a runner container.
 */
export interface StateStore {
  /** Human readable location for validation messages, e.g. `s3://bucket` on an endpoint. */
  readonly location: string;
  /** Throws when the store is missing or not accessible with these credentials. */
  check(signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<string | null>;
  put(key: string, body: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export interface S3CompatibleOptions {
  /** Service endpoint, e.g. https://nyc3.digitaloceanspaces.com. Omit for AWS itself. */
  endpoint?: string;
  /** Signing region; S3 compatible stores usually accept their own region name or us-east-1. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path style addressing (endpoint/bucket/key). Most S3 compatible stores need it. */
  pathStyle?: boolean;
}

/** State in an S3 compatible object store (OCI, DigitalOcean Spaces, Vultr, Magalu, CoreWeave). */
export class S3CompatibleStateStore implements StateStore {
  readonly location: string;
  private readonly s3: S3Client;

  constructor(private readonly opts: S3CompatibleOptions) {
    this.location = `s3://${opts.bucket}${opts.endpoint ? ` at ${new URL(opts.endpoint).host}` : ''}`;
    this.s3 = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.pathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Third party stores reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async check(signal?: AbortSignal): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.opts.bucket }), { abortSignal: signal });
  }

  async get(key: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), { abortSignal: signal });
      return (await r.Body?.transformToString()) ?? null;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async put(key: string, body: string, signal?: AbortSignal): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentType: 'application/json' }), { abortSignal: signal });
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }), { abortSignal: signal });
  }
}

/**
 * `backend "s3"` block for an S3 compatible store. Credentials come from AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY in the runner environment (see `s3BackendEnv`), never from the config.
 * `lockfile` turns on S3 native locking, which needs conditional writes; leave it off for stores
 * that do not support them (the platform already runs one operation per resource at a time).
 */
export function s3CompatibleBackend(opts: { endpoint: string; region: string; bucket: string; key: string; lockfile?: boolean; pathStyle?: boolean }) {
  return {
    s3: {
      bucket: opts.bucket,
      key: opts.key,
      region: opts.region,
      endpoints: { s3: opts.endpoint },
      use_path_style: opts.pathStyle ?? true,
      use_lockfile: opts.lockfile ?? false,
      skip_credentials_validation: true,
      skip_region_validation: true,
      skip_requesting_account_id: true,
      skip_metadata_api_check: true,
      skip_s3_checksum: true,
    },
  };
}

export function s3BackendEnv(accessKeyId: string, secretAccessKey: string): Record<string, string> {
  return { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey };
}
