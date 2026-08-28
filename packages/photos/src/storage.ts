import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

// The private object store behind both photo tiers (ADR-007). Serving is
// app-mediated — callers stream `get()` through an authed route with cache
// headers; the bucket itself is never public.

export interface StoredObject {
  body: ReadableStream | Buffer;
  contentType: string;
}

export interface PhotoStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

export interface S3PhotoStorageConfig {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Ceph RGW over the S3 API: path-style addressing, explicit endpoint, static
// credentials from the ObjectBucketClaim secret.
export function createS3PhotoStorage(config: S3PhotoStorageConfig): PhotoStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "us-east-1",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
  const bucket = config.bucket;

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!out.Body) throw new Error(`Object ${key} has no body`);
      return {
        body: out.Body.transformToWebStream(),
        contentType: out.ContentType ?? "application/octet-stream",
      };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// In-memory store for tests — a plain Map, defensive-copying on write.
export function createMemoryPhotoStorage(): PhotoStorage {
  const store = new Map<string, { body: Buffer; contentType: string }>();
  return {
    put(key, body, contentType) {
      store.set(key, { body: Buffer.from(body), contentType });
      return Promise.resolve();
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) return Promise.reject(new Error(`Object ${key} not found`));
      return Promise.resolve({ body: entry.body, contentType: entry.contentType });
    },
    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

// Wire storage from the environment. Returns null when unconfigured — the photos
// feature is then disabled and the web degrades gracefully (ADR-007: the journal
// core keeps working when RGW is absent).
export function photoStorageFromEnv(
  env: Record<string, string | undefined> = process.env,
): PhotoStorage | null {
  const endpoint = env.PHOTOS_S3_ENDPOINT;
  const bucket = env.PHOTOS_S3_BUCKET;
  const accessKeyId = env.PHOTOS_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.PHOTOS_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return createS3PhotoStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.PHOTOS_S3_REGION,
  });
}
