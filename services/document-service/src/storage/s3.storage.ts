import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectMetadata, ObjectStorage } from './storage.port';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/**
 * S3-compatible object storage — MinIO in development, managed S3 in
 * production, unchanged code either way (ADR-014).
 *
 * ## Why every URL here is signed and short-lived
 *
 * The bucket is private, so there is no such thing as a URL that merely
 * "points at" an object; a URL that works *is* the authorisation. That makes
 * the expiry the only thing standing between a link and a permanent public
 * read, which is why the duration is passed in from configuration on every
 * call rather than defaulted here.
 *
 * ## What this class never does
 *
 * It never uploads. `PutObjectCommand` appears exactly once, inside
 * `createUploadUrl`, and is signed rather than sent — the object travels from
 * the client straight to storage and never through this process.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    // `ContentType` is part of what gets signed, so the URL only works for an
    // upload declaring the same type. It is not a substitute for inspecting
    // the bytes afterwards — a client can send matching headers and different
    // content — but it does stop the URL being reused for something else.
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.objectKey,
      ContentType: input.contentType,
    });

    return getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
  }

  async createDownloadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
    downloadFilename: string;
    contentType: string;
  }): Promise<string> {
    // `attachment` and an explicit content type together are what keep an
    // uploaded file from being *rendered*. ADR-014 forbids serving stored
    // content as HTML; a stored page fetched with `inline` and a guessed type
    // would run in the viewer's origin, which is precisely the hole.
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: input.objectKey,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(
        input.downloadFilename,
      )}"`,
      ResponseContentType: input.contentType,
    });

    return getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
  }

  async head(objectKey: string): Promise<ObjectMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );

      return {
        sizeBytes: Number(response.ContentLength ?? 0),
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
        lastModified: response.LastModified ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readPrefix(objectKey: string, length: number): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        // A ranged request. Storage sends a header, not a document.
        Range: `bytes=0-${Math.max(0, length - 1)}`,
      }),
    );

    const body = response.Body;
    if (!body) return new Uint8Array();

    // `transformToByteArray` is bounded by the range above, so this holds a
    // few kilobytes at most — never the object.
    return body.transformToByteArray();
  }

  async remove(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      return true;
    } catch (error) {
      // Logged without the endpoint credentials, and answered rather than
      // raised: a readiness probe that throws reads as a 500 rather than as
      // "not ready", and an orchestrator treats those differently.
      this.logger.warn(`Object storage is not reachable: ${describe(error)}`);
      return false;
    }
  }
}

/** A 404 from S3 arrives under several names depending on the operation. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') return true;
  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * A short, safe description of a storage failure.
 *
 * The error's own message can carry the signed URL, the endpoint and the
 * access key id (AGENTS.md S-09), so only the name is kept.
 */
function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return String((error as { name: unknown }).name);
  }
  return 'unknown error';
}
