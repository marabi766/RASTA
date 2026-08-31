import type { Readable } from 'node:stream';

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
 * never passes through the service on its way *to* storage — expressed as a
 * type rather than as a comment somebody has to remember.
 *
 * Reading is now asymmetric with writing, and deliberately so.
 * {@link ObjectStorage.openReadStream} was added for the malware scanner
 * (ADR-049) because clamd has to see the bytes; it is used by the background
 * worker and by nothing in the request path.
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

  /**
   * The object as a stream, for the malware scanner (ADR-049).
   *
   * ## The one place bytes leave storage in bulk, and why it is allowed
   *
   * ADR-014 says the file never passes through this service, and the request
   * path still honours that absolutely: upload and download are signed URLs
   * between the client and storage, and no HTTP handler in this service ever
   * holds document content. This method exists for the **asynchronous scan
   * worker**, which is out of band, and which has no alternative — clamd's
   * INSTREAM protocol requires the bytes, and a self-hosted engine cannot read
   * an S3 object on the service's behalf. ADR-049 records the amendment
   * explicitly rather than letting a method appear here quietly.
   *
   * What is preserved is the property the rule was protecting: the object is
   * **streamed**, in bounded frames, and never accumulated. Scanning a 25 MB
   * document costs one frame of memory, not 25 MB, and no request is waiting
   * on it.
   *
   * `maxBytes` is a hard stop enforced while reading, not a hint checked
   * against metadata beforehand. Storage reports a size; a stream is what
   * actually arrives, and the ceiling has to apply to the second one.
   */
  openReadStream(input: { objectKey: string; maxBytes: number }): Promise<Readable>;

  /** Removes the object. Used only after the metadata row records the deletion. */
  remove(objectKey: string): Promise<void>;

  /** Whether the bucket is reachable, for the readiness probe. */
  isHealthy(): Promise<boolean>;
}
