import type { Readable } from 'node:stream';

/**
 * Raised by {@link ObjectStorage.copyToSealedKey} when the source object no
 * longer matches the ETag the caller pinned the copy to.
 *
 * A storage-port-level type rather than a leaked AWS SDK error, so the
 * domain can catch exactly this without knowing whether the underlying
 * client happens to call it `PreconditionFailed` or something else.
 */
export class ObjectChangedError extends Error {
  constructor() {
    // No object key in the message — ADR-014 keeps it inside this service,
    // and an uncaught throw can still reach a log line.
    super('The source object changed since it was last inspected');
    this.name = 'ObjectChangedError';
  }
}

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
   * The content type **and the declared size** are bound into the signature:
   * a client that asks for permission to upload a 2 MB PDF cannot use the
   * same URL to upload something else, or something a different size,
   * because the signature covers both headers. An HTTP client sets
   * `Content-Length` from the body it actually sends and cannot be told to
   * lie about it, so a body that does not match the declared size fails the
   * signature check at storage before a byte is accepted — the same
   * enforcement `content-type` already gets, extended to size.
   */
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;

  /**
   * Server-side copy into an object nothing but this method can create.
   *
   * The one step that closes the overwrite window: `finalize` calls this
   * once, immediately after reading the object back and validating it,
   * copying the just-inspected bytes into a key under
   * {@link KEY_ROOT_SEALED} that no upload credential was ever signed for.
   * From that instant the document row names the sealed key, never the one
   * the client's upload URL could still write to.
   *
   * `ifMatchETag` is not optional hardening — it is what makes the copy
   * provably of the bytes just inspected rather than of whatever happens to
   * be at `sourceKey` when the copy runs. Storage refuses the copy outright
   * if the source has changed since that ETag was read, which is what closes
   * the second race: an overwrite landing between the read-back and the
   * seal, not only one landing after it.
   */
  copyToSealedKey(input: {
    sourceKey: string;
    destinationKey: string;
    ifMatchETag: string;
  }): Promise<void>;

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
