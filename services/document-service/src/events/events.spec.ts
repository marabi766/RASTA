import {
  DOCUMENT_EVENTS,
  DOCUMENT_EVENT_SCHEMAS,
  documentUploadedPayload,
  validateDocumentPayload,
} from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * The published event contract, checked at runtime.
 *
 * `docs/07` § 7.8 requires validation at publish time rather than only in a
 * test, because a contract checked only by a test is a contract that holds
 * until somebody adds a field in a hurry. These assertions cover the two
 * things that would do real damage: a payload that carries something it must
 * never carry, and a validator that lets a malformed one through.
 */

const uploaded = () => ({
  documentId: 'DOC_01JBQ8',
  organizationId: 'ORG-1',
  documentClass: 'CONTRACT',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  filename: 'contract.pdf',
  scanState: 'PENDING',
  ownerResourceType: null,
  ownerResourceId: null,
  uploadedBy: 'USR-1',
  uploadedAt: '2026-08-31T00:00:00.000Z',
});

describe('validating a payload before it is published', () => {
  it('accepts a well-formed DOCUMENT_UPLOADED', () => {
    expect(validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, uploaded())).toMatchObject({
      documentId: 'DOC_01JBQ8',
      scanState: 'PENDING',
    });
  });

  it('refuses one that is missing a field consumers rely on', () => {
    const { scanState, ...withoutScanState } = uploaded();
    void scanState;

    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, withoutScanState),
    ).toThrow(/does not match its published contract/);
  });

  it('refuses a scan state that is not one of the published values', () => {
    // A consumer filtering on this must never see a value it has no branch
    // for — and inventing one at publish time is how that happens.
    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, {
        ...uploaded(),
        scanState: 'PROBABLY_FINE',
      }),
    ).toThrow(/does not match its published contract/);
  });

  it('names the event in the failure, so a log line is actionable', () => {
    expect(() => validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_DELETED, {})).toThrow(
      /DOCUMENT_DELETED/,
    );
  });
});

describe('what an event must never carry', () => {
  it('rejects a payload carrying an object key', () => {
    // An event lives seven days in a log every service can read. An object key
    // there would let anyone with bucket credentials skip this service's
    // authorization entirely.
    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, {
        ...uploaded(),
        objectKey: 'documents/ORG-1/CONTRACT/01JBQ8',
      }),
    ).toThrow();
  });

  it('rejects a payload carrying a signed URL', () => {
    // Worse than a key: a bearer credential for a private object, readable by
    // every consumer for its whole lifetime.
    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, {
        ...uploaded(),
        downloadUrl: 'http://storage/rasta-documents/x?X-Amz-Signature=abc',
      }),
    ).toThrow();
  });

  it('describes no field that could be used to fetch bytes elsewhere', () => {
    // The shape itself, read rather than sampled: a field added later with a
    // name like this should fail here before it reaches a topic.
    const fields = Object.keys(documentUploadedPayload.shape);
    for (const forbidden of ['objectKey', 'bucket', 'downloadUrl', 'uploadUrl', 'checksum']) {
      expect(fields).not.toContain(forbidden);
    }
  });

  it('carries no storage credential on any event, not just the uploaded one', () => {
    // Applied to every schema at once rather than to the one that happened to
    // be written first. `DOCUMENT_SCANNED` was added later (ADR-049) and would
    // have been outside the check above.
    const forbidden = [
      'objectKey',
      'bucket',
      'endpoint',
      'downloadUrl',
      'uploadUrl',
      'signedUrl',
      'accessKey',
      'secretKey',
      'credentials',
    ];

    for (const [name, schema] of Object.entries(DOCUMENT_EVENT_SCHEMAS)) {
      const shape =
        'shape' in schema
          ? schema.shape
          : (schema as never as { _def: { schema: { shape: object } } })._def.schema.shape;
      for (const field of forbidden) {
        expect({ event: name, field, present: field in shape }).toEqual({
          event: name,
          field,
          present: false,
        });
      }
    }
  });
});

/**
 * The scan outcome, which is the event ADR-049 added.
 *
 * It exists because scanning became asynchronous: `DOCUMENT_UPLOADED` now
 * always says `PENDING`, so without a second fact a consumer holding a
 * document reference could not learn that it became downloadable except by
 * polling — and the most security-relevant transition on the platform would be
 * the one thing the event log did not record.
 */
describe('DOCUMENT_SCANNED', () => {
  const scanned = (overrides: Record<string, unknown> = {}) => ({
    documentId: 'DOC_01JBQ8',
    organizationId: 'ORG-1',
    documentClass: 'CONTRACT',
    scanState: 'CLEAN',
    engine: 'clamav',
    engineVersion: '1.5.4',
    signatureVersion: '28108',
    failureReason: null,
    scannedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  });

  it('accepts a clean outcome', () => {
    expect(validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_SCANNED, scanned())).toMatchObject({
      scanState: 'CLEAN',
      engine: 'clamav',
    });
  });

  it('accepts an infected outcome', () => {
    expect(
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_SCANNED, scanned({ scanState: 'INFECTED' })),
    ).toMatchObject({ scanState: 'INFECTED' });
  });

  it('accepts a failure that states why', () => {
    expect(
      validateDocumentPayload(
        DOCUMENT_EVENTS.DOCUMENT_SCANNED,
        scanned({ scanState: 'FAILED', failureReason: 'TIMEOUT' }),
      ),
    ).toMatchObject({ scanState: 'FAILED', failureReason: 'TIMEOUT' });
  });

  it('refuses a failure that states no reason', () => {
    // A FAILED outcome nobody can diagnose, and one the database would refuse
    // on the row too (`ck_document_failure_reason_only_when_failed`).
    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_SCANNED, scanned({ scanState: 'FAILED' })),
    ).toThrow(/DOCUMENT_SCANNED/);
  });

  it('refuses a reason on an outcome that did not fail', () => {
    expect(() =>
      validateDocumentPayload(
        DOCUMENT_EVENTS.DOCUMENT_SCANNED,
        scanned({ failureReason: 'TIMEOUT' }),
      ),
    ).toThrow(/DOCUMENT_SCANNED/);
  });

  it.each(['PENDING', 'NOT_SCANNED', 'MAYBE'])('refuses %s, which is not an outcome', (state) => {
    // `PENDING` is a state, not a result. Publishing one would tell a consumer
    // that scanning finished when it has not.
    expect(() =>
      validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_SCANNED, scanned({ scanState: state })),
    ).toThrow(/DOCUMENT_SCANNED/);
  });

  it('carries no signature name, which belongs on VIRUS_DETECTED', () => {
    // Deliberate separation. This is a state change every interested consumer
    // reads; the finding is a security event notification-service treats as
    // critical, and mixing them would put the second in front of readers of
    // the first.
    expect(() =>
      validateDocumentPayload(
        DOCUMENT_EVENTS.DOCUMENT_SCANNED,
        scanned({ signature: 'Eicar-Test-Signature' }),
      ),
    ).toThrow(/DOCUMENT_SCANNED/);
  });
});

describe('the event catalogue', () => {
  it('has a schema for every name and a name for every schema', () => {
    // The pairing that silently breaks when an event is added to one and not
    // the other: `enqueue` looks the schema up by name, so a missing entry is
    // a publish-time crash rather than a compile error.
    expect(Object.keys(DOCUMENT_EVENT_SCHEMAS).sort()).toEqual(Object.keys(DOCUMENT_EVENTS).sort());
  });

  it('routes every event by the document it concerns', () => {
    for (const name of Object.values(DOCUMENT_EVENTS)) {
      expect(AGGREGATE_OF[name]).toBe('Document');
      expect(resolvePartitionKey(name, { documentId: 'DOC_1' }).key).toBe('DOC_1');
    }
  });
});
