import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

/**
 * Provider-neutral object storage. Raw artifacts are private by default: nothing here
 * generates public URLs.
 */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  ensureReady(): Promise<void>;
  ping(): Promise<boolean>;
}

export interface S3StorageOptions {
  endpoint: string | undefined;
  /** Must be true to target Amazon S3 itself, with `endpoint` unset. */
  useAwsDefaultEndpoint?: boolean;
  region: string;
  bucket: string;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  forcePathStyle: boolean;
}

/**
 * S3 client settings that fail closed. With no endpoint the AWS SDK silently targets real Amazon
 * S3, and with no static keys it reads ambient AWS credentials (~/.aws, AWS_PROFILE, instance
 * metadata). Both once created a bucket in the wrong account (FE-3), so static keys are required
 * on every path, the AWS opt-in included. Errors name settings only, never values.
 * @throws {Error} endpoint missing without the opt-in, both endpoint and opt-in set, or either
 *   static key missing.
 */
export function s3ClientConfig(opts: Omit<S3StorageOptions, 'bucket'>): S3ClientConfig {
  if (opts.useAwsDefaultEndpoint) {
    if (opts.endpoint)
      throw new Error('S3 storage: set either an endpoint or the AWS default endpoint, not both');
  } else if (!opts.endpoint) {
    throw new Error(
      'S3 storage: no endpoint (S3_ENDPOINT). Refusing to fall back to Amazon S3; ' +
        'set S3_USE_AWS_DEFAULT_ENDPOINT=true to use it on purpose',
    );
  }
  if (!opts.accessKeyId || !opts.secretAccessKey) {
    throw new Error(
      'S3 storage: S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set; ' +
        'refusing to use ambient AWS credentials',
    );
  }
  return {
    region: opts.region,
    endpoint: opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  };
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client(s3ClientConfig(opts));
  }

  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: metadata,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for object ${key}`);
    return await res.Body.transformToByteArray();
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw err;
    }
  }

  async ensureReady(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory implementation for unit tests and deterministic fixtures. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }
  async get(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`Object ${key} not found`);
    return new Uint8Array(o.body);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async ensureReady(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
}
