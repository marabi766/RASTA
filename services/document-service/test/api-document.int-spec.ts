import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiTenant,
  auditor,
  driver,
  internalToken,
  orgAdmin,
  platformAdmin,
  scannerOf,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { AlwaysCleanScanner } from './clean-scanner';
import { FIXTURES, cleanup, getFromSignedUrl, newStorage, putToSignedUrl, testEnv } from './helpers';

/**
 * The document HTTP surface, over the real application.
 *
 * Two applications are booted, and the difference between them is the point of
 * the file.
 *
 * `mvp` is what a deployment gets today: `AppModule` untouched, binding the
 * real `NoOpMalwareScanner`. Everything it registers is `NOT_SCANNED`, and
 * every download request against it is refused — that is the production
 * behaviour, asserted through HTTP rather than described in a comment.
 *
 * `scanned` replaces exactly one provider, `MALWARE_SCANNER`, with a test-only
 * fake that reports `CLEAN`. That is the only way to reach the download path
 * at all, because `canDownload` allows `CLEAN` and nothing else. Without it
 * the signed GET URL, the attachment disposition and the byte round trip would
 * be untested code — the thing the correction must not cost us.
 *
 * Both talk to a real PostgreSQL and a real MinIO.
 */
describe('the document API (real application, real database, real object storage)', () => {
  let mvp: ApiHarness;
  let scanned: ApiHarness;

  const org = apiTenant('A');
  const other = apiTenant('B');
  const storage = newStorage(testEnv());

  beforeAll(async () => {
    mvp = await startApi();
    // One provider replaced, through the port a real engine will use.
    scanned = await startApi({ scanner: new AlwaysCleanScanner() });
  });

  afterAll(async () => {
    await cleanup(mvp.prisma, [org, other], storage);
    await scanned.close();
    await mvp.close();
  });

  const http = (harness: ApiHarness) => request(harness.app.getHttpServer());

  /**
   * The whole direct-upload flow over HTTP: intent, PUT to the signed URL,
   * then registration. No shortcut through the domain — a client could perform
   * every one of these calls.
   */
  async function upload(
    harness: ApiHarness,
    options: {
      token?: string;
      organizationId?: string;
      documentClass?: string;
      contentType?: string;
      bytes?: Buffer;
      filename?: string;
      ownerResourceType?: string;
      ownerResourceId?: string;
    } = {},
  ) {
    const organizationId = options.organizationId ?? org;
    const token = options.token ?? orgAdmin(organizationId);
    const bytes = options.bytes ?? FIXTURES.pdf();
    const contentType = options.contentType ?? 'application/pdf';

    const intent = await http(harness)
      .post('/v1/documents/upload-url')
      .set('authorization', `Bearer ${token}`)
      .send({
        documentClass: options.documentClass ?? 'CONTRACT',
        contentType,
        sizeBytes: bytes.length,
        filename: options.filename ?? 'contract.pdf',
      })
      .expect(201);

    expect(await putToSignedUrl(intent.body.uploadUrl, bytes, contentType)).toBe(200);

    const registered = await http(harness)
      .post('/v1/documents')
      .set('authorization', `Bearer ${token}`)
      .send({
        uploadIntentId: intent.body.uploadIntentId,
        ...(options.ownerResourceType ? { ownerResourceType: options.ownerResourceType } : {}),
        ...(options.ownerResourceId ? { ownerResourceId: options.ownerResourceId } : {}),
      })
      .expect(201);

    return { intent: intent.body, document: registered.body, token, bytes };
  }

  // =========================================================================
  // What the running MVP actually does
  // =========================================================================

  describe('the application a deployment gets today', () => {
    it('composes the honest stub, which inspects nothing', () => {
      // Read off the booted graph rather than assumed. This is the assertion
      // that would fail if somebody bound a scanner that claims to inspect.
      const scanner = scannerOf(mvp);
      expect(scanner.name).toBe('no-op-stub');
      expect(scanner.inspectsContent).toBe(false);
    });

    it('accepts an upload and registers the metadata', async () => {
      // The half of the capability that works in MVP, stated as a passing
      // test so the limitation below cannot be read as "documents are broken".
      const { document, bytes } = await upload(mvp);

      expect(document.status).toBe('REGISTERED');
      expect(document.contentType).toBe('application/pdf');
      // From storage metadata, not from what the client declared.
      expect(document.sizeBytes).toBe(bytes.length);
      expect(document.organizationId).toBe(org);
    });

    it('says plainly that nothing examined the content', async () => {
      const { document } = await upload(mvp);

      expect(document.scanState).toBe('NOT_SCANNED');
      expect(document.scanInspectedContent).toBe(false);
      expect(document.scanEngine).toBe('no-op-stub');
    });

    it('refuses the download, because no scan cleared it', async () => {
      // The invariant, proven through the real application rather than
      // against the pure function alone: ADR-014 keeps a file unavailable
      // until scanning has completed, `NOT_SCANNED` means none did, and there
      // is no configuration in this service that changes the answer.
      const { document, token } = await upload(mvp);

      const refusal = await http(mvp)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${token}`)
        .expect(422);

      expect(refusal.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refusal.body.message).toMatch(/has not been scanned/i);
      expect(refusal.body).not.toHaveProperty('downloadUrl');
    });

    it('leaks nothing about storage in the refusal', async () => {
      const { document, token } = await upload(mvp);

      // The real key, read from the row. Asserting against a literal prefix
      // would be worthless here: the request path itself contains
      // `/v1/documents/`, so a substring check on that would pass for the
      // wrong reason. What must never appear is the key that names the object.
      const row = await runUnscoped('the suite reads the object key', () =>
        mvp.prisma.client.document.findUniqueOrThrow({ where: { id: document.id } }),
      );

      const refusal = await http(mvp)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${token}`)
        .expect(422);

      const body = JSON.stringify(refusal.body);
      expect(body).not.toContain(row.objectKey);
      expect(body).not.toContain('rasta-documents');
      expect(body).not.toMatch(/X-Amz-Signature|localhost:9000/);
    });

    it('still lists and reads the document it will not hand over', async () => {
      // The refusal is about the bytes, not about the record. A caller can see
      // that the document exists, what it is and why it is unavailable.
      const { document, token } = await upload(mvp);

      const read = await http(mvp)
        .get(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      expect(read.body.id).toBe(document.id);
      expect(read.body.scanState).toBe('NOT_SCANNED');
    });
  });

  // =========================================================================
  // The download path, reachable only behind a scanner that cleared the file
  // =========================================================================

  describe('when a scanner has cleared the document', () => {
    it('issues a signed URL that returns the exact bytes', async () => {
      const { document, token, bytes } = await upload(scanned);
      expect(document.scanState).toBe('CLEAN');

      const link = await http(scanned)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      expect(link.body.expiresInSeconds).toBe(300);
      const fetched = await getFromSignedUrl(link.body.downloadUrl);

      expect(fetched.status).toBe(200);
      expect(Buffer.compare(fetched.body, bytes)).toBe(0);
    });

    it('serves it as an attachment, never as something a browser renders', async () => {
      // ADR-014: «فایل هرگز اجرا نمی‌شود و هرگز به‌عنوان HTML سرو نمی‌شود».
      const { document, token } = await upload(scanned);

      const link = await http(scanned)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      const fetched = await getFromSignedUrl(link.body.downloadUrl);

      expect(fetched.contentDisposition).toMatch(/^attachment/);
      expect(fetched.contentType).toBe('application/pdf');
    });

    it('reports that an engine did inspect it', async () => {
      const { document } = await upload(scanned);

      expect(document.scanInspectedContent).toBe(true);
      expect(document.scanEngine).toBe('test-only-clean-scanner');
    });

    it('refuses once the document is deleted, and calls it absent', async () => {
      const { document, token } = await upload(scanned);

      await http(scanned)
        .delete(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({ reason: 'withdrawn before countersignature' })
        .expect(200);

      // 404 rather than 422: a refusal would confirm the document existed.
      await http(scanned)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // =========================================================================
  // Metadata never carries the things that would bypass every check
  // =========================================================================

  describe('what the API returns', () => {
    it('never returns the object key, the bucket or a URL', async () => {
      const { document } = await upload(mvp);
      const serialised = JSON.stringify(document);

      expect(serialised).not.toContain('documents/');
      expect(serialised).not.toContain('rasta-documents');
      expect(serialised).not.toMatch(/X-Amz-Signature|localhost:9000/);
    });

    it('returns 404 for a document that does not exist', async () => {
      await http(mvp)
        .get('/v1/documents/DOC_00000000000000000000000000')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .expect(404);
    });

    it('honours includeDeleted=false as written', async () => {
      // Over a real query string, which is where the coercion defect lived:
      // `Boolean('false')` is `true`, so this used to return the tombstone the
      // caller asked to exclude.
      const { document, token } = await upload(mvp, { filename: 'to-delete.pdf' });
      await http(mvp)
        .delete(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({ reason: 'removed for the listing test' })
        .expect(200);

      const excluded = await http(mvp)
        .get('/v1/documents?includeDeleted=false&limit=100')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(excluded.body.items.map((item: { id: string }) => item.id)).not.toContain(document.id);

      const included = await http(mvp)
        .get('/v1/documents?includeDeleted=true&limit=100')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(included.body.items.map((item: { id: string }) => item.id)).toContain(document.id);
    });
  });

  // =========================================================================
  // Authentication and authorization at the edge
  // =========================================================================

  describe('who may reach these endpoints', () => {
    it('refuses an unauthenticated caller', async () => {
      // S-02: every endpoint closed by default. No `@Public` on any of these.
      await http(mvp).get('/v1/documents').expect(401);
      await http(mvp).post('/v1/documents/upload-url').send({}).expect(401);
    });

    it('refuses a token this application cannot verify', async () => {
      await http(mvp)
        .get('/v1/documents')
        .set('authorization', 'Bearer not-a-token-this-harness-minted')
        .expect(401);
    });

    it('refuses the oversight role outright', async () => {
      // `docs/09` § 9.3: province oversight is aggregate-only. An auditor who
      // could read documents could read every contract on the platform.
      await http(mvp)
        .get('/v1/documents')
        .set('authorization', `Bearer ${auditor(org)}`)
        .expect(403);
    });

    it('refuses a role with no business handling documents', async () => {
      await http(mvp)
        .post('/v1/documents/upload-url')
        .set('authorization', `Bearer ${driver(org)}`)
        .send({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          filename: 'contract.pdf',
        })
        .expect(403);
    });

    it('lets a platform operator read across tenants', async () => {
      const { document } = await upload(mvp);

      await http(mvp)
        .get(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${platformAdmin()}`)
        .expect(200);
    });

    it('is not callable by another service at all, valid token or not', async () => {
      // ADR-020, Zero Trust: a valid internal token proves *which* service is
      // calling and grants nothing by itself. No endpoint on this controller
      // carries `@AllowService`, so every service-to-service call is refused.
      //
      // That is the correct default and also a real gap: asset-service,
      // contract-service and construction-service all store document ids and
      // will eventually need to read the metadata behind them. Opening that
      // means adding a deliberate `@AllowService` allowlist per endpoint, with
      // its own tests — not widening anything here. Recorded in
      // `PROJECT_MEMORY.md` under known issues.
      const { document } = await upload(mvp);
      const token = await internalToken('asset-service', { organizationId: other });

      await http(mvp)
        .get(`/v1/documents/${document.id}`)
        .set('x-internal-token', token)
        .expect(403);
    });

    it('refuses an internal token minted for a different service', async () => {
      // The audience check. A token another service was given must not work
      // here even if this endpoint were opened later.
      const token = await internalToken('asset-service', {
        organizationId: org,
        targetService: 'economic-service',
      });

      await http(mvp).get('/v1/documents').set('x-internal-token', token).expect(401);
    });
  });

  // =========================================================================
  // Tenant isolation, over HTTP
  // =========================================================================

  describe('tenant isolation', () => {
    it('reports another organization document as absent, not forbidden', async () => {
      const { document } = await upload(mvp);

      const refusal = await http(mvp)
        .get(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${orgAdmin(other)}`)
        .expect(404);

      // A 403 would confirm it exists and that somebody else owns it, which
      // for a document store is itself the leak.
      expect(JSON.stringify(refusal.body)).not.toContain(org);
    });

    it('does not issue a download URL to another organization', async () => {
      const { document } = await upload(scanned);

      await http(scanned)
        .post(`/v1/documents/${document.id}/download-url`)
        .set('authorization', `Bearer ${orgAdmin(other)}`)
        .expect(404);
    });

    it('does not let another organization delete it', async () => {
      const { document } = await upload(mvp);

      await http(mvp)
        .delete(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${orgAdmin(other)}`)
        .send({ reason: 'not mine to delete at all' })
        .expect(404);
    });

    it('does not let another organization redeem an upload intent', async () => {
      // Stricter than reading: an intent is permission issued to one
      // organization to create one object.
      const bytes = FIXTURES.pdf();
      const intent = await http(mvp)
        .post('/v1/documents/upload-url')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .send({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'contract.pdf',
        })
        .expect(201);

      await putToSignedUrl(intent.body.uploadUrl, bytes, 'application/pdf');

      await http(mvp)
        .post('/v1/documents')
        .set('authorization', `Bearer ${orgAdmin(other)}`)
        .send({ uploadIntentId: intent.body.uploadIntentId })
        .expect(404);
    });

    it('lists only the caller organization documents', async () => {
      await upload(mvp);
      await upload(mvp, { organizationId: other, filename: 'theirs.pdf' });

      const listed = await http(mvp)
        .get('/v1/documents?limit=100')
        .set('authorization', `Bearer ${orgAdmin(other)}`)
        .expect(200);

      expect(listed.body.items.length).toBeGreaterThan(0);
      for (const item of listed.body.items) {
        expect(item.organizationId).toBe(other);
      }
    });
  });

  // =========================================================================
  // Input validation at the boundary
  // =========================================================================

  describe('what the boundary refuses', () => {
    const post = (body: unknown) =>
      http(mvp)
        .post('/v1/documents/upload-url')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .send(body);

    it('refuses an unknown document class', async () => {
      await post({
        documentClass: 'SOMETHING_INVENTED',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        filename: 'x.pdf',
      }).expect(400);
    });

    it('refuses a content type the class does not permit', async () => {
      await post({
        documentClass: 'CONTRACT',
        contentType: 'text/html',
        sizeBytes: 1024,
        filename: 'contract.html',
      }).expect(422);
    });

    it('refuses an unknown field rather than dropping it', async () => {
      // `.strict()` everywhere — and here it is what stops a caller supplying
      // an object key, which ADR-014 requires to be server-generated.
      await post({
        documentClass: 'CONTRACT',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        filename: 'contract.pdf',
        objectKey: 'documents/somebody-else/secret',
      }).expect(400);
    });

    it('refuses a deletion with no stated reason', async () => {
      const { document, token } = await upload(mvp);

      await http(mvp)
        .delete(`/v1/documents/${document.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('refuses content that is not what it was declared to be', async () => {
      // The check ADR-014 asks for: an HTML page uploaded under a PDF
      // declaration is caught at finalize by its bytes, not its extension.
      const bytes = FIXTURES.html();
      const token = orgAdmin(org);

      const intent = await http(mvp)
        .post('/v1/documents/upload-url')
        .set('authorization', `Bearer ${token}`)
        .send({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'not-really.pdf',
        })
        .expect(201);

      await putToSignedUrl(intent.body.uploadUrl, bytes, 'application/pdf');

      await http(mvp)
        .post('/v1/documents')
        .set('authorization', `Bearer ${token}`)
        .send({ uploadIntentId: intent.body.uploadIntentId })
        .expect(422);
    });
  });

  // =========================================================================
  // Idempotency and events, through the real transaction
  // =========================================================================

  describe('registering twice', () => {
    it('returns the same document rather than creating a second', async () => {
      const bytes = FIXTURES.pdf();
      const token = orgAdmin(org);

      const intent = await http(mvp)
        .post('/v1/documents/upload-url')
        .set('authorization', `Bearer ${token}`)
        .send({
          documentClass: 'CONTRACT',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          filename: 'replayed.pdf',
        })
        .expect(201);

      await putToSignedUrl(intent.body.uploadUrl, bytes, 'application/pdf');

      const first = await http(mvp)
        .post('/v1/documents')
        .set('authorization', `Bearer ${token}`)
        .send({ uploadIntentId: intent.body.uploadIntentId })
        .expect(201);

      const second = await http(mvp)
        .post('/v1/documents')
        .set('authorization', `Bearer ${token}`)
        .send({ uploadIntentId: intent.body.uploadIntentId })
        .expect(201);

      expect(second.body.id).toBe(first.body.id);

      const rows = await runUnscoped('the suite counts what the replay produced', () =>
        mvp.prisma.client.outboxMessage.findMany({
          where: { aggregateId: first.body.id, eventName: 'DOCUMENT_UPLOADED' },
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('writes the outbox row inside the same transaction as the document', async () => {
      const { document } = await upload(mvp);

      const rows = await runUnscoped('the suite reads the outbox', () =>
        mvp.prisma.client.outboxMessage.findMany({ where: { aggregateId: document.id } }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.topic).toBe('rasta.document.v1');
      expect(rows[0]?.partitionKey).toBe(document.id);
    });
  });

  // =========================================================================
  // Operability
  // =========================================================================

  describe('the probes an orchestrator uses', () => {
    it('answers liveness without a token', async () => {
      await http(mvp).get('/health/live').expect(200);
    });

    it('answers readiness against the real database', async () => {
      const response = await http(mvp).get('/health/ready').expect(200);
      expect(response.body.status).toBeDefined();
    });

    it('answers the startup probe once the database is reachable', async () => {
      const response = await http(mvp).get('/health/startup').expect(200);
      expect(response.body).toMatchObject({ status: 'ok', checks: { database: true } });
    });

    it('identifies the build without carrying business data', async () => {
      // Reachable without a token, so it must say what it is and nothing else.
      const response = await http(mvp).get('/health/version').expect(200);

      expect(response.body.service).toBe('document-service');
      expect(response.body.node).toMatch(/^v\d+/);
      expect(JSON.stringify(response.body)).not.toMatch(/postgres|password|rasta_minio/i);
    });

    it('exposes metrics for scraping', async () => {
      const response = await http(mvp).get('/metrics').expect(200);
      expect(response.text).toContain('document');
    });

    it('leaves the probes reachable without a token, and nothing else', async () => {
      // S-02: open must be explicit. These four carry a stated `@Public`
      // reason; every business endpoint answers 401.
      for (const path of ['/health/live', '/health/ready', '/health/startup', '/health/version']) {
        await http(mvp).get(path).expect(200);
      }
      await http(mvp).get('/v1/documents').expect(401);
    });
  });
});
