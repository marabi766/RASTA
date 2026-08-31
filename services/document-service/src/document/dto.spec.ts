import { listDocumentsQuerySchema, requestUploadUrlSchema } from './dto';

/**
 * The request shapes at the boundary.
 *
 * Only the parts where a plausible-looking schema would be quietly wrong are
 * asserted here; the rest of the validation is exercised through the real HTTP
 * surface in `test/api-document.int-spec.ts`.
 */

describe('the includeDeleted query flag', () => {
  it('excludes deleted documents when the caller says so explicitly', () => {
    // The defect this replaced: `z.coerce.boolean()` applies `Boolean()`, so
    // `?includeDeleted=false` parsed as `true` and returned exactly the rows
    // the caller had asked to leave out. A filter that cannot be switched off
    // is worse than no filter, because the caller reads their own query back
    // and believes it worked.
    expect(listDocumentsQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted).toBe(false);
    expect(listDocumentsQuerySchema.parse({ includeDeleted: '0' }).includeDeleted).toBe(false);
    expect(listDocumentsQuerySchema.parse({ includeDeleted: 'no' }).includeDeleted).toBe(false);
  });

  it('includes them when the caller asks', () => {
    expect(listDocumentsQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted).toBe(true);
    expect(listDocumentsQuerySchema.parse({ includeDeleted: '1' }).includeDeleted).toBe(true);
  });

  it('defaults to excluding them', () => {
    expect(listDocumentsQuerySchema.parse({}).includeDeleted).toBe(false);
  });

  it('refuses a value it cannot read rather than guessing', () => {
    // A typo in a filter should fail the request, not silently pick a side.
    expect(() => listDocumentsQuerySchema.parse({ includeDeleted: 'ture' })).toThrow();
  });
});

describe('the request shapes refuse what they do not recognise', () => {
  it('rejects an unknown field rather than dropping it', () => {
    // `.strict()` everywhere: a client that misspells `ownerResourceId` should
    // learn about it, not have its scoping intent silently discarded.
    expect(() => listDocumentsQuerySchema.parse({ ownerResourceld: 'ASSET_1' })).toThrow();
  });

  it('does not let a caller name the object key', () => {
    // The property ADR-014 depends on: keys are server-generated, so there is
    // no field here through which one could be supplied.
    expect(() =>
      requestUploadUrlSchema.parse({
        documentClass: 'CONTRACT',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        filename: 'contract.pdf',
        objectKey: 'documents/ORG-X/anything',
      }),
    ).toThrow();
  });
});
