import { test, expect, errorCode, type Actor } from '../../src/api';
import { e2eConfig } from '../../src/env';
import { EconomicEventTap } from '../../src/events';

/**
 * The direct-upload lifecycle, end to end (ADR-014).
 *
 * Through the real thing: a Keycloak token, api-gateway, document-service,
 * PostgreSQL, MinIO and Kafka. Nothing is stubbed — and the step that matters
 * most is the one that does **not** go through the platform at all. The file
 * travels from this test straight to object storage over a signed URL, exactly
 * as a browser would, and never passes through a Rasta process. That is
 * ADR-014's central claim, and this is the only place it can be observed.
 *
 * ## What this suite deliberately cannot do
 *
 * It never downloads a file, because in the running MVP no file is
 * downloadable. `AppModule` composes the honest scanner stub, which inspects
 * nothing and records `NOT_SCANNED`, and `canDownload` authorizes `CLEAN` and
 * nothing else. So the download assertion here is a **refusal**, and that is
 * the correct end-to-end evidence for the platform as it currently stands.
 *
 * The successful-download path is proven in document-service's own API suite,
 * which injects a test-only scanner returning `CLEAN` through the
 * `MALWARE_SCANNER` port. It is deliberately not injectable from here: this
 * run boots the service the way a deployment does, and if a `CLEAN` verdict
 * could be arranged from outside the process, that would itself be the
 * finding.
 *
 * Q-18 — which scanner the platform will actually run — is open. Until it is
 * answered, uploading and registering work and downloading does not.
 */

const config = e2eConfig();

/** A structurally real PDF, built byte by byte rather than read from disk. */
function pdfBytes(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );
}

/** An HTML page — the thing that must never be stored as a document. */
function htmlBytes(): Buffer {
  return Buffer.from(
    '<!DOCTYPE html><html><body><script>fetch("/steal")</script></body></html>',
    'latin1',
  );
}

/**
 * Uploads straight to object storage, the way a browser does.
 *
 * A plain `fetch` carrying no platform credential of any kind: the signed URL
 * is the entire authorisation. Using an S3 client here would prove something
 * else — that a program holding bucket credentials can write to a bucket.
 */
async function putToSignedUrl(url: string, body: Buffer, contentType: string): Promise<number> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  });
  return response.status;
}

/**
 * The whole flow, as a client performs it: intent, direct PUT, registration.
 *
 * Returns the correlation id the *registration* carried, because that is the
 * one the published event has to echo.
 */
async function uploadDocument(
  actor: Actor,
  options: { bytes?: Buffer; declaredType?: string; filename?: string } = {},
): Promise<{
  status: number;
  document: Record<string, unknown>;
  correlationId: string;
}> {
  const bytes = options.bytes ?? pdfBytes();
  const declaredType = options.declaredType ?? 'application/pdf';

  const intent = await actor.post('/v1/documents/upload-url', {
    body: {
      documentClass: 'CONTRACT',
      contentType: declaredType,
      sizeBytes: bytes.length,
      filename: options.filename ?? 'قرارداد-اجاره-بیل-مکانیکی.pdf',
    },
  });
  expect(intent.status).toBe(201);

  const issued = intent.body as { uploadIntentId: string; uploadUrl: string; expiresAt: string };
  expect(await putToSignedUrl(issued.uploadUrl, bytes, declaredType)).toBe(200);

  const registered = await actor.post('/v1/documents', {
    body: { uploadIntentId: issued.uploadIntentId },
  });

  return {
    status: registered.status,
    document: registered.body as Record<string, unknown>,
    correlationId: registered.correlationId,
  };
}

/**
 * Waits for the scan worker to reach a verdict on one document.
 *
 * Polling rather than a fixed sleep, and it is the honest shape of the
 * assertion: scanning is asynchronous by design (ADR-014 step 4, ADR-049), so
 * "it becomes downloadable" is a statement about a state that changes on its
 * own, and a test that slept for a guessed interval would be asserting the
 * guess.
 *
 * Generous, because the real work behind it is a 110 MB signature database in
 * a container that may have started moments ago. Fails with the state it
 * actually saw, so a timeout here names the problem rather than reading as a
 * flaky wait.
 */
async function awaitScanned(
  actor: Actor,
  documentId: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    const read = await actor.get(`/v1/documents/${documentId}`);
    expect(read.status).toBe(200);
    last = read.body as Record<string, unknown>;

    if (last.scanState !== 'PENDING') return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `The document was still ${String(last.scanState)} after ${timeoutMs}ms. ` +
      'Is the ClamAV sidecar reachable from document-service?',
  );
}

test.describe.serial('the document direct-upload lifecycle', () => {
  let documentId: string;

  test('refuses an unauthenticated caller and the oversight role', async ({
    anonymous,
    auditor,
  }) => {
    // S-02 and `docs/09` § 9.3, at the edge. A document store holds other
    // organizations' contracts and licences; the oversight role has aggregate
    // access only, and an auditor who could reach documents could read every
    // contract on the platform.
    expect((await anonymous.get('/v1/documents')).status).toBe(401);
    expect((await auditor.get('/v1/documents')).status).toBe(403);
  });

  test('carries the file to storage without it passing through the platform', async ({
    tenantA,
  }) => {
    const bytes = pdfBytes();

    const intent = await tenantA.post('/v1/documents/upload-url', {
      body: {
        documentClass: 'CONTRACT',
        contentType: 'application/pdf',
        sizeBytes: bytes.length,
        filename: 'قرارداد.pdf',
      },
    });
    expect(intent.status).toBe(201);

    const issued = intent.body as { uploadIntentId: string; uploadUrl: string; expiresAt: string };
    expect(issued.uploadIntentId).toMatch(/^UPI_/);
    // A credential, and a short-lived one. It is also the only place the object
    // key appears — the client redeems the intent by id, so it can never name a
    // different object.
    expect(issued.uploadUrl).toContain('X-Amz-Signature');
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // ADR-014's central rule, observable: this PUT reaches object storage, not
    // a Rasta service.
    expect(new URL(issued.uploadUrl).origin).not.toBe(new URL(config.gatewayUrl).origin);
    expect(await putToSignedUrl(issued.uploadUrl, bytes, 'application/pdf')).toBe(200);

    const registered = await tenantA.post('/v1/documents', {
      body: {
        uploadIntentId: issued.uploadIntentId,
        ownerResourceType: 'CONTRACT',
        ownerResourceId: 'CTR_E2E',
      },
    });
    expect(registered.status).toBe(201);

    const document = registered.body as Record<string, unknown>;
    documentId = String(document.id);

    expect(document.status).toBe('REGISTERED');
    // From storage metadata and from the object's own bytes, not from what the
    // client declared.
    expect(document.sizeBytes).toBe(bytes.length);
    expect(document.contentType).toBe('application/pdf');

    // Registered PENDING, and refused while it is (ADR-014, ADR-049). Asserted
    // here rather than in a test of its own because that test would need an
    // unscanned document, and obtaining one costs another upload — which is
    // what pushed this serial suite past the gateway's twenty-per-hour
    // document cap (`docs/06` § 6.9). The instant after registration is the
    // one moment a PENDING document is guaranteed to exist.
    expect(document.scanState).toBe('PENDING');

    const tooEarly = await tenantA.post(`/v1/documents/${documentId}/download-url`);

    // The worker could clear it between the two calls, so both outcomes are
    // accepted and only the *unsafe* one is ruled out: a URL is never issued
    // while the state is not CLEAN.
    if (tooEarly.status === 422) {
      expect(errorCode(tooEarly.body)).toBe('BUSINESS_RULE_VIOLATION');
      expect(JSON.stringify(tooEarly.body)).toMatch(/until its security scan completes/i);
      expect(tooEarly.body).not.toHaveProperty('downloadUrl');
    } else {
      const cleared = await tenantA.get(`/v1/documents/${documentId}`);
      expect((cleared.body as Record<string, unknown>).scanState).toBe('CLEAN');
    }
  });

  test('is scanned by a real engine, and becomes downloadable only then', async ({ tenantA }) => {
    // Q-18 answered end to end (ADR-049). Scanning is asynchronous, so this
    // polls rather than asserting once: the document is registered `PENDING`,
    // a background worker streams the object through clamd, and only a
    // validated CLEAN verdict makes it downloadable.
    //
    // The two things this proves that no unit test can: that a real ClamAV is
    // reachable from a real document-service in the running stack, and that
    // the state a caller sees moves on its own without anybody asking it to.
    const document = await awaitScanned(tenantA, documentId);

    expect(document.scanState).toBe('CLEAN');
    expect(document.scanInspectedContent).toBe(true);
    expect(document.scanEngine).toBe('clamav');
    // The engine and the database that cleared it, so the claim can be dated.
    expect(String(document.scanSignatureVersion)).toMatch(/^\d+$/);

    // And now the bytes come back — the capability the whole ADR exists to
    // deliver, reachable for the first time here. Before ADR-049 no document
    // in any deployment could be downloaded, because nothing ever issued a
    // CLEAN verdict.
    const link = await tenantA.post(`/v1/documents/${documentId}/download-url`);
    expect(link.status).toBe(200);

    const fetched = await fetch(String((link.body as Record<string, unknown>).downloadUrl));
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(pdfBytes())).toBe(true);
    // Never rendered: ADR-014 forbids serving stored content as HTML.
    expect(fetched.headers.get('content-disposition')).toContain('attachment');
  });

  test('never returns the object key, the bucket or a URL in metadata', async ({ tenantA }) => {
    // A caller who could read the key could try to reach the object with
    // credentials obtained elsewhere, bypassing every check the platform makes.
    const read = await tenantA.get(`/v1/documents/${documentId}`);

    const serialised = JSON.stringify(read.body);
    expect(serialised).not.toContain('rasta-documents');
    expect(serialised).not.toMatch(/X-Amz-Signature|documents\/ORG-/);
  });

  test('does not let another organization see it, or ask for it', async ({ tenantB }) => {
    // 404 rather than 403 on both: a refusal would confirm the document exists
    // and that somebody else owns it, which for a document store is the leak.
    expect((await tenantB.get(`/v1/documents/${documentId}`)).status).toBe(404);
    expect((await tenantB.post(`/v1/documents/${documentId}/download-url`)).status).toBe(404);
  });

  test('publishes DOCUMENT_UPLOADED carrying the honest scan state', async ({ tenantA }) => {
    // The HTTP response proves the service answered. It does not prove the
    // write reached the outbox, that the relay picked it up, or that the
    // correlation identifier survived the hop into Kafka — and that hop is
    // where a correlation chain usually breaks, because nothing downstream
    // fails loudly when it does.
    //
    // The tap reads from the end of the topic, so it is started before the
    // upload it observes rather than after.
    const tap = await EconomicEventTap.start(config, config.documentTopic);

    try {
      const uploaded = await uploadDocument(tenantA, { filename: 'event-probe.pdf' });
      expect(uploaded.status).toBe(201);

      const [event] = await tap.awaitCorrelated(uploaded.correlationId, ['DOCUMENT_UPLOADED']);

      // Keyed by the document, so its history stays in order on one partition.
      expect(event.key).toBe(uploaded.document.id);
      expect(event.envelopeCorrelationId).toBe(uploaded.correlationId);

      // The event means "confirmed and registered", not "scanned and safe" —
      // and it says so, so no consumer has to read its existence as a clean
      // bill of health. Since ADR-049 it is always `PENDING`: the outcome is a
      // separate fact that arrives later as `DOCUMENT_SCANNED`.
      expect(event.payload.scanState).toBe('PENDING');

      // Seven days in a log every service can read. A key or a signed URL here
      // would be a durable bypass of every check above.
      const serialised = JSON.stringify(event.payload);
      expect(serialised).not.toMatch(/X-Amz-Signature|documents\/ORG-|rasta-documents/);
    } finally {
      await tap.stop();
    }
  });

  test('refuses content that is not what the client declared', async ({ tenantA }) => {
    // The check ADR-014 asks for, exercised end to end: the object is HTML, the
    // declaration said PDF, and the extension said nothing useful either way.
    // It is caught by its bytes at registration, after the upload has already
    // happened — which is the only point at which it can be caught, because the
    // file never came through the service.
    const attempt = await uploadDocument(tenantA, {
      bytes: htmlBytes(),
      filename: 'not-really-a-contract.pdf',
    });

    expect(attempt.status).toBe(422);
    expect(errorCode(attempt.document)).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('records a deletion as a tombstone and reports it as absent afterwards', async ({
    tenantA,
  }) => {
    const deleted = await tenantA.delete(`/v1/documents/${documentId}`, {
      body: { reason: 'superseded by the countersigned revision' },
    });

    expect(deleted.status).toBe(200);
    const body = deleted.body as Record<string, unknown>;
    expect(body.status).toBe('DELETED');
    expect(body.deletionReason).toBe('superseded by the countersigned revision');
    expect(body.deletedAt).toBeTruthy();

    // Gone, so 404 rather than the 422 an unscanned document gets: the caller
    // is told it is absent rather than that it is unsafe.
    expect((await tenantA.post(`/v1/documents/${documentId}/download-url`)).status).toBe(404);
  });

  test('excludes the tombstone from the default listing but keeps the record', async ({
    tenantA,
  }) => {
    const visible = await tenantA.get('/v1/documents?includeDeleted=false&limit=100');
    expect(visible.status).toBe(200);
    const ids = (visible.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).not.toContain(documentId);

    // `includeDeleted=false` read as written. The coercion this platform used
    // to apply turned every non-empty string into `true`, so the filter above
    // would have returned exactly what it was asked to exclude.
    const all = await tenantA.get('/v1/documents?includeDeleted=true&limit=100');
    expect((all.body as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      documentId,
    );
  });
});
