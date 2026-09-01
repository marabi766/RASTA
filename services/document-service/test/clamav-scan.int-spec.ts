import { PrismaService } from '../src/prisma/prisma.service';
import { canDownload } from '../src/document/download-policy';
import { NoOpMalwareScanner } from '../src/scanning/stub.scanner';
import { ClamAvMalwareScanner } from '../src/scanning/clamav/clamav.scanner';
import { DOCUMENT_EVENTS } from '../src/events/events';
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
    await cleanup(prisma, [org.a, org.b, org.platform], wiring.storage);
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
   * Runs the worker until it finds nothing left to claim.
   *
   * One `tick()` claims at most `DOCUMENT_SCAN_BATCH_SIZE` documents, and this
   * suite deliberately leaves several parked in PENDING — an outage's backlog,
   * a document held under someone else's lease. A single tick would therefore
   * scan whichever five were oldest rather than the one the test just
   * uploaded, and the assertion would fail for a reason that has nothing to do
   * with what it is checking.
   *
   * Bounded, because a worker that claims the same document forever is a bug
   * this should surface as a failure rather than as a hung suite.
   */
  async function drain(via: Wiring = wiring, maxTicks = 30): Promise<void> {
    for (let i = 0; i < maxTicks; i += 1) {
      if ((await via.worker.tick()) === 0) return;
    }
    throw new Error(`The scan queue did not drain in ${maxTicks} ticks`);
  }

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

      // A limit past anything this suite leaves parked, so the assertion is
      // about the lease rather than about which five rows were oldest.
      const held = await wiring.scans.claim({
        owner: 'worker-holding-it',
        limit: 200,
        leaseSeconds: 300,
      });
      expect(held.map((d) => d.id)).toContain(document.id);

      const second = await wiring.scans.claim({
        owner: 'worker-arriving-second',
        limit: 200,
        leaseSeconds: 300,
      });
      expect(second.map((d) => d.id)).not.toContain(document.id);

      // Released, so the suite's later assertions are not blocked behind it.
      await wiring.scans.releaseIfHeld(document.id, 'worker-holding-it');
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

      const claimed = await wiring.scans.claim({
        owner: 'worker-that-died',
        limit: 200,
        leaseSeconds: 300,
      });
      expect(claimed.map((d) => d.id)).toContain(document.id);

      // Both lease columns, because `ck_document_scan_lease_complete` refuses a
      // half-written lease — an expiry with no owner never expires from
      // anybody's point of view.
      await prisma.client.$executeRaw`
        UPDATE "document"
           SET "scan_lease_owner" = 'worker-that-died',
               "scan_lease_expires_at" = now() - interval '1 minute'
         WHERE "id" = ${document.id}`;

      const reclaimed = await wiring.scans.claim({
        owner: 'worker-taking-over',
        limit: 200,
        leaseSeconds: 300,
      });

      expect(reclaimed.map((d) => d.id)).toContain(document.id);
      await wiring.scans.releaseIfHeld(document.id, 'worker-taking-over');
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
