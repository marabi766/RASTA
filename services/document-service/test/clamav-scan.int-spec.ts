import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { canDownload } from '../src/document/download-policy';
import { NoOpMalwareScanner } from '../src/scanning/stub.scanner';
import { ClamAvMalwareScanner } from '../src/scanning/clamav/clamav.scanner';
import { DOCUMENT_EVENTS } from '../src/events/events';
import { buildObjectKey } from '../src/storage/object-key';
import type { ClaimedDocument } from '../src/scanning/scan.repository';
import {
  FIXTURES,
  asActor,
  cleanup,
  clamdIsReachable,
  getFromSignedUrl,
  newPrisma,
  outboxFor,
  putToSignedUrl,
  realClamAvScanner,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';
import {
  EICAR_DOCX_CONTENT_TYPE,
  EICAR_SIGNATURE_PATTERN,
  eicarBytes,
  eicarInsideDocx,
} from './eicar';

/**
 * The scan lifecycle against a **real** ClamAV, a real PostgreSQL and a real
 * MinIO (ADR-049).
 *
 * Nothing about the security-relevant path is substituted. The bytes travel to
 * MinIO over a signed URL exactly as a browser would send them, the worker
 * streams them back out and through clamd's INSTREAM protocol, and the verdict
 * is written under the CHECK constraints the migration defines. A suite that
 * injected a fake `FOUND` reply would prove the mock; this proves the engine.
 *
 * The infected case uses EICAR, the standardised harmless test artefact —
 * assembled in memory from two base64 fragments and never written to the host
 * filesystem. See `eicar.ts` for why both of those matter.
 *
 * The worker is driven by `tick()` rather than by its poll timer. A running
 * timer would race every assertion about a PENDING document, and a test that
 * has to sleep to be right is one that is flaky on a slow runner.
 */

const SCANNER_REQUIRED_MESSAGE =
  'No clamd is reachable. These suites scan with a real engine; start it with ' +
  '`docker compose up -d clamav` (or set DOCUMENT_CLAMAV_SOCKET_PATH in CI).';

describe('malware scanning with a real ClamAV', () => {
  let prisma: PrismaService;
  /** The production composition: a real ClamAV behind the real port. */
  let wiring: Wiring;
  const org = tenants();

  /**
   * This run's lease identity, carried by every owner string the suite claims
   * under.
   *
   * The owner is the only fence the write-back paths have: `releaseIfHeld`,
   * `completeIfHeld` and `rescheduleIfHeld` all match on
   * `(id, scan_state = 'PENDING', scan_lease_owner = $owner)`. A fixed literal
   * such as `worker-holding-it` is therefore an identity two concurrent runs
   * share, and one run's cleanup would release the other run's lease — which
   * the other run observes as its own claim silently evaporating.
   */
  const runId = ulid().slice(-10);
  const owner = (role: string) => `itest-${role}-${runId}`;

  /**
   * An organization this suite never acts as.
   *
   * It stands in for somebody else's tenant in the dirty-queue controls below.
   * Run-tagged like the others so two runs cannot plant rows on each other,
   * and torn down with them.
   */
  const foreignOrg = `ORG-DOCTEST-FOREIGN-${runId}`;

  /** Every document this suite registered. `drain()` waits on these. */
  const ownDocuments = new Set<string>();

  beforeAll(async () => {
    // Checked once, loudly. Without it every assertion below fails with a
    // socket timeout that names the wrong component, and a reader would look
    // for a bug in the worker.
    if (!(await clamdIsReachable())) throw new Error(SCANNER_REQUIRED_MESSAGE);

    prisma = newPrisma();
    wiring = wire(prisma, { scanner: realClamAvScanner() });
  }, 120_000);

  afterAll(async () => {
    // Removes the EICAR object from the bucket along with everything else.
    await cleanup(prisma, [org.a, org.b, org.platform, foreignOrg], wiring.storage);
    await prisma.onModuleDestroy();
  });

  const asOrgA = <T>(fn: () => Promise<T>, roles = ['ORGANIZATION_ADMIN']) =>
    asActor({ organizationId: org.a, roles, userId: 'USR-SCAN-A' }, fn);

  const asOrgB = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.b, roles: ['ORGANIZATION_ADMIN'], userId: 'USR-SCAN-B' }, fn);

  /** Uploads bytes the way a browser does and registers the document. */
  async function upload(
    options: {
      bytes?: Buffer;
      contentType?: string;
      documentClass?: string;
      filename?: string;
      organizationId?: string;
      via?: Wiring;
    } = {},
  ) {
    const bytes = options.bytes ?? FIXTURES.pdf();
    const contentType = options.contentType ?? 'application/pdf';
    const documentClass = options.documentClass ?? 'CONTRACT';
    const act = options.organizationId === org.b ? asOrgB : asOrgA;
    const via = options.via ?? wiring;

    const intent = await act(() =>
      via.documents.requestUploadUrl({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        documentClass: documentClass as any,
        contentType,
        sizeBytes: bytes.length,
        filename: options.filename ?? 'contract.pdf',
      }),
    );

    expect(await putToSignedUrl(intent.uploadUrl, bytes, contentType)).toBe(200);

    const document = await act(() =>
      via.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
    );

    // Recorded here rather than at each call site, so `drain()` knows what
    // this suite is actually waiting for however the document was registered.
    ownDocuments.add(document.id);

    return { intent, document };
  }

  /**
   * Uploads an infected document — EICAR inside a DOCX.
   *
   * A DOCX rather than a PDF carrying the string, because ClamAV's
   * `Eicar-Test-Signature` matches the artefact as a whole file: a PDF that
   * merely contains those 68 bytes is correctly answered `OK`. A DOCX is a ZIP,
   * ClamAV unpacks it, and a member whose content is exactly EICAR is exactly
   * EICAR. See `eicar.ts`.
   */
  const uploadInfected = (via?: Wiring) =>
    upload({
      bytes: eicarInsideDocx(),
      contentType: EICAR_DOCX_CONTENT_TYPE,
      filename: 'statement-of-work.docx',
      ...(via ? { via } : {}),
    });

  /** The row as the database holds it, including the columns the view hides. */
  const row = (id: string) => wiring.repository.findById(id);

  /**
   * The outbox rows for one document.
   *
   * Matched on `aggregateId` rather than on a field inside the payload. An
   * outbox row's `payload` column holds the **envelope** — actor, event id and
   * the domain payload nested one level down — so `payload.documentId` is
   * undefined and a filter on it silently matches nothing, which reads as "no
   * events were published" rather than as a broken query.
   */
  const eventsFor = async (documentId: string) =>
    (await outboxFor(prisma, org.a)).filter((event) => event.aggregateId === documentId);

  /** The domain payload out of the envelope. */
  const bodyOf = (event?: { payload: unknown }) =>
    (event?.payload as { payload?: Record<string, unknown> } | undefined)?.payload;

  /**
   * Whether any document *this suite* registered is still claimable.
   *
   * The predicate is `ScanRepository.claim`'s, evaluated against the
   * database's `now()` rather than this process's clock, so the answer cannot
   * disagree with what the next claim will actually select.
   */
  async function ownWorkRemains(): Promise<boolean> {
    if (ownDocuments.size === 0) return false;

    const ids = [...ownDocuments];
    const rows = await runUnscoped(
      'the suite asks about its own rows across the tenants it created',
      () =>
        prisma.client.$queryRaw<{ claimable: number }[]>`
        SELECT count(*)::int AS claimable
          FROM "document"
         WHERE "id" = ANY(${ids}::text[])
           AND "scan_state" = 'PENDING'
           AND "status" = 'REGISTERED'
           AND ("scan_next_attempt_at" IS NULL OR "scan_next_attempt_at" <= now())
           AND ("scan_lease_expires_at" IS NULL OR "scan_lease_expires_at" <= now())
      `,
    );

    return (rows[0]?.claimable ?? 0) > 0;
  }

  /**
   * Runs the worker until the documents this suite registered have been dealt
   * with.
   *
   * One `tick()` claims at most `DOCUMENT_SCAN_BATCH_SIZE` documents, and this
   * suite deliberately leaves several parked in PENDING — an outage's backlog,
   * a document held under someone else's lease. A single tick would therefore
   * scan whichever five were oldest rather than the one the test just
   * uploaded, and the assertion would fail for a reason that has nothing to do
   * with what it is checking.
   *
   * The exit condition used to be `tick() === 0` alone. That is a statement
   * about the **whole** queue rather than about this suite: the scan queue is
   * global by design — `ScanRepository` claims unscoped, because a worker
   * scanning only its own organization's documents would scan nothing — so it
   * read as "no document belonging to anybody is claimable right now". Against
   * a database that also holds another suite's or another tenant's backlog
   * that is neither true nor this suite's business, and the loop spent its
   * budget on rows it does not own before reporting a scanner failure it never
   * observed. It now waits on this suite's own rows and keeps `tick() === 0`
   * only as the "nothing can progress" stop — so it returns no later than it
   * used to, under the same bound.
   *
   * Always at least one tick, so the callers that drain a queue their document
   * has already left — the idempotency test's three extra passes — still
   * exercise the worker instead of returning without having done anything.
   *
   * Bounded, because a worker that claims the same document forever is a bug
   * this should surface as a failure rather than as a hung suite.
   */
  async function drain(via: Wiring = wiring, maxTicks = 30): Promise<void> {
    for (let i = 0; i < maxTicks; i += 1) {
      const claimed = await via.worker.tick();
      if (!(await ownWorkRemains())) return;
      // Nothing anywhere is claimable, so another tick cannot move this on.
      if (claimed === 0) return;
    }
    throw new Error(`The scan queue did not drain in ${maxTicks} ticks`);
  }

  // =========================================================================
  // Claims made by hand
  // =========================================================================

  /**
   * A ledger of the claims a test made, and why every one of them goes
   * through it.
   *
   * `ScanRepository.claim` runs unscoped and selects across the whole
   * `document` table, oldest first. That is the production contract and the
   * worker depends on it — but it means a test calling it with `limit: 200`
   * against shared infrastructure leases **every** claimable document there
   * is, other suites' and other tenants' included, for `leaseSeconds`. A
   * leased document is unclaimable, so the suite that owns it watches its own
   * worker return 0 and reports that its document "never left PENDING": a
   * scanner failure that never happened, in a file that names no scanner.
   *
   * This file used to claim two batches of 200 rows on a 300-second lease and
   * give exactly one back. The ledger records what each claim actually
   * returned, before any assertion runs, and hands all of it back afterwards.
   * Two properties make that safe:
   *
   *   - **Token-fenced.** `releaseIfHeld(id, owner)` matches on this run's
   *     owner *and* on the row still being `PENDING`, so a row that was
   *     completed, rescheduled or reclaimed in between matches nothing and is
   *     left exactly as whoever owns it now left it.
   *   - **Complete.** A release that throws does not skip the ones after it;
   *     the failures are collected and reported once the rest are back.
   *
   * What no ledger can cover is a claim whose result never reached this
   * process — a crash between the `UPDATE` and its `RETURNING`. Nothing
   * outside the database can; that is what the lease expiry is for.
   */
  interface LeaseLedger {
    /** Claims under `itest-<role>-<runId>` and records every row returned. */
    claim(role: string, limit: number, leaseSeconds: number): Promise<ClaimedDocument[]>;
  }

  interface OwnedLeases extends LeaseLedger {
    /** Releases everything still held. Never throws; returns what failed. */
    release(): Promise<unknown[]>;
  }

  function newLeaseLedger(): OwnedLeases {
    const held = new Map<string, Set<string>>();

    return {
      async claim(role, limit, leaseSeconds) {
        const leaseOwner = owner(role);
        const batch = await wiring.scans.claim({ owner: leaseOwner, limit, leaseSeconds });

        const ids = held.get(leaseOwner) ?? new Set<string>();
        for (const document of batch) ids.add(document.id);
        held.set(leaseOwner, ids);

        return batch;
      },

      async release() {
        const failures: unknown[] = [];
        for (const [leaseOwner, ids] of held) {
          for (const id of ids) {
            try {
              await wiring.scans.releaseIfHeld(id, leaseOwner);
            } catch (error) {
              failures.push(error);
            }
          }
        }
        held.clear();
        return failures;
      },
    };
  }

  /**
   * Runs `body` with a ledger and gives back every lease it took.
   *
   * The release is in the `finally`, which is the whole point: the assertion
   * between the two claims is exactly where this file used to leave four
   * hundred documents parked, and a cleanup that only runs on the happy path
   * is not a cleanup.
   *
   * Nothing is thrown from inside that `finally`. A `finally` that throws
   * replaces the failure a reader needs to see with one about the cleanup, so
   * `release()` reports rather than raises and a release failure is turned
   * into an error only once the body itself has succeeded.
   */
  async function underLeases<T>(body: (leases: LeaseLedger) => Promise<T>): Promise<T> {
    const ledger = newLeaseLedger();
    let failures: unknown[] = [];
    let result: T;

    try {
      result = await body(ledger);
    } finally {
      failures = await ledger.release();
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} scan lease(s) could not be released: ` +
          failures.map((failure) => String(failure)).join('; '),
      );
    }

    return result;
  }

  /**
   * Registers documents under an organization this suite never acts as.
   *
   * Written straight to the table rather than uploaded: what the controls need
   * is a row in `PENDING` that a claim will pick up, and giving it real bytes
   * would add a MinIO round trip to a control that never runs the scanner.
   *
   * Queued an hour in the past so `claim`'s oldest-first ordering puts them at
   * the front of any batch. A control the fix could miss by landing outside
   * the limit would prove nothing, so both controls assert the claim took them.
   */
  async function seedForeignPending(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => `DOC_${ulid()}`);
    const queuedAt = new Date(Date.now() - 3_600_000);

    await runUnscoped('the control plants rows for a tenant this suite never acts as', () =>
      prisma.client.document.createMany({
        data: ids.map((id) => ({
          id,
          organizationId: foreignOrg,
          objectKey: buildObjectKey(foreignOrg, 'CONTRACT'),
          documentClass: 'CONTRACT' as const,
          contentType: 'application/pdf',
          sizeBytes: 1024,
          filename: 'someone-elses-contract.pdf',
          uploadIntentId: `UPI_${ulid()}`,
          createdBy: 'USR-DOCTEST-FOREIGN',
          createdAt: queuedAt,
          scanQueuedAt: queuedAt,
        })),
      }),
    );

    return ids;
  }

  /** A row this suite planted but does not own, as the database holds it. */
  const foreignRow = (id: string) =>
    runUnscoped('the control reads back the rows it planted', () =>
      prisma.client.document.findUnique({ where: { id } }),
    );

  /** Bounded by the ids the control created, never by organization or state. */
  const removeForeign = (ids: string[]) =>
    runUnscoped('the control removes the rows it planted', () =>
      prisma.client.document.deleteMany({ where: { id: { in: ids } } }),
    );

  // =========================================================================
  // 1. A clean file
  // =========================================================================

  describe('a file the engine finds nothing in', () => {
    it('is registered PENDING and is not downloadable before the worker runs', async () => {
      const { document } = await upload();

      // The ADR-049 consequence, asserted rather than described: registration
      // and clearance are separate moments, and nothing is downloadable in
      // between.
      expect(document.scanState).toBe('PENDING');
      expect(document.scanInspectedContent).toBe(false);
      expect(document.scanEngine).toBeNull();
      expect(
        canDownload({ id: document.id, status: 'REGISTERED', scanState: 'PENDING' }),
      ).toMatchObject({ allowed: false, reason: 'PENDING' });

      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow(
        /security scan/i,
      );
    });

    it('becomes CLEAN, attributed to the engine and database that cleared it', async () => {
      const { document } = await upload();

      await drain();

      const scanned = await row(document.id);
      expect(scanned?.scanState).toBe('CLEAN');
      expect(scanned?.scanEngine).toBe('clamav');
      // A real version from a real daemon, not a fixture.
      expect(scanned?.scanVersion).toMatch(/^\d+\.\d+/);
      expect(scanned?.scanSignatureVersion).toMatch(/^\d+$/);
      expect(scanned?.scannedAt).toBeInstanceOf(Date);
      expect(scanned?.scanSignature).toBeNull();
      expect(scanned?.scanFailureReason).toBeNull();
      expect(scanned?.quarantinedAt).toBeNull();
      // The claim is released, so nothing looks like work still in flight.
      expect(scanned?.scanLeaseOwner).toBeNull();
      expect(scanned?.scanLeaseExpiresAt).toBeNull();
    });

    it('can then receive a bounded signed URL that returns the exact bytes', async () => {
      const bytes = FIXTURES.pdf();
      const { document } = await upload({ bytes });
      await drain();

      const link = await asOrgA(() => wiring.documents.createDownloadUrl(document.id));

      // Bounded: the URL is a bearer credential for a private object, so its
      // lifetime is the only thing between a link and a permanent public read.
      expect(link.expiresInSeconds).toBe(wiring.env.DOCUMENT_SIGNED_URL_TTL_SECONDS);
      expect(link.expiresInSeconds).toBeLessThanOrEqual(3600);

      const fetched = await getFromSignedUrl(link.downloadUrl);
      expect(fetched.status).toBe(200);
      expect(fetched.body.equals(bytes)).toBe(true);
      // Never rendered: ADR-014 forbids serving stored content as HTML.
      expect(fetched.contentDisposition).toContain('attachment');
    });

    it('reports the scan as an inspection of content once it has one', async () => {
      const { document } = await upload();
      await drain();

      const view = await asOrgA(() => wiring.documents.get(document.id));

      expect(view.scanState).toBe('CLEAN');
      expect(view.scanInspectedContent).toBe(true);
      expect(view.scanEngine).toBe('clamav');
    });

    it('publishes DOCUMENT_SCANNED and no virus finding', async () => {
      const { document } = await upload();
      await drain();

      const events = await eventsFor(document.id);
      const names = events.map((event) => event.eventName);

      expect(names).toContain(DOCUMENT_EVENTS.DOCUMENT_UPLOADED);
      expect(names).toContain(DOCUMENT_EVENTS.DOCUMENT_SCANNED);
      expect(names).not.toContain(DOCUMENT_EVENTS.VIRUS_DETECTED);

      const outcome = events.find((e) => e.eventName === DOCUMENT_EVENTS.DOCUMENT_SCANNED);
      expect(bodyOf(outcome)).toMatchObject({ scanState: 'CLEAN', engine: 'clamav' });
    });
  });

  // =========================================================================
  // 2. EICAR
  // =========================================================================

  describe('the EICAR test artefact', () => {
    it('is detected by the engine, from bytes that reached storage over a signed URL', async () => {
      const { document } = await uploadInfected();

      expect(document.scanState).toBe('PENDING');
      await drain();

      const scanned = await row(document.id);
      expect(scanned?.scanState).toBe('INFECTED');
      expect(scanned?.scanEngine).toBe('clamav');
      // The real signature name a real engine reported, not a fixture.
      expect(scanned?.scanSignature).toMatch(EICAR_SIGNATURE_PATTERN);
    });

    it('is quarantined in the same write as the verdict, never after it', async () => {
      const { document } = await uploadInfected();
      await drain();

      const scanned = await row(document.id);

      // `ck_document_infected_is_quarantined` would refuse the row otherwise,
      // so this is a property of the database and not only of the worker.
      // There is no instant in which a document is known infected and
      // undecided about.
      expect(scanned?.quarantinedAt).toBeInstanceOf(Date);
      expect(scanned?.quarantineReason).toContain('permanently undownloadable');
    });

    it('stays non-downloadable, and is refused without revealing storage', async () => {
      const { document } = await uploadInfected();
      await drain();

      const refusal = await asOrgA(() => wiring.documents.createDownloadUrl(document.id)).catch(
        (error: Error) => error,
      );

      expect(refusal).toBeInstanceOf(Error);
      const text = JSON.stringify(refusal, Object.getOwnPropertyNames(refusal));
      expect(text).toMatch(/infected/i);
      // Not a byte of storage detail in the refusal (AGENTS.md S-09).
      expect(text).not.toContain('X-Amz-Signature');
      expect(text).not.toContain(wiring.env.S3_ACCESS_KEY);
      expect(text).not.toContain(wiring.env.S3_BUCKET_DOCUMENTS);
    });

    it('keeps the object as evidence rather than destroying it', async () => {
      const { document } = await uploadInfected();
      await drain();

      const scanned = await row(document.id);
      const object = await wiring.storage.head(scanned?.objectKey ?? '');

      // The documented quarantine policy (ADR-049): held, not deleted. Silently
      // destroying the one artefact an investigation would need is not a
      // security control, and deletion is an audited act by a person.
      expect(object).not.toBeNull();
      expect(scanned?.status).toBe('REGISTERED');
      expect(scanned?.deletedAt).toBeNull();
    });

    it('publishes VIRUS_DETECTED exactly once, carrying the signature and no bytes', async () => {
      const { document } = await uploadInfected();
      await drain();

      const events = (await eventsFor(document.id)).filter(
        (event) => event.eventName === DOCUMENT_EVENTS.VIRUS_DETECTED,
      );

      expect(events).toHaveLength(1);
      expect(bodyOf(events[0])).toMatchObject({ documentId: document.id, engine: 'clamav' });

      const payload = JSON.stringify(events[0]?.payload);
      expect(payload).toMatch(EICAR_SIGNATURE_PATTERN);
      // The event lives seven days in a log every service can read.
      expect(payload).not.toContain('X-Amz');
      expect(payload).not.toContain(wiring.env.S3_BUCKET_DOCUMENTS);
      expect(payload).not.toContain('objectKey');
    });

    it('never reaches the host filesystem, only the bucket and the container', () => {
      // A guard on the fixture rather than on behaviour. `eicar.ts` builds the
      // bytes in memory and there is no writeFile anywhere near them: on a
      // Windows developer machine writing this string to disk hands Defender a
      // file it is required to quarantine.
      const bytes = eicarBytes();

      expect(bytes).toHaveLength(68);
      expect(bytes.toString('latin1').startsWith('X5O!P%')).toBe(true);
    });
  });

  // =========================================================================
  // 3. Failure is never a pass
  // =========================================================================

  describe('when the scanner is unavailable', () => {
    /** The same domain, pointed at a port nothing answers on. */
    const outage = () =>
      wire(prisma, {
        scanner: new ClamAvMalwareScanner({
          address: { transport: 'tcp', host: '127.0.0.1', port: 1 },
          timeoutMs: 2_000,
          chunkBytes: 65_536,
          maxBytes: 32 * 1024 * 1024,
          signatureMaxAgeSeconds: 365 * 24 * 3600,
          versionCacheSeconds: 1,
        }),
      });

    it('leaves the document PENDING and undownloadable rather than clearing it', async () => {
      const down = outage();
      const { document } = await upload({ via: down });

      await drain(down);

      const scanned = await row(document.id);
      // Fail-closed, stated as the assertion: an outage makes documents
      // unavailable, never available.
      expect(scanned?.scanState).toBe('PENDING');
      expect(scanned?.scanAttempts).toBe(1);
      expect(scanned?.scanNextAttemptAt).toBeInstanceOf(Date);
      // No reason on a PENDING row — the column is constrained to FAILED, and
      // a reason there would read as a settled outcome.
      expect(scanned?.scanFailureReason).toBeNull();

      await expect(asOrgA(() => down.documents.createDownloadUrl(document.id))).rejects.toThrow();
    });

    it('reports itself through readiness and telemetry rather than silently', async () => {
      const health = await outage().scanner.health();

      expect(health.available).toBe(false);
      expect(health.signaturesFresh).toBe(false);
      expect(health.detail).toBe('CONNECTION_FAILED');
      // The detail reaches an unauthenticated probe.
      expect(health.detail).not.toContain('127.0.0.1');
    });

    it('gives up terminally once the retry budget is spent, still not clean', async () => {
      const env = testEnv({
        DOCUMENT_SCAN_MAX_ATTEMPTS: '2',
        DOCUMENT_SCAN_RETRY_BASE_MS: '100',
        DOCUMENT_CLAMAV_HOST: '127.0.0.1',
        DOCUMENT_CLAMAV_PORT: '1',
      });
      const down = wire(prisma, {
        env,
        scanner: new ClamAvMalwareScanner({
          address: { transport: 'tcp', host: '127.0.0.1', port: 1 },
          timeoutMs: 2_000,
          chunkBytes: 65_536,
          maxBytes: 32 * 1024 * 1024,
          signatureMaxAgeSeconds: 365 * 24 * 3600,
          versionCacheSeconds: 1,
        }),
      });

      const { document } = await upload({ via: down });

      await drain(down);
      // Clear the backoff so the second attempt is claimable now rather than
      // making the test wait for a timer.
      await prisma.client.$executeRaw`
        UPDATE "document" SET "scan_next_attempt_at" = now() - interval '1 minute'
         WHERE "id" = ${document.id}`;
      await drain(down);

      const scanned = await row(document.id);
      expect(scanned?.scanState).toBe('FAILED');
      expect(scanned?.scanFailureReason).toBe('CONNECTION_FAILED');
      expect(scanned?.scanAttempts).toBe(2);
      // Attributable even though no engine ever answered.
      expect(scanned?.scanEngine).toBe('clamav');
      // And still refused.
      expect(
        canDownload({ id: document.id, status: 'REGISTERED', scanState: 'FAILED' }),
      ).toMatchObject({ allowed: false, reason: 'FAILED' });
    });

    it('publishes the failure so a consumer is not left waiting forever', async () => {
      const env = testEnv({ DOCUMENT_SCAN_MAX_ATTEMPTS: '1' });
      const down = wire(prisma, {
        env,
        scanner: new ClamAvMalwareScanner({
          address: { transport: 'tcp', host: '127.0.0.1', port: 1 },
          timeoutMs: 2_000,
          chunkBytes: 65_536,
          maxBytes: 32 * 1024 * 1024,
          signatureMaxAgeSeconds: 365 * 24 * 3600,
          versionCacheSeconds: 1,
        }),
      });

      const { document } = await upload({ via: down });
      await drain(down);

      const outcome = (await eventsFor(document.id)).find(
        (event) => event.eventName === DOCUMENT_EVENTS.DOCUMENT_SCANNED,
      );

      expect(bodyOf(outcome)).toMatchObject({
        scanState: 'FAILED',
        failureReason: 'CONNECTION_FAILED',
      });
    });
  });

  describe('a scanner that inspects nothing', () => {
    it('cannot clear a document, even bound as the production scanner', async () => {
      const stubbed = wire(prisma, { scanner: new NoOpMalwareScanner() });
      const { document } = await upload({ via: stubbed });

      await drain(stubbed);

      const scanned = await row(document.id);
      // Recorded as a failure rather than as NOT_SCANNED. NOT_SCANNED is the
      // pre-ADR-049 historical record, and a row written today must not be
      // indistinguishable from one written while Q-18 was open.
      expect(scanned?.scanState).toBe('FAILED');
      expect(scanned?.scanFailureReason).toBe('SCANNER_DOES_NOT_INSPECT');
    });
  });

  // =========================================================================
  // 4. Idempotency and concurrency
  // =========================================================================

  describe('duplicate processing', () => {
    it('has one domain effect however many times the worker runs', async () => {
      const { document } = await uploadInfected();

      await drain();
      const afterFirst = await row(document.id);

      // Three more passes over a queue that no longer contains it.
      await drain();
      await drain();
      await drain();

      const afterMore = await row(document.id);
      expect(afterMore?.scanState).toBe(afterFirst?.scanState);
      expect(afterMore?.scannedAt).toEqual(afterFirst?.scannedAt);
      expect(afterMore?.scanAttempts).toBe(afterFirst?.scanAttempts);

      const events = await eventsFor(document.id);
      // One of each, not four.
      expect(events.filter((e) => e.eventName === DOCUMENT_EVENTS.DOCUMENT_SCANNED)).toHaveLength(
        1,
      );
      expect(events.filter((e) => e.eventName === DOCUMENT_EVENTS.VIRUS_DETECTED)).toHaveLength(1);
    });

    it('refuses a stale worker result rather than overwriting a fresh verdict', async () => {
      const { document } = await upload();
      await drain();

      const settled = await row(document.id);
      expect(settled?.scanState).toBe('CLEAN');

      // A worker that stalled past its lease, returning to write what it
      // found. The conditional update requires the row to still be PENDING and
      // the lease to still be its own; both are gone.
      const applied = await prisma.transaction((tx) =>
        wiring.scans.completeIfHeld(tx, {
          documentId: document.id,
          owner: 'a-worker-that-lost-its-lease',
          scanState: 'FAILED',
          engine: 'clamav',
          engineVersion: '1.5.4',
          signatureVersion: '1',
          signature: null,
          failureReason: 'TIMEOUT',
          quarantineReason: null,
          scannedAt: new Date(),
        }),
      );

      expect(applied).toBe(false);
      expect((await row(document.id))?.scanState).toBe('CLEAN');
    });
  });

  describe('two workers polling at once', () => {
    it('never scan the same document, so no verdict contradicts another', async () => {
      const uploads = await Promise.all([upload(), upload(), upload(), upload()]);
      const ids = uploads.map(({ document }) => document.id);

      // Two independent workers, each with its own lease identity, claiming
      // concurrently. `FOR UPDATE SKIP LOCKED` is what makes their batches
      // disjoint rather than serialised.
      const workerA = wire(prisma, { scanner: realClamAvScanner() }).worker;
      const workerB = wire(prisma, { scanner: realClamAvScanner() }).worker;
      await Promise.all([workerA.tick(), workerB.tick(), workerA.tick(), workerB.tick()]);

      for (const id of ids) {
        const scanned = await row(id);
        expect(scanned?.scanState).toBe('CLEAN');
        // Scanned once each. A document claimed twice would count two.
        expect(scanned?.scanAttempts).toBe(1);
        expect(scanned?.scanLeaseOwner).toBeNull();

        const outcomes = (await eventsFor(id)).filter(
          (event) => event.eventName === DOCUMENT_EVENTS.DOCUMENT_SCANNED,
        );
        expect(outcomes).toHaveLength(1);
      }
    }, 180_000);

    it('does not hand a leased document to a second worker', async () => {
      const { document } = await upload();

      await underLeases(async (leases) => {
        // A limit past anything this suite leaves parked, so the assertion is
        // about the lease rather than about which five rows were oldest. It is
        // also far past anything this suite *owns*, which is why both claims
        // go through the ledger: everything else the limit swallows belongs to
        // somebody, and the release below is what gives it back.
        const held = await leases.claim('holding-it', 200, 300);
        expect(held.map((d) => d.id)).toContain(document.id);

        const second = await leases.claim('arriving-second', 200, 300);
        expect(second.map((d) => d.id)).not.toContain(document.id);
      });

      // Back in the queue under nobody, so the suite's later assertions are
      // not blocked behind it — asserted rather than assumed, because the
      // release used to happen for this one row and no other.
      const released = await row(document.id);
      expect(released?.scanState).toBe('PENDING');
      expect(released?.scanLeaseOwner).toBeNull();
      expect(released?.scanLeaseExpiresAt).toBeNull();
    });

    it('scans on a tick even though it was never started', async () => {
      // A regression guard. The shutdown flag was initialised to `true`, so a
      // worker driven by `tick()` alone — an operator draining the queue by
      // hand during an incident, which this class documents as supported —
      // claimed a batch and released every document without scanning it. The
      // queue never moved and the claim/release churned indefinitely.
      const standalone = wire(prisma, { scanner: realClamAvScanner() });
      const { document } = await upload({ via: standalone });

      const claimed = await standalone.worker.tick();

      expect(claimed).toBeGreaterThan(0);
      expect((await row(document.id))?.scanState).toBe('CLEAN');
    });

    it('reclaims a document whose lease expired, so a dead worker cannot park it', async () => {
      const { document } = await upload();

      await underLeases(async (leases) => {
        const claimed = await leases.claim('that-died', 200, 300);
        expect(claimed.map((d) => d.id)).toContain(document.id);

        // Both lease columns, because `ck_document_scan_lease_complete` refuses a
        // half-written lease — an expiry with no owner never expires from
        // anybody's point of view.
        //
        // Bounded to the one row this test registered. Expiring leases by owner
        // or by state would expire whatever else the claim above swallowed.
        await prisma.client.$executeRaw`
          UPDATE "document"
             SET "scan_lease_owner" = ${owner('that-died')},
                 "scan_lease_expires_at" = now() - interval '1 minute'
           WHERE "id" = ${document.id}`;

        const reclaimed = await leases.claim('taking-over', 200, 300);
        expect(reclaimed.map((d) => d.id)).toContain(document.id);
      });

      // Both owners are in the ledger and both are tried; the fence is what
      // makes the stale one a no-op rather than a release of somebody's row.
      const released = await row(document.id);
      expect(released?.scanState).toBe('PENDING');
      expect(released?.scanLeaseOwner).toBeNull();
      expect(released?.scanLeaseExpiresAt).toBeNull();
    });
  });

  // =========================================================================
  // 4b. A queue that is not this suite's alone (N7)
  // =========================================================================

  /**
   * The dirty-queue control.
   *
   * `claim` is global by design, so the only thing between a wide claim made
   * here and another suite's documents parked for the length of a lease is
   * this file's cleanup. These two tests are what make that cleanup a tested
   * property rather than a convention: they plant `PENDING` documents under a
   * tenant this suite never acts as, run a claim wide enough to swallow them,
   * and require the rows to come back untouched *and* claimable — once on the
   * ordinary path, and once on a path where an assertion between the claim and
   * the release throws.
   *
   * Both fail if `underLeases` stops releasing, or releases only the row the
   * test named. Deliberately: a control that still passes with its guard
   * removed is not a control.
   *
   * No worker runs here. The rows are planted, claimed, released and removed
   * within the test, so nothing it does depends on timing and nothing it
   * leaves behind depends on a later suite.
   */
  describe('a wide claim over a queue that holds documents of other tenants', () => {
    it('leaves every foreign PENDING document unleased, unchanged and claimable', async () => {
      const foreign = await seedForeignPending(3);

      try {
        await underLeases(async (leases) => {
          const held = await leases.claim('wide-claim', 200, 300);
          // The control is only worth something if the claim genuinely took
          // them: one that missed them proves nothing about the release.
          expect(held.map((d) => d.id)).toEqual(expect.arrayContaining(foreign));
        });

        for (const id of foreign) {
          const after = await foreignRow(id);
          expect(after?.scanState).toBe('PENDING');
          expect(after?.status).toBe('REGISTERED');
          expect(after?.scanLeaseOwner).toBeNull();
          expect(after?.scanLeaseExpiresAt).toBeNull();
          // Unchanged, not merely unleased. A release that spent an attempt or
          // wrote a backoff would have moved a queue this suite does not own.
          expect(after?.scanAttempts).toBe(0);
          expect(after?.scanNextAttemptAt).toBeNull();
          expect(after?.scanEngine).toBeNull();
        }

        // Availability rather than column values: the worker that owns them can
        // take them again now, which is the property F-09 actually removed.
        await underLeases(async (leases) => {
          const claimable = await leases.claim('foreign-owner-probe', 200, 30);
          expect(claimable.map((d) => d.id)).toEqual(expect.arrayContaining(foreign));
        });
      } finally {
        await removeForeign(foreign);
      }
    });

    it('releases them even when an assertion between the claim and the release fails', async () => {
      const foreign = await seedForeignPending(3);
      const injected = new Error('an assertion failing where the release used to be skipped');

      try {
        let raised: unknown;
        try {
          await underLeases(async (leases) => {
            const held = await leases.claim('wide-claim-that-fails', 200, 300);
            expect(held.map((d) => d.id)).toEqual(expect.arrayContaining(foreign));
            throw injected;
          });
        } catch (error) {
          raised = error;
        }

        // Reported, not swallowed by its own cleanup: a `finally` that throws
        // would replace the failure a reader needs to see.
        expect(raised).toBe(injected);

        for (const id of foreign) {
          const after = await foreignRow(id);
          expect(after?.scanState).toBe('PENDING');
          expect(after?.status).toBe('REGISTERED');
          expect(after?.scanLeaseOwner).toBeNull();
          expect(after?.scanLeaseExpiresAt).toBeNull();
          expect(after?.scanAttempts).toBe(0);
        }
      } finally {
        await removeForeign(foreign);
      }
    });
  });

  // =========================================================================
  // 5. Tenant isolation and disclosure
  // =========================================================================

  describe('tenant isolation across the scan lifecycle', () => {
    it('does not let another organization read a document the scanner cleared', async () => {
      const { document } = await upload();
      await drain();

      // 404 rather than 403: a refusal would confirm the document exists and
      // that somebody else owns it, which for a document store is the leak.
      await expect(asOrgB(() => wiring.documents.get(document.id))).rejects.toThrow(/not found/i);
    });

    it('does not issue a download URL for a clean document to another organization', async () => {
      const { document } = await upload();
      await drain();

      await expect(asOrgB(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow(
        /not found/i,
      );
    });

    it('scans across tenants without letting either see the other', async () => {
      const a = await upload();
      const b = await upload({ organizationId: org.b });

      // One worker, both tenants. It has no request context and belongs to no
      // organization, which is the crossing `ScanRepository` names.
      await drain();

      expect((await row(a.document.id))?.scanState).toBe('CLEAN');
      expect((await row(b.document.id))?.scanState).toBe('CLEAN');

      const listed = await asOrgA(() =>
        wiring.documents.list({ limit: 100, includeDeleted: false }),
      );
      expect(listed.items.map((item) => item.id)).not.toContain(b.document.id);
    });
  });

  describe('what a pending or infected document reveals', () => {
    it('shows no object key, bucket, endpoint or credential in its metadata', async () => {
      const pending = await upload();
      const infected = await uploadInfected();
      await drain();

      for (const id of [pending.document.id, infected.document.id]) {
        const view = JSON.stringify(await asOrgA(() => wiring.documents.get(id)));

        expect(view).not.toContain(wiring.env.S3_ACCESS_KEY);
        expect(view).not.toContain(wiring.env.S3_SECRET_KEY);
        expect(view).not.toContain(wiring.env.S3_BUCKET_DOCUMENTS);
        expect(view).not.toContain(wiring.env.S3_ENDPOINT);
        expect(view).not.toContain('X-Amz');
        expect(view).not.toContain('objectKey');
      }
    });

    it('issues no signed URL at all when it refuses', async () => {
      const { document } = await uploadInfected();
      await drain();

      // Storage is never asked to sign anything for a refused state. Proven by
      // failing the call if it is: a URL that was created and then discarded is
      // still a credential that existed.
      const signing = jest.spyOn(wiring.storage, 'createDownloadUrl');
      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow();

      expect(signing).not.toHaveBeenCalled();
      signing.mockRestore();
    });
  });

  // =========================================================================
  // 6. Bounded streaming
  // =========================================================================

  describe('reading the object for a scan', () => {
    it('streams it rather than holding it, and stops at the ceiling', async () => {
      const { document } = await upload();
      const scanned = await row(document.id);

      const stream = await wiring.storage.openReadStream({
        objectKey: scanned?.objectKey ?? '',
        maxBytes: 4,
      });

      // The object is much longer than four bytes, so the read must fail
      // rather than hand back a prefix.
      //
      // This is the case that made the ranged read ask for `maxBytes + 1`. A
      // range of exactly `maxBytes` returns exactly `maxBytes` bytes of a
      // larger object, the counter never exceeds the limit, and the scanner
      // reads a truncated prefix and reports OK about a file it saw the start
      // of — recorded as CLEAN for content nothing examined.
      const consume = async () => {
        for await (const chunk of stream) void chunk;
      };
      await expect(consume()).rejects.toThrow(/ceiling/i);
    });

    it('returns an object that fits entirely, byte for byte', async () => {
      const bytes = FIXTURES.pdf();
      const { document } = await upload({ bytes });
      const scanned = await row(document.id);

      const stream = await wiring.storage.openReadStream({
        objectKey: scanned?.objectKey ?? '',
        maxBytes: bytes.length,
      });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);

      // Exactly at the ceiling is inside it. The extra byte the range asks for
      // does not exist, so nothing trips.
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    });

    it('refuses to scan an object larger than the configured limit', async () => {
      const { document } = await upload();
      const scanned = await row(document.id);

      const tiny = realClamAvScanner({ maxBytes: 2048 });
      const result = await tiny.scan({
        open: () =>
          wiring.storage.openReadStream({ objectKey: scanned?.objectKey ?? '', maxBytes: 2048 }),
        // Storage's number, deliberately larger than the ceiling.
        sizeBytes: 10_000,
        contentType: 'application/pdf',
      });

      expect(result.verdict).toBe('FAILED');
      expect(result.failureReason).toBe('SIZE_LIMIT_EXCEEDED');
      expect(result.retryable).toBe(false);
    });
  });

  // =========================================================================
  // 7. The engine itself
  // =========================================================================

  describe('the engine this deployment is running', () => {
    it('reports a version, a signature database and its age', async () => {
      const health = await wiring.scanner.health();

      expect(health.available).toBe(true);
      expect(health.engine).toBe('clamav');
      expect(health.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(health.signatureVersion).toMatch(/^\d+$/);
      expect(health.signatureAgeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('exposes nothing sensitive in doing so', () => {
      const health = JSON.stringify(wiring.scanner);

      expect(health).not.toContain(wiring.env.S3_SECRET_KEY);
      expect(health).not.toContain(wiring.env.DATABASE_URL);
    });
  });
});
