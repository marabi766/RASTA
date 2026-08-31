/**
 * The object-storage boundary (ADR-014).
 *
 * An interface rather than a class so that "swapping MinIO for managed S3 is a
 * configuration change" is structurally true, and so a test can substitute the
 * one genuinely external system without substituting anything of this
 * service's own logic.
 *
 * Note what is **absent**: there is no `put`, no `upload`, no stream in.
 * The service cannot write an object even if somebody later wanted it to,
 * because the port gives it no way to. That is the ADR-014 rule — the file
 * never passes through the service — expressed as a type rather than as a
 * comment somebody has to remember.
 */

export interface ObjectMetadata {
  /** Size in bytes, as storage reports it — never as the client claimed. */
  readonly sizeBytes: number;
  /** What storage recorded at upload. A client-set claim; never trusted alone. */
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

export interface ObjectStorage {
  /**
   * A short-lived URL the client may PUT one object to.
   *
   * The content type is bound into the signature: a client that asks for
   * permission to upload a PDF cannot use the same URL to upload something
   * else, because the signature covers the header.
   */
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;

  /** A short-lived URL for reading one object, as an attachment. */
  createDownloadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
    /** Sanitised, for `Content-Disposition`. Never the raw client filename. */
    downloadFilename: string;
    /** Sent as `response-content-type`, so the browser is told what we detected. */
    contentType: string;
  }): Promise<string>;

  /** Metadata only. `null` when the object is not there. */
  head(objectKey: string): Promise<ObjectMetadata | null>;

  /**
   * The first `length` bytes, for magic-number inspection.
   *
   * A ranged read, not a download: the caller asks for a header and gets a
   * header. The whole object is never fetched, so the ADR-014 promise holds
   * even here.
   */
  readPrefix(objectKey: string, length: number): Promise<Uint8Array>;

  /** Removes the object. Used only after the metadata row records the deletion. */
  remove(objectKey: string): Promise<void>;

  /** Whether the bucket is reachable, for the readiness probe. */
  isHealthy(): Promise<boolean>;
}
