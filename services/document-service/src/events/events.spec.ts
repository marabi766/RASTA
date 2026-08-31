import { DOCUMENT_EVENTS, documentUploadedPayload, validateDocumentPayload } from './events';

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
  scanState: 'NOT_SCANNED',
  ownerResourceType: null,
  ownerResourceId: null,
  uploadedBy: 'USR-1',
  uploadedAt: '2026-08-31T00:00:00.000Z',
});

describe('validating a payload before it is published', () => {
  it('accepts a well-formed DOCUMENT_UPLOADED', () => {
    expect(validateDocumentPayload(DOCUMENT_EVENTS.DOCUMENT_UPLOADED, uploaded())).toMatchObject({
      documentId: 'DOC_01JBQ8',
      scanState: 'NOT_SCANNED',
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
});
