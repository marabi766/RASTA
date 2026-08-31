import { runUnscoped } from '@rasta/nest-common';
import {
  FIXTURES,
  asActor,
  cleanup,
  getFromSignedUrl,
  newPrisma,
  outboxFor,
  putToSignedUrl,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { MalwareScanner, ScanResult } from '../src/scanning/scanner.port';
import { AlwaysCleanScanner } from './clean-scanner';

/**
 * The direct-upload lifecycle, against a real PostgreSQL and a real MinIO.
 *
 * Every assertion here is about something that exists in one of those two
 * systems rather than in TypeScript: an object that is or is not in a bucket,
 * a signed URL that does or does not work, a CHECK constraint that refuses a
 * row. A mocked storage layer would prove none of it — and the whole point of
 * ADR-014 is what happens between the client, the bucket and this service.
 */
describe('document lifecycle (real database and object storage)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  /**
   * The same domain, wired to a scanner that reports `CLEAN`.
   *
   * `canDownload` allows `CLEAN` and nothing else, and the MVP stub records
   * `NOT_SCANNED`, so the successful-download path is unreachable through
   * `wiring`. Reaching it requires a scanner that inspected something — which
   * is what a real engine will be, and what `AlwaysCleanScanner` stands in for
   * until Q-18 is answered. Everything else here is the real thing.
   */
  let scanned: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    scanned = wire(prisma, { scanner: new AlwaysCleanScanner() });
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.platform], wiring.storage);
    await prisma.onModuleDestroy();
  });

  const asOrgA = <T>(fn: () => Promise<T>, roles = ['ORGANIZATION_ADMIN']) =>
    asActor({ organizationId: org.a, roles, userId: 'USR-DOC-A' }, fn);

  const asOrgB = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.b, roles: ['ORGANIZATION_ADMIN'], userId: 'USR-DOC-B' }, fn);

  /** Walks the whole flow and returns the registered document. */
  async function uploadDocument(
    options: {
      documentClass?: string;
      bytes?: Buffer;
      contentType?: string;
      filename?: string;
      organizationId?: string;
      /** Which wiring performs the upload. Defaults to the real MVP stub. */
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

    const status = await putToSignedUrl(intent.uploadUrl, bytes, contentType);
    expect(status).toBe(200);

    const document = await act(() =>
      via.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
    );

    return { intent, document };
  }

  // =========================================================================
  // The happy path, end to end
  // =========================================================================

  describe('the direct-upload flow', () => {
    it('issues a URL, accepts a real upload, and registers what was actually stored', async () => {
      const bytes = FIXTURES.pdf();
      const { document } = await uploadDocument({ bytes });

      expect(document.status).toBe('REGISTERED');
      // The size comes from storage metadata, not from what the client
      // declared — so it matches the object byte for byte.
      expect(document.sizeBytes).toBe(bytes.length);
      expect(document.contentType).toBe('application/pdf');
      expect(document.organizationId).toBe(org.a);
    });

    it('never returns the object key, the bucket or a URL in metadata', async () => {
      // A caller who could read the key could try to reach the object with
      // credentials obtained elsewhere, bypassing every authorization check.
      const { document } = await uploadDocument();
      const serialised = JSON.stringify(document);

      expect(serialised).not.toContain('documents/');
      expect(serialised).not.toContain('rasta-documents');
      expect(serialised).not.toMatch(/X-Amz-Signature|http:\/\/localhost:9000/);
    });

    it('reports honestly that nothing inspected the content', async () => {
      // Q-18: the MVP stub records `NOT_SCANNED`, and the view says plainly
      // that no engine looked — so an operator can see it from one document
      // without reading configuration.
      const { document } = await uploadDocument();

      expect(document.scanState).toBe('NOT_SCANNED');
      expect(document.scanInspectedContent).toBe(false);
      expect(document.scanEngine).toBe('no-op-stub');
    });

    it('hands back the exact bytes that were uploaded, once a scanner cleared them', async () => {
      // Through `scanned`, because only a `CLEAN` verdict authorizes a
      // download. With the MVP stub this document would be `NOT_SCANNED` and
      // this call would be refused — which is a separate test below.
      const bytes = FIXTURES.pdf();
      const { document } = await uploadDocument({ bytes, via: scanned });

      const link = await asOrgA(() => scanned.documents.createDownloadUrl(document.id));
      const fetched = await getFromSignedUrl(link.downloadUrl);

      expect(document.scanState).toBe('CLEAN');
      expect(fetched.status).toBe(200);
      expect(Buffer.compare(fetched.body, bytes)).toBe(0);
    });

    it('serves the download as an attachment, never as something a browser renders', async () => {
      // ADR-014: "فایل هرگز اجرا نمی‌شود و هرگز به‌عنوان HTML سرو نمی‌شود".
      // The response metadata is what enforces that at the storage boundary.
      const { document } = await uploadDocument({ via: scanned });
      const link = await asOrgA(() => scanned.documents.createDownloadUrl(document.id));
      const fetched = await getFromSignedUrl(link.downloadUrl);

      expect(fetched.contentDisposition).toMatch(/^attachment/);
      expect(fetched.contentType).toBe('application/pdf');
    });
  });

  // =========================================================================
  // Content validation against reality
  // =========================================================================

  describe('what the bytes actually are', () => {
    it('refuses an HTML page uploaded as a PDF', async () => {
      // The case neither the extension nor the declared header can catch, and
      // the reason ADR-014 asks for magic numbers. The client declares a PDF,
      // gets a URL bound to `application/pdf`, and uploads a script.
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: FIXTURES.html().length,
          filename: 'totally-a-contract.pdf',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, FIXTURES.html(), 'application/pdf');

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error,
      );

      // And nothing was registered.
      const rows = await runUnscoped('the suite counts documents after a refused finalize', () =>
        prisma.client.document.count({
          where: { organizationId: org.a, filename: 'totally-a-contract.pdf' },
        }),
      );
      expect(rows).toBe(0);
    });

    it('refuses an executable whatever it is called', async () => {
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'DAMAGE_PHOTO',
          contentType: 'image/png',
          sizeBytes: FIXTURES.executable().length,
          filename: 'photo.png',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, FIXTURES.executable(), 'image/png');

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow();
    });

    it('refuses a real file of the wrong type for its class', async () => {
      // A genuine PNG, uploaded under a class that accepts only PDFs and
      // spreadsheets. Nothing is malicious here — it is a filing rule — and it
      // is refused at finalize because the declaration passed and the bytes
      // did not.
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'STATEMENT',
          contentType: 'application/pdf',
          sizeBytes: FIXTURES.png().length,
          filename: 'statement.pdf',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, FIXTURES.png(), 'application/pdf');

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow();
    });

    it('refuses an empty object', async () => {
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: 10,
          filename: 'empty.pdf',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, Buffer.alloc(0), 'application/pdf');

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow();
    });

    it('refuses to finalize when nothing was uploaded at all', async () => {
      // The orphan case in reverse: a client that asked for a URL, never used
      // it, and claimed success anyway.
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: 100,
          filename: 'never-uploaded.pdf',
        }),
      );

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error,
      );
    });

    it('refuses a declared size the class does not permit, before issuing anything', async () => {
      await expect(
        asOrgA(() =>
          wiring.documents.requestUploadUrl({
            documentClass: 'OTHER',
            contentType: 'application/pdf',
            sizeBytes: 6 * 1024 * 1024,
            filename: 'huge.pdf',
          }),
        ),
      ).rejects.toThrow();

      // No intent row was created, so no credential exists for an upload that
      // could never have been accepted.
      const rows = await runUnscoped('the suite counts intents after a refused request', () =>
        prisma.client.uploadIntent.count({
          where: { organizationId: org.a, declaredFilename: 'huge.pdf' },
        }),
      );
      expect(rows).toBe(0);
    });
  });

  // =========================================================================
  // Upload intents: replay, expiry, substitution
  // =========================================================================

  describe('redeeming an upload intent', () => {
    it('returns the same document when finalize is repeated', async () => {
      // The client cannot tell a lost response from a request that never
      // arrived, and the honest answer to both is the same document
      // (AGENTS.md A-09).
      const { intent, document } = await uploadDocument();

      const replay = await asOrgA(() =>
        wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
      );

      expect(replay.id).toBe(document.id);

      const count = await runUnscoped('the suite counts documents for the replayed intent', () =>
        prisma.client.document.count({ where: { uploadIntentId: intent.uploadIntentId } }),
      );
      expect(count).toBe(1);
    });

    it('publishes the upload event exactly once across a replay', async () => {
      const { intent, document } = await uploadDocument();
      await asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId }));

      const events = await outboxFor(prisma, org.a);
      const uploads = events.filter(
        (row) => row.eventName === 'DOCUMENT_UPLOADED' && row.aggregateId === document.id,
      );
      expect(uploads).toHaveLength(1);
    });

    it('refuses an expired intent and records the expiry', async () => {
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: FIXTURES.pdf().length,
          filename: 'late.pdf',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, FIXTURES.pdf(), 'application/pdf');

      // Ages the intent past its window. Both timestamps move because
      // `ck_upload_intent_expiry` refuses a row that expired before it was
      // created — correctly, since no such row could ever have been written.
      await runUnscoped('the suite ages the intent past its TTL', () =>
        prisma.client.uploadIntent.updateMany({
          where: { id: intent.uploadIntentId },
          data: {
            createdAt: new Date(Date.now() - 7_200_000),
            expiresAt: new Date(Date.now() - 60_000),
          },
        }),
      );

      await expect(
        asOrgA(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error,
      );

      const row = await runUnscoped('the suite reads the expired intent', () =>
        prisma.client.uploadIntent.findUniqueOrThrow({ where: { id: intent.uploadIntentId } }),
      );
      expect(row.state).toBe('EXPIRED');
    });

    it('cannot be redeemed by another organization', async () => {
      // Reported as not found rather than forbidden: a stranger must not learn
      // that the intent exists.
      const intent = await asOrgA(() =>
        wiring.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: FIXTURES.pdf().length,
          filename: 'a-contract.pdf',
        }),
      );

      await putToSignedUrl(intent.uploadUrl, FIXTURES.pdf(), 'application/pdf');

      await expect(
        asOrgB(() => wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId })),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error);

      // And the intent is still redeemable by its owner — the refusal did not
      // consume it.
      const document = await asOrgA(() =>
        wiring.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
      );
      expect(document.organizationId).toBe(org.a);
    });

    it('writes an object key the client never chose', async () => {
      // The path-traversal defence, checked against the row rather than the
      // function: whatever the filename, the key is server-shaped.
      const { intent } = await uploadDocument({
        filename: '../../../etc/passwd',
      });

      const row = await runUnscoped('the suite reads the key that was stored', () =>
        prisma.client.uploadIntent.findUniqueOrThrow({ where: { id: intent.uploadIntentId } }),
      );

      expect(row.objectKey).toMatch(
        new RegExp(`^documents/${org.a}/CONTRACT/[0-9A-HJKMNP-TV-Z]{26}$`),
      );
      expect(row.objectKey).not.toContain('..');
      expect(row.objectKey).not.toContain('passwd');
      // The name survives only as display metadata, sanitised.
      expect(row.declaredFilename).toBe('passwd');
    });
  });

  // =========================================================================
  // Tenant isolation
  // =========================================================================

  describe('tenant isolation', () => {
    it('does not let another organization read the metadata', async () => {
      const { document } = await uploadDocument();

      await expect(asOrgB(() => wiring.documents.get(document.id))).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error,
      );
    });

    it('does not disclose the owner in the refusal', async () => {
      // A 404 that named the owning organization would leak exactly what the
      // 404 exists to hide.
      const { document } = await uploadDocument();

      const error = await asOrgB(() => wiring.documents.get(document.id)).catch(
        (caught: unknown) => caught,
      );
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));

      expect(serialised).not.toContain(org.a);
    });

    it('does not let another organization obtain a download URL', async () => {
      const { document } = await uploadDocument();

      await expect(asOrgB(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error,
      );
    });

    it('does not let another organization delete it', async () => {
      const { document } = await uploadDocument();

      await expect(
        asOrgB(() => wiring.documents.remove(document.id, { reason: 'not mine to delete' })),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error);

      const row = await runUnscoped('the suite confirms the document survived', () =>
        prisma.client.document.findUniqueOrThrow({ where: { id: document.id } }),
      );
      expect(row.status).toBe('REGISTERED');
    });

    it('lists only the caller organization documents', async () => {
      await uploadDocument();
      await uploadDocument({ organizationId: org.b, filename: 'b-contract.pdf' });

      const listed = await asOrgB(() =>
        wiring.documents.list({ includeDeleted: false, limit: 50 }),
      );

      expect(listed.items.length).toBeGreaterThan(0);
      for (const item of listed.items) {
        expect(item.organizationId).toBe(org.b);
      }
    });

    it('refuses the oversight role outright', async () => {
      // `docs/09` § 9.3: the province role has aggregate access only. An
      // auditor who could read documents could read every contract on the
      // platform.
      const { document } = await uploadDocument();

      await expect(
        asActor({ organizationId: org.a, roles: ['AUDITOR'] }, () =>
          wiring.documents.get(document.id),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }) as unknown as Error);
    });

    it('does not give a service caller platform scope', async () => {
      // ADR-035: a service token is exempt from the role check and from
      // nothing else. A compromised one must not become a platform-wide
      // document reader.
      const { document } = await uploadDocument();

      await expect(
        asActor(
          {
            organizationId: org.b,
            authType: 'SERVICE',
            callerService: 'asset-service',
            roles: ['SERVICE'],
          },
          () => wiring.documents.get(document.id),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error);
    });
  });

  // =========================================================================
  // Download refusals
  // =========================================================================

  describe('when a download is refused', () => {
    it('refuses while the scan is pending, and issues no URL at all', async () => {
      const { document } = await uploadDocument();

      await runUnscoped('the suite puts the document back into a pending scan', () =>
        prisma.client.document.updateMany({
          where: { id: document.id },
          data: { scanState: 'PENDING', scanEngine: null, scannedAt: null },
        }),
      );

      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error,
      );
    });

    it('refuses an infected document', async () => {
      const { document } = await uploadDocument();

      await runUnscoped('the suite marks the document infected', () =>
        prisma.client.document.updateMany({
          where: { id: document.id },
          data: {
            scanState: 'INFECTED',
            scanEngine: 'test-engine',
            scanSignature: 'EICAR-Test-File',
            scannedAt: new Date(),
          },
        }),
      );

      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow();
    });

    it('refuses a deleted document as absent', async () => {
      const { document } = await uploadDocument();
      await asOrgA(() =>
        wiring.documents.remove(document.id, { reason: 'superseded by a newer revision' }),
      );

      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }) as unknown as Error,
      );
    });

    it('refuses a document nothing inspected — which is every document in MVP', async () => {
      // The invariant this suite exists to hold. The MVP stub records
      // `NOT_SCANNED`, ADR-014 keeps a file unavailable until scanning has
      // completed, and there is no configuration that changes the answer:
      // `canDownload` takes no policy argument and `DocumentEnv` carries no
      // flag. Uploading and registering worked; handing the bytes back does
      // not, and will not until Q-18 is answered with a real engine.
      const { document } = await uploadDocument();
      expect(document.scanState).toBe('NOT_SCANNED');

      const error = await asOrgA(() => wiring.documents.createDownloadUrl(document.id)).catch(
        (caught: unknown) => caught as { code?: string; internalContext?: { reason?: string } },
      );

      expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
      // The reason reaches the log, never the response body.
      expect(error.internalContext?.reason).toBe('NOT_SCANNED');
    });

    it('issues no signed URL at all when it refuses', async () => {
      // The refusal has to happen *before* signing. A URL that was minted and
      // then discarded is still a bearer credential that existed, and the
      // storage layer would have been asked to create one.
      const { document } = await uploadDocument();
      const spy = jest.spyOn(wiring.storage, 'createDownloadUrl');

      await expect(asOrgA(() => wiring.documents.createDownloadUrl(document.id))).rejects.toThrow();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // =========================================================================
  // Deletion
  // =========================================================================

  describe('deleting a document', () => {
    it('records who, when and why rather than erasing the row', async () => {
      const { document } = await uploadDocument();

      const deleted = await asOrgA(() =>
        wiring.documents.remove(document.id, { reason: 'replaced by the countersigned copy' }),
      );

      expect(deleted.status).toBe('DELETED');
      expect(deleted.deletionReason).toBe('replaced by the countersigned copy');
      expect(deleted.deletedAt).toBeTruthy();

      // The row is still there — the audit question has an answer.
      const row = await runUnscoped('the suite reads the tombstone', () =>
        prisma.client.document.findUniqueOrThrow({ where: { id: document.id } }),
      );
      expect(row.deletedBy).toBe('USR-DOC-A');
    });

    it('removes the object from storage', async () => {
      const { intent } = await uploadDocument();
      const row = await runUnscoped('the suite reads the key before deletion', () =>
        prisma.client.uploadIntent.findUniqueOrThrow({ where: { id: intent.uploadIntentId } }),
      );

      const document = await runUnscoped('the suite finds the document', () =>
        prisma.client.document.findFirstOrThrow({
          where: { uploadIntentId: intent.uploadIntentId },
        }),
      );

      await asOrgA(() => wiring.documents.remove(document.id, { reason: 'no longer required' }));

      expect(await wiring.storage.head(row.objectKey)).toBeNull();
    });

    it('is idempotent, and does not overwrite the original actor or reason', async () => {
      const { document } = await uploadDocument();

      const first = await asOrgA(() =>
        wiring.documents.remove(document.id, { reason: 'the original stated reason' }),
      );
      const second = await asActor(
        { organizationId: org.a, roles: ['ORGANIZATION_ADMIN'], userId: 'USR-DOC-OTHER' },
        () => wiring.documents.remove(document.id, { reason: 'a different later reason' }),
      );

      // The tombstone is the first one. A second deletion must not rewrite who
      // deleted it or why — that would destroy the audit evidence it exists to
      // preserve.
      expect(second.deletedAt).toBe(first.deletedAt);
      expect(second.deletionReason).toBe('the original stated reason');
    });

    it('publishes exactly one deletion event across repeated calls', async () => {
      const { document } = await uploadDocument();

      await asOrgA(() =>
        wiring.documents.remove(document.id, { reason: 'first and only deletion' }),
      );
      await asOrgA(() => wiring.documents.remove(document.id, { reason: 'a repeated call' }));

      const events = await outboxFor(prisma, org.a);
      const deletions = events.filter(
        (row) => row.eventName === 'DOCUMENT_DELETED' && row.aggregateId === document.id,
      );
      expect(deletions).toHaveLength(1);
    });

    it('excludes a deleted document from the default listing', async () => {
      const { document } = await uploadDocument({ filename: 'to-be-deleted.pdf' });
      await asOrgA(() => wiring.documents.remove(document.id, { reason: 'removed for this test' }));

      const visible = await asOrgA(() =>
        wiring.documents.list({ includeDeleted: false, limit: 100 }),
      );
      expect(visible.items.map((item) => item.id)).not.toContain(document.id);

      const all = await asOrgA(() => wiring.documents.list({ includeDeleted: true, limit: 100 }));
      expect(all.items.map((item) => item.id)).toContain(document.id);
    });
  });

  // =========================================================================
  // Events
  // =========================================================================

  describe('the events this service publishes', () => {
    it('carries no object key, signed URL or content in the payload', async () => {
      // An event lives seven days in a log every service can read. A signed URL
      // there would be a bearer credential for a private object with a
      // week-long audience.
      const { document } = await uploadDocument();
      const events = await outboxFor(prisma, org.a);
      const uploaded = events.find(
        (row) => row.eventName === 'DOCUMENT_UPLOADED' && row.aggregateId === document.id,
      );

      const serialised = JSON.stringify(uploaded?.payload);
      expect(serialised).not.toContain('documents/');
      expect(serialised).not.toContain('X-Amz-Signature');
      expect(serialised).not.toContain('rasta-documents');
    });

    it('states the scan state, so nobody reads the event as a clean bill of health', async () => {
      const { document } = await uploadDocument();
      const events = await outboxFor(prisma, org.a);
      const uploaded = events.find(
        (row) => row.eventName === 'DOCUMENT_UPLOADED' && row.aggregateId === document.id,
      );

      const payload = (uploaded?.payload as { payload: Record<string, unknown> }).payload;
      expect(payload.scanState).toBe('NOT_SCANNED');
    });

    it('keys every event by the document, so its history stays in order', async () => {
      const { document } = await uploadDocument();
      await asOrgA(() =>
        wiring.documents.remove(document.id, { reason: 'ordering check for events' }),
      );

      const events = (await outboxFor(prisma, org.a)).filter(
        (row) => row.aggregateId === document.id,
      );

      expect(events.length).toBe(2);
      for (const row of events) {
        expect(row.partitionKey).toBe(document.id);
        expect(row.topic).toBe('rasta.document.v1');
      }
    });

    it('never publishes VIRUS_DETECTED from a scanner that inspects nothing', async () => {
      // The rule that keeps a fabricated security finding out of the log. Even
      // if a stub somehow returned INFECTED, `inspectsContent` gates the event.
      const lyingStub: MalwareScanner = {
        inspectsContent: false,
        name: 'no-op-stub',
        async scan(): Promise<ScanResult> {
          return {
            verdict: 'INFECTED',
            engine: 'no-op-stub',
            engineVersion: null,
            signature: 'FABRICATED',
            scannedAt: new Date(),
          };
        },
      };

      const withLyingStub = wire(prisma, { scanner: lyingStub });
      const bytes = FIXTURES.pdf();

      const intent = await asOrgA(() =>
        withLyingStub.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'scanner-honesty.pdf',
        }),
      );
      await putToSignedUrl(intent.uploadUrl, bytes, 'application/pdf');
      const document = await asOrgA(() =>
        withLyingStub.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
      );

      const events = await outboxFor(prisma, org.a);
      const virusEvents = events.filter(
        (row) => row.eventName === 'VIRUS_DETECTED' && row.aggregateId === document.id,
      );
      expect(virusEvents).toHaveLength(0);
    });

    it('publishes VIRUS_DETECTED when an engine that really inspected content finds one', async () => {
      // The other half: the guard must not be so strict that a real finding is
      // swallowed.
      const realEngine: MalwareScanner = {
        inspectsContent: true,
        name: 'test-engine',
        async scan(): Promise<ScanResult> {
          return {
            verdict: 'INFECTED',
            engine: 'test-engine',
            engineVersion: '1.2.3',
            signature: 'EICAR-Test-Signature',
            scannedAt: new Date(),
          };
        },
      };

      const withEngine = wire(prisma, { scanner: realEngine });
      const bytes = FIXTURES.pdf();

      const intent = await asOrgA(() =>
        withEngine.documents.requestUploadUrl({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'infected.pdf',
        }),
      );
      await putToSignedUrl(intent.uploadUrl, bytes, 'application/pdf');
      const document = await asOrgA(() =>
        withEngine.documents.finalize({ uploadIntentId: intent.uploadIntentId }),
      );

      const events = await outboxFor(prisma, org.a);
      const virusEvent = events.find(
        (row) => row.eventName === 'VIRUS_DETECTED' && row.aggregateId === document.id,
      );

      expect(virusEvent).toBeDefined();
      const payload = (virusEvent?.payload as { payload: Record<string, unknown> }).payload;
      expect(payload.signature).toBe('EICAR-Test-Signature');
      expect(payload.engine).toBe('test-engine');

      // And it is not downloadable.
      await expect(
        asOrgA(() => withEngine.documents.createDownloadUrl(document.id)),
      ).rejects.toThrow();
    });
  });
});
