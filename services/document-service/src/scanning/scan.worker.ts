import { Inject, Injectable } from '@nestjs/common';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { withSpan } from '@rasta/observability';
import type { Logger } from '@rasta/logging';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { DOCUMENT_EVENTS } from '../events/events';
import { ENV, LOGGER, MALWARE_SCANNER, OBJECT_STORAGE } from '../tokens';
import { SERVICE_NAME, type DocumentEnv } from '../config/env';
import type { ObjectStorage } from '../storage/storage.port';
import {
  scanDurationSeconds,
  scanFailuresTotal,
  scanPendingOldestAgeSeconds,
  scanPendingTotal,
  scanRetriesTotal,
  scanSignatureAgeSeconds,
  scanVerdictsTotal,
  scannerUp,
} from '../observability/metrics';
import type { MalwareScanner, ScanResult } from './scanner.port';
import { ScanRepository, type ClaimedDocument } from './scan.repository';
import { backoffMs, decideTransition, stateOf } from './transitions';

/**
 * The asynchronous scan lifecycle (ADR-014 step 4, ADR-049).
 *
 * ## Why scanning is not part of finalization
 *
 * It used to be: `finalize` called the scanner inline and wrote the verdict
 * with the row. That was tolerable only because the scanner did nothing. A
 * real engine turns it into streaming tens of megabytes through clamd while an
 * HTTP client holds a connection open, which makes every registration as slow
 * as the slowest object queued ahead of it, ties the gateway's timeout to the
 * scanner's throughput, and loses the verdict entirely if the client hangs up.
 * ADR-014 specified an asynchronous scan from the start; a real scanner makes
 * it mandatory.
 *
 * The consequence a reader should hold onto: **a freshly registered document is
 * `PENDING` and is not downloadable**, for as long as the queue takes. That is
 * the fail-closed direction. A scanner outage makes new documents unavailable;
 * it never makes them available.
 *
 * ## Idempotency and concurrency, concretely
 *
 * Everything rests on two conditional writes in `ScanRepository`. A worker
 * claims with `FOR UPDATE SKIP LOCKED` and stamps a lease; every write-back
 * requires the state to still be `PENDING` **and** the lease to still be its
 * own. So:
 *
 *   - Two replicas never claim the same document in the same instant.
 *   - A worker that stalls past its lease loses the write, and the verdict
 *     reached by whoever took over stands. There is no last-writer-wins.
 *   - A document scanned twice — a stalled worker returning, a retry above
 *     the queue — records one verdict and enqueues its events once, because
 *     the second write matches zero rows and the events are enqueued inside
 *     the same transaction as the write that won.
 *
 * The events are the part that would be hard to fix after the fact: a second
 * `VIRUS_DETECTED` reaches notification-service, which treats it as critical.
 */
@Injectable()
export class ScanWorker {
  /**
   * This worker's lease identity, minted per process.
   *
   * A ULID rather than a hostname: two replicas on one host, or a pod that
   * restarted and kept its name, would otherwise share an identity and each
   * accept the other's stale write-back — the exact race the lease exists to
   * stop.
   */
  private readonly owner = `scan-${ulid()}`;

  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scans: ScanRepository,
    private readonly events: EventPublisher,
    @Inject(ENV) private readonly env: DocumentEnv,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    if (!this.env.DOCUMENT_SCAN_WORKER_ENABLED) {
      this.logger.warn(
        { scanner: this.scanner.name },
        'The scan worker is disabled; documents will stay PENDING and undownloadable',
      );
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.tick();
    }, this.env.DOCUMENT_SCAN_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Let an in-flight batch finish rather than abandoning leases mid-scan.
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Scans one batch.
   *
   * Guards only against *overlapping* ticks. It deliberately does not require
   * the worker to be started, so an operator can drain the queue by hand
   * during an incident and a test can drive it deterministically instead of
   * racing a poll interval.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const batch = await this.scans.claim({
        owner: this.owner,
        limit: this.env.DOCUMENT_SCAN_BATCH_SIZE,
        leaseSeconds: this.env.DOCUMENT_SCAN_LEASE_SECONDS,
      });

      for (const document of batch) {
        if (this.stopped) {
          // Shutting down. Put the rest back rather than holding leases until
          // they expire, so a rolling deploy does not pause the queue.
          await this.scans.releaseIfHeld(document.id, this.owner);
          continue;
        }
        await this.process(document);
      }

      return batch.length;
    } catch (error) {
      // A failure to *claim* is an infrastructure problem, not a document
      // problem. Logged and swallowed: the next tick retries, and throwing out
      // of a timer callback would take the process down over a transient
      // database blip.
      this.logger.error({ err: error }, 'The scan worker could not claim work');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Refreshes the queue and scanner gauges. Never throws. */
  async sampleGauges(): Promise<void> {
    try {
      scanPendingTotal.set({ service: SERVICE_NAME }, await this.scans.pendingCount());
      scanPendingOldestAgeSeconds.set(
        { service: SERVICE_NAME },
        await this.scans.oldestPendingAgeSeconds(),
      );

      const health = await this.scanner.health();
      scannerUp.set({ service: SERVICE_NAME, engine: health.engine }, health.available ? 1 : 0);
      if (health.signatureAgeSeconds !== null) {
        scanSignatureAgeSeconds.set(
          { service: SERVICE_NAME, engine: health.engine },
          health.signatureAgeSeconds,
        );
      }
    } catch (error) {
      // Upkeep must never take the service down, and a metric that failed to
      // update is not a reason to stop scanning.
      this.logger.debug({ err: error }, 'Scan gauge sampling failed');
    }
  }

  // -------------------------------------------------------------------------
  // One document
  // -------------------------------------------------------------------------

  private async process(document: ClaimedDocument): Promise<void> {
    // A correlation id per scan, so the claim, the stream, the verdict and the
    // event it produced are one searchable thread. The worker has no incoming
    // request to inherit one from, so it mints its own and carries the tenant
    // the document belongs to — which is what makes a per-tenant investigation
    // possible without a per-tenant metric label.
    const context: RequestContext = {
      correlationId: `scan-${ulid()}`,
      requestId: `scan-${ulid()}`,
      organizationId: document.organizationId,
      userId: SERVICE_NAME,
      roles: [],
      authType: 'SERVICE',
      callerService: SERVICE_NAME,
      startedAt: Date.now(),
    };

    await runWithContext(context, async () => {
      const startedAt = Date.now();

      const result = await withSpan('document.scan', async () => this.runScan(document), {
        attributes: {
          // Safe attributes only. No document id, no object key, no
          // filename: a trace is retained and searchable, and ADR-014 keeps
          // the object key inside this service on purpose.
          'rasta.document.class': document.documentClass,
          'rasta.document.size_bytes': document.sizeBytes,
          'rasta.scan.engine': this.scanner.name,
          'rasta.scan.attempt': document.scanAttempts + 1,
        },
      });

      const decision = decideTransition({
        result,
        scanner: this.scanner,
        previousAttempts: document.scanAttempts,
        maxAttempts: this.env.DOCUMENT_SCAN_MAX_ATTEMPTS,
      });

      await withSpan('document.scan.persist', async () => this.persist(document, result, decision));

      scanDurationSeconds.observe(
        { service: SERVICE_NAME, verdict: stateOf(decision) },
        (Date.now() - startedAt) / 1000,
      );
    });
  }

  /** Opens the object and asks the scanner. Failure to read is a scan failure. */
  private async runScan(document: ClaimedDocument): Promise<ScanResult> {
    return this.scanner.scan({
      // Opened lazily, inside its own span, and only if the scanner gets past
      // its size and freshness checks — so an oversized object is refused
      // without a byte leaving storage.
      open: () =>
        withSpan('document.scan.fetch', async () =>
          this.storage.openReadStream({
            objectKey: document.objectKey,
            maxBytes: this.env.DOCUMENT_SCAN_MAX_BYTES,
          }),
        ),
      sizeBytes: document.sizeBytes,
      contentType: document.contentType,
    });
  }

  /**
   * Records the outcome and, if this worker won the write, its events.
   *
   * The events are enqueued inside the same transaction as the state change
   * and only when the conditional update matched, which is what makes
   * "duplicate processing has one domain effect" true rather than likely
   * (AGENTS.md A-08, A-09).
   */
  private async persist(
    document: ClaimedDocument,
    result: ScanResult,
    decision: ReturnType<typeof decideTransition>,
  ): Promise<void> {
    if (decision.kind === 'RETRY') {
      const delay = backoffMs(
        decision.attempt,
        this.env.DOCUMENT_SCAN_RETRY_BASE_MS,
        this.env.DOCUMENT_SCAN_RETRY_MAX_MS,
      );
      const reason = result.failureReason ?? 'PROTOCOL_ERROR';

      const won = await this.prisma.transaction((tx) =>
        this.scans.rescheduleIfHeld(tx, {
          documentId: document.id,
          owner: this.owner,
          nextAttemptAt: new Date(Date.now() + delay),
        }),
      );

      if (won) {
        scanRetriesTotal.inc({ service: SERVICE_NAME, reason });
        scanFailuresTotal.inc({ service: SERVICE_NAME, reason });
        this.logger.warn(
          {
            documentId: document.id,
            organizationId: document.organizationId,
            reason,
            attempt: decision.attempt,
            retryInMs: delay,
          },
          'Scan attempt failed and will be retried',
        );
      }
      return;
    }

    const scanState = stateOf(decision) as 'CLEAN' | 'INFECTED' | 'FAILED';
    const signature = decision.kind === 'INFECTED' ? decision.signature : null;
    const failureReason = decision.kind === 'FAILED' ? decision.reason : null;

    const won = await this.prisma.transaction(async (tx) => {
      const applied = await this.scans.completeIfHeld(tx, {
        documentId: document.id,
        owner: this.owner,
        scanState,
        engine: result.engine,
        engineVersion: result.engineVersion,
        signatureVersion: result.signatureVersion,
        signature,
        failureReason,
        // Written with the verdict, never after it. The database refuses an
        // INFECTED row that carries no quarantine record, so there is no
        // instant in which a document is known infected and undecided.
        quarantineReason:
          decision.kind === 'INFECTED'
            ? `Malware signature ${decision.signature} detected by ${result.engine}; ` +
              'the object is retained as evidence and is permanently undownloadable'
            : null,
        scannedAt: result.scannedAt,
      });

      // Lost the race, or the document already has a verdict. Nothing is
      // written and nothing is published — the worker that won did both.
      if (!applied) return false;

      await this.events.enqueue(tx, {
        eventName: DOCUMENT_EVENTS.DOCUMENT_SCANNED,
        aggregateId: document.id,
        organizationId: document.organizationId,
        payload: {
          documentId: document.id,
          organizationId: document.organizationId,
          documentClass: document.documentClass,
          scanState,
          engine: result.engine,
          engineVersion: result.engineVersion,
          signatureVersion: result.signatureVersion,
          failureReason,
          scannedAt: result.scannedAt.toISOString(),
        },
      });

      if (decision.kind === 'INFECTED') {
        // Only a scanner that genuinely inspected content can conclude this.
        // The guard is explicit rather than implied by which class is bound,
        // because a fabricated security finding is worse than silence:
        // notification-service treats this event as critical and somebody acts
        // on it.
        if (!this.scanner.inspectsContent) {
          throw new Error('An infection was reported by a scanner that inspects nothing');
        }

        await this.events.enqueue(tx, {
          eventName: DOCUMENT_EVENTS.VIRUS_DETECTED,
          aggregateId: document.id,
          organizationId: document.organizationId,
          payload: {
            documentId: document.id,
            organizationId: document.organizationId,
            engine: result.engine,
            engineVersion: result.engineVersion,
            signature: decision.signature,
            detectedAt: result.scannedAt.toISOString(),
          },
        });
      }

      return true;
    });

    if (!won) {
      this.logger.debug(
        { documentId: document.id, verdict: scanState },
        'A scan result was discarded because another worker had already recorded one',
      );
      return;
    }

    scanVerdictsTotal.inc({ service: SERVICE_NAME, verdict: scanState });
    if (failureReason) {
      scanFailuresTotal.inc({ service: SERVICE_NAME, reason: failureReason });
    }

    if (decision.kind === 'INFECTED') {
      // Logged at `warn` with the signature name and no file content: the
      // signature is a database entry name, and the filename, the object key
      // and the bytes are all deliberately absent (AGENTS.md S-09).
      this.logger.warn(
        {
          documentId: document.id,
          organizationId: document.organizationId,
          engine: result.engine,
          signature: decision.signature,
        },
        'Malware detected; the document is quarantined and permanently undownloadable',
      );
    } else if (decision.kind === 'FAILED') {
      this.logger.error(
        {
          documentId: document.id,
          organizationId: document.organizationId,
          reason: failureReason,
          attempts: document.scanAttempts + 1,
        },
        'Scanning failed terminally; the document stays undownloadable',
      );
    }
  }
}
