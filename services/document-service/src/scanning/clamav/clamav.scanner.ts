import { Injectable } from '@nestjs/common';
import { ClamdClient, ClamdError, type ClamdAddress } from './clamd.client';
import { signatureAgeSeconds, type ClamdVersion } from './protocol';
import type {
  MalwareScanner,
  ScanFailureReason,
  ScanRequest,
  ScanResult,
  ScannerHealth,
} from '../scanner.port';

/**
 * ClamAV behind the platform's scanner port (ADR-049, closes Q-18).
 *
 * ## What it does not claim
 *
 * ClamAV matches known signatures and applies a set of heuristics. It does not
 * detect what has no signature yet, it is weaker on targeted and freshly built
 * malware than commercial multi-engine services, and a `CLEAN` from it means
 * "nothing this database knows about matched" — not "safe". Every limitation
 * is written down in ADR-049 rather than implied by silence here, because a
 * scanner is exactly the component people over-trust.
 *
 * ## Everything that is not a verdict is a failure
 *
 * There is one path to `CLEAN` in this file and it requires all of: a reply
 * that parsed, as `OK`, from an engine whose version was read, whose signature
 * database is within the configured age. Any other outcome — timeout, refused
 * connection, unparseable reply, engine error, an object over the ceiling, a
 * scan that stopped at a limit, a database too old — returns `FAILED` with the
 * reason that caused it. None of them is downloadable.
 *
 * The asymmetry with `INFECTED` is deliberate: a stale database still finds
 * what it knows, so a match from one is still a match. It is only the *absence*
 * of a match that an old database cannot support.
 */

export interface ClamAvScannerOptions {
  readonly address: ClamdAddress;
  readonly timeoutMs: number;
  readonly chunkBytes: number;
  /** The largest object this deployment will submit. */
  readonly maxBytes: number;
  /** Beyond this, the database is too old for an absence of matches to mean anything. */
  readonly signatureMaxAgeSeconds: number;
  /** How long a version reply may be reused before it is asked for again. */
  readonly versionCacheSeconds: number;
  /** Injected so freshness can be tested without waiting a day. */
  readonly now?: () => Date;
}

interface CachedVersion {
  readonly version: ClamdVersion;
  readonly readAt: number;
}

@Injectable()
export class ClamAvMalwareScanner implements MalwareScanner {
  /** It opens the bytes and matches them against a signature database. */
  readonly inspectsContent = true;

  /**
   * Written to the database, published on events and returned by the API.
   *
   * The engine family rather than a version, because the version is its own
   * column: a query for "which documents were cleared by ClamAV" must not have
   * to enumerate every release that ever ran.
   */
  readonly name = 'clamav';

  private readonly client: ClamdClient;
  private readonly now: () => Date;
  private cachedVersion: CachedVersion | null = null;

  constructor(private readonly options: ClamAvScannerOptions) {
    this.client = new ClamdClient({
      address: options.address,
      timeoutMs: options.timeoutMs,
      chunkBytes: options.chunkBytes,
      maxBytes: options.maxBytes,
    });
    this.now = options.now ?? (() => new Date());
  }

  async scan(input: ScanRequest): Promise<ScanResult> {
    const startedAt = this.now();

    // 1. Size, before anything is opened.
    //
    // The object is not fetched at all for a request that cannot be accepted,
    // and the failure names the policy rather than surfacing later as a
    // truncated stream. `sizeBytes` is storage's number, not a client's — but
    // the client streaming below re-checks against what actually flows, because
    // metadata and reality are two different facts.
    if (input.sizeBytes > this.options.maxBytes) {
      return this.failed('SIZE_LIMIT_EXCEEDED', startedAt, null, false);
    }

    // 2. Freshness, before the object is read.
    //
    // A database too old to trust makes the whole exchange pointless: its
    // `OK` could not be recorded as CLEAN, so streaming megabytes to obtain
    // one would burn the scanner's queue to reach a verdict already known to
    // be unusable.
    let version: ClamdVersion;
    try {
      version = await this.readVersion();
    } catch (error) {
      return this.failed(reasonOf(error), startedAt, null, retryableOf(error));
    }

    const age = signatureAgeSeconds(version.signatureBuiltAt, startedAt);
    if (age > this.options.signatureMaxAgeSeconds) {
      // Retryable, because freshclam may well fix it without anybody doing
      // anything — and because the alternative, marking the backlog FAILED
      // during a signature outage, would make every document of that window
      // permanently undownloadable for an operational problem.
      return this.failed('STALE_SIGNATURES', startedAt, version, true);
    }

    // 3. The scan.
    let source;
    try {
      source = await input.open();
    } catch {
      // Deliberately not the storage error's message: it carries the bucket,
      // the endpoint and sometimes a signed URL (S-09).
      return this.failed('OBJECT_UNREADABLE', startedAt, version, true);
    }

    try {
      const reply = await this.client.scanStream(source, input.signal);

      switch (reply.kind) {
        case 'CLEAN':
          return {
            verdict: 'CLEAN',
            engine: this.name,
            engineVersion: version.engineVersion,
            signatureVersion: version.signatureVersion,
            signatureAgeSeconds: age,
            signature: null,
            failureReason: null,
            retryable: false,
            scannedAt: this.now(),
          };

        case 'FOUND':
          return {
            verdict: 'INFECTED',
            engine: this.name,
            engineVersion: version.engineVersion,
            signatureVersion: version.signatureVersion,
            signatureAgeSeconds: age,
            // The signature name clamd reported, which is a database entry
            // name and not a message about the file. Bounded, because it is
            // stored, logged and published on an event.
            signature: reply.signature.slice(0, 255),
            failureReason: null,
            retryable: false,
            scannedAt: this.now(),
          };

        case 'LIMITS_EXCEEDED':
          // Neither clean nor infected: the engine stopped early. Not
          // retryable — the same object against the same limits reaches the
          // same place, and retrying only delays an answer that will not
          // change. An operator either raises the limits or refuses the file.
          return this.failed('SCAN_LIMITS_EXCEEDED', startedAt, version, false);

        case 'ERROR':
          return this.failed('ENGINE_ERROR', startedAt, version, true);

        case 'UNPARSEABLE':
          return this.failed('MALFORMED_RESPONSE', startedAt, version, true);
      }
    } catch (error) {
      return this.failed(reasonOf(error), startedAt, version, retryableOf(error));
    }
  }

  async health(): Promise<ScannerHealth> {
    try {
      const version = await this.readVersion();
      const age = signatureAgeSeconds(version.signatureBuiltAt, this.now());
      const fresh = age <= this.options.signatureMaxAgeSeconds;

      return {
        available: true,
        engine: this.name,
        engineVersion: version.engineVersion,
        signatureVersion: version.signatureVersion,
        signatureAgeSeconds: age,
        signaturesFresh: fresh,
        detail: fresh
          ? null
          : 'the signature database is older than this deployment will accept for a clean verdict',
      };
    } catch (error) {
      return {
        available: false,
        engine: this.name,
        engineVersion: null,
        signatureVersion: null,
        signatureAgeSeconds: null,
        signaturesFresh: false,
        // A reason code, never the exception text: this reaches an
        // unauthenticated readiness probe, and a socket error message carries
        // the address (S-09).
        detail: reasonOf(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The engine and database versions, cached briefly.
   *
   * Cached because every scan needs them and they change a few times a day, so
   * asking per document would double the connections for information that is
   * almost always identical. The TTL is short because the value it protects is
   * a security decision: a database that went stale must be noticed within the
   * cache window, not within a deployment.
   */
  private async readVersion(): Promise<ClamdVersion> {
    const cached = this.cachedVersion;
    const ttlMs = this.options.versionCacheSeconds * 1000;

    if (cached && this.now().getTime() - cached.readAt < ttlMs) {
      return cached.version;
    }

    const version = await this.client.version();
    this.cachedVersion = { version, readAt: this.now().getTime() };
    return version;
  }

  private failed(
    reason: ScanFailureReason,
    startedAt: Date,
    version: ClamdVersion | null,
    retryable: boolean,
  ): ScanResult {
    return {
      verdict: 'FAILED',
      // Named even on a failure. `ck_document_scan_attributable` requires any
      // non-PENDING row to say which engine reached it, and "the ClamAV
      // adapter could not get an answer" is itself attributable information.
      engine: this.name,
      engineVersion: version?.engineVersion ?? null,
      signatureVersion: version?.signatureVersion ?? null,
      signatureAgeSeconds: version
        ? signatureAgeSeconds(version.signatureBuiltAt, startedAt)
        : null,
      signature: null,
      failureReason: reason,
      retryable,
      scannedAt: this.now(),
    };
  }
}

/** Maps a transport failure onto the port's reason codes. */
function reasonOf(error: unknown): ScanFailureReason {
  if (error instanceof ClamdError) {
    switch (error.kind) {
      case 'TIMEOUT':
        return 'TIMEOUT';
      case 'CONNECTION_FAILED':
        return 'CONNECTION_FAILED';
      case 'SIZE_LIMIT_EXCEEDED':
        return 'SIZE_LIMIT_EXCEEDED';
      case 'PROTOCOL_ERROR':
        return 'PROTOCOL_ERROR';
    }
  }
  // Anything unrecognised is still a failure. There is no branch here that
  // returns a verdict.
  return 'PROTOCOL_ERROR';
}

function retryableOf(error: unknown): boolean {
  // A ceiling this deployment set will refuse the same object next time.
  // Everything else — a refused socket, a deadline, a reply that did not
  // parse — is plausibly transient.
  return !(error instanceof ClamdError && error.kind === 'SIZE_LIMIT_EXCEEDED');
}
