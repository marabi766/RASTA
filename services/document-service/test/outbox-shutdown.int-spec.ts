import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  installGracefulShutdown,
  runUnscoped,
  type AuthGuardOptions,
  type InternalTokenService,
  type OutboxClaim,
  type OutboxRow,
  type TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from '../src/app.module';
import { SERVICE_NAME, type DocumentEnv } from '../src/config/env';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { ScanRepository } from '../src/scanning/scan.repository';
import type { MalwareScanner, ScanResult } from '../src/scanning/scanner.port';
import { ENV, MALWARE_SCANNER } from '../src/tokens';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AlwaysCleanScanner } from './clean-scanner';
import {
  FIXTURES,
  asActor,
  cleanup,
  newPrisma,
  putToSignedUrl,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Codex r3 on #247: the scan worker in the whole shutdown path, through the
 * real AppModule.
 *
 * The relay and the purge drained in Nest's destroy phase by one deadline, but
 * the scan worker was stopped only in `onApplicationShutdown`: it kept polling
 * while the relay drained, and its `stop()` then waited, unbounded, for a scan
 * that may take DOCUMENT_SCAN_TIMEOUT_MS (60 s by default). Past
 * SHUTDOWN_TIMEOUT_MS the process exited forced, mid-scan, holding the lease.
 *
 * Here a relay publish never ends, and the real `installGracefulShutdown`
 * closes the real module — the real `ScanWorker` and `ScanRepository` against
 * the real database — under the real process deadline. Settings: relay grace
 * 6 s, timeout 9 s, so the shared budget is 7 s.
 *
 * Only the outbox store, the broker and the scanner are stand-ins: the relay
 * claims across the whole table by design, and the scanner is what has to be
 * slow. The worker's claim is table-wide too, oldest first; this suite's own
 * two documents are made the oldest in the queue so the batch is theirs.
 */
const SHUTDOWN_TIMEOUT_MS = 9000;
const GRACE_SECONDS = 6;

const probeRow = (): OutboxRow => ({
  id: 'SHUTDOWN-PROBE',
  aggregateType: 'Probe',
  aggregateId: 'SHUTDOWN-PROBE',
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.document.v1',
  partitionKey: 'SHUTDOWN-PROBE',
  payload: {},
  headers: {},
  organizationId: 'ORG-SHUTDOWN-PROBE',
  correlationId: 'SHUTDOWN-PROBE',
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A strictly increasing counter: the order of events, which a clock in ms cannot give. */
let ticks = 0;
const tick = (): number => (ticks += 1);

/** A scanner that reports CLEAN after `delayMs`, or never when `delayMs` is null. */
class SlowScanner extends AlwaysCleanScanner implements MalwareScanner {
  scans = 0;
  constructor(private readonly delayMs: number | null) {
    super();
  }
  override async scan(): Promise<ScanResult> {
    this.scans += 1;
    if (this.delayMs === null) return never<ScanResult>();
    await new Promise((resolve) => setTimeout(resolve, this.delayMs!));
    return super.scan();
  }
}

interface ScanRow {
  id: string;
  scanState: string;
  scanLeaseOwner: string | null;
  scanAttempts: number;
}

describe('document-service shutdown: the scan worker by the outbox deadline (D-052)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;
  let env: DocumentEnv;

  beforeAll(() => {
    prisma = newPrisma();
    env = testEnv({
      NODE_ENV: 'test',
      KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
      KAFKA_ALLOW_PLAINTEXT: process.env.KAFKA_ALLOW_PLAINTEXT ?? 'true',
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
      OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
      OUTBOX_POLL_INTERVAL_MS: '50',
      OUTBOX_PURGE_MAX_WAIT_MS: '100',
      OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
      // No scheduled run: the purge is not this suite's subject.
      OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
      DOCUMENT_SCAN_WORKER_ENABLED: 'true',
      DOCUMENT_SCAN_POLL_INTERVAL_MS: '250',
      DOCUMENT_SCAN_BATCH_SIZE: '2',
    });
    wiring = wire(prisma, { env });
  });

  afterAll(async () => {
    if (wiring) await cleanup(prisma, [org.a], wiring.storage);
    await prisma?.onModuleDestroy();
  });

  /** Two PENDING documents of this suite, moved to the head of the queue. */
  async function twoQueuedDocuments(): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const bytes = FIXTURES.pdf();
      const as = <T>(fn: () => Promise<T>) =>
        asActor({ organizationId: org.a, roles: ['ORGANIZATION_ADMIN'] }, fn);
      const intent = await as(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT' as never,
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'shutdown.pdf',
        }),
      );
      expect(await putToSignedUrl(intent.uploadUrl, bytes, 'application/pdf')).toBe(200);
      const document = await as(() =>
        wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
      );
      ids.push(document.id);
    }
    // Oldest first is the claim's order; these become the oldest, in this
    // order — older than an earlier test's, which are back in the queue.
    queued += 1;
    await runUnscoped('the suite queues its own documents first', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE "document"
            SET "scan_queued_at" = TIMESTAMPTZ '2000-01-01 00:00:00+00'
                                   - ($2::int * interval '1 day')
                                   + (array_position($1::text[], "id") * interval '1 second')
          WHERE "id" = ANY($1::text[])`,
        ids,
        queued,
      ),
    );
    return ids;
  }
  let queued = 0;

  const rows = (ids: string[]) =>
    runUnscoped('the suite reads its own documents', () =>
      prisma.client.document.findMany({
        where: { id: { in: ids } },
        select: { id: true, scanState: true, scanLeaseOwner: true, scanAttempts: true },
        orderBy: { scanQueuedAt: 'asc' },
      }),
    ) as Promise<ScanRow[]>;

  /** Boots AppModule with a relay whose publish never ends and the given scanner. */
  async function boot(scanner: MalwareScanner) {
    let claimed = false;
    const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
      claimPending: async (): Promise<OutboxClaim> => {
        if (claimed) return { token: null, rows: [], reclaimed: 0 };
        claimed = true;
        return { token: 'tok-shutdown', rows: [probeRow()], reclaimed: 0 };
      },
      markPublished: async (ids: readonly string[]) => ids.length,
      markFailed: async () => 1,
      release: async (ids: readonly string[]) => ids.length,
      renew: async (ids: readonly string[]) => [...ids],
      oldestPendingAgeSeconds: async () => 0,
      pendingCount: async () => 0,
      activeLeaseCount: async () => 0,
      purgePublished: () => never(),
    };
    const publishes = { count: 0 };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(PrismaOutboxStore)
      .useValue(store)
      .overrideProvider(KafkaEventPublisher)
      .useValue({
        publish: () => {
          publishes.count += 1;
          return never<void>();
        },
      })
      .overrideProvider(MALWARE_SCANNER)
      .useValue(scanner)
      .overrideProvider(AUTH_OPTIONS)
      .useValue({
        serviceName: SERVICE_NAME,
        tokenVerifier: {} as unknown as TokenVerifier,
        internalTokens: {} as unknown as InternalTokenService,
      } satisfies AuthGuardOptions)
      .compile();
    const app: INestApplication = moduleRef.createNestApplication();
    // Every claim the booted worker makes, with its place in the order of
    // events (`tick`), stamped when the claim is issued. Not wall-clock ms: a
    // claim and the start of the close can share a millisecond.
    const claims: { seq: number; ids: string[] }[] = [];
    const scans = app.get(ScanRepository);
    const claim = scans.claim.bind(scans);
    jest.spyOn(scans, 'claim').mockImplementation(async (input) => {
      const seq = tick();
      const batch = await claim(input);
      claims.push({ seq, ids: batch.map((d) => d.id) });
      return batch;
    });
    await app.init();
    return { app, claims, publishes };
  }

  async function until(condition: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(condition()).toBe(true);
  }

  async function closeUnderDeadline(app: INestApplication) {
    const exits: number[] = [];
    const errors: string[] = [];
    const shutdown = installGracefulShutdown(app, {
      serviceName: SERVICE_NAME,
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      exit: (code) => exits.push(code),
      signalSource: new EventEmitter(),
      logger: { warn: () => undefined, error: (message) => errors.push(message) },
    });
    const startedAt = Date.now();
    // Taken in the same synchronous run as the call, so every claim issued
    // before it has a smaller `seq` and every later one a larger.
    const closeSeq = tick();
    await shutdown.shutdown('SIGTERM');
    return { exits, errors, closeSeq, tookMs: Date.now() - startedAt };
  }

  afterEach(() => jest.restoreAllMocks());

  it('a scan that never ends and a publish that never ends: a clean close under SHUTDOWN_TIMEOUT_MS, both claims handed back', async () => {
    const ids = await twoQueuedDocuments();
    const scanner = new SlowScanner(null);
    const { app, claims, publishes } = await boot(scanner);

    // The worker claims this suite's two documents and its scan of the first
    // hangs; the relay's publish hangs too.
    await until(() => scanner.scans === 1 && publishes.count === 1);
    expect(claims[0]?.ids).toEqual(ids);
    const before = await rows(ids);
    expect(before.every((r) => r.scanState === 'PENDING' && r.scanLeaseOwner !== null)).toBe(true);

    const { exits, errors, tookMs, closeSeq } = await closeUnderDeadline(app);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The longer of the relay's grace and the worker's share of the budget,
    // side by side rather than one after the other.
    expect(tookMs).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000 - 100);
    expect(tookMs).toBeLessThan(GRACE_SECONDS * 1000 + 2000);
    // No claim once the close began, and no second scan.
    expect(claims.filter((c) => c.seq > closeSeq)).toEqual([]);
    expect(scanner.scans).toBe(1);

    // Both documents are back in the queue: still PENDING, no lease, no attempt
    // spent — the one whose scan was abandoned and the one never started.
    expect(await rows(ids)).toEqual(
      before.map((r) => ({ ...r, scanLeaseOwner: null, scanAttempts: r.scanAttempts })),
    );
  }, 60_000);

  it('a scan that ends inside the budget is recorded; the worker stops polling when the close begins', async () => {
    const ids = await twoQueuedDocuments();
    const scanner = new SlowScanner(1500);
    const { app, claims, publishes } = await boot(scanner);

    await until(() => scanner.scans === 1 && publishes.count === 1);
    expect(claims[0]?.ids).toEqual(ids);

    const { exits, errors, tookMs, closeSeq } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // Stopped at the start of the close, not after the relay's drain: nothing
    // claimed and nothing more scanned while the relay drained for 6 s.
    expect(claims.filter((c) => c.seq > closeSeq)).toEqual([]);
    expect(scanner.scans).toBe(1);

    // The first document's verdict was written; the second, never started, went
    // back to the queue untouched.
    const [first, second] = await rows(ids);
    expect(first).toMatchObject({ id: ids[0], scanState: 'CLEAN', scanLeaseOwner: null });
    expect(second).toMatchObject({ id: ids[1], scanState: 'PENDING', scanLeaseOwner: null });
  }, 60_000);
});
