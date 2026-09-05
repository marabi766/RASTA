import {
  approveQualificationSchema,
  listQualifiedForQuerySchema,
  registerSupplierSchema,
  reinstateSupplierSchema,
  rejectQualificationSchema,
  reviewQueueQuerySchema,
  searchSuppliersQuerySchema,
  submitQualificationSchema,
  suspendSupplierSchema,
} from './dto';

/**
 * Boundary validation (AGENTS.md § 3, `docs/06` § 6.4).
 *
 * The refusals are the point. Every schema is `.strict()`, and the fields a
 * client is not allowed to send are exactly the security-relevant ones: the
 * organization, the qualification state, the decision, the supplier status. A
 * dropped unknown field would mean a caller could send `organizationId` and
 * believe it took effect — or, worse, that a future refactor could start reading
 * it.
 */

const VALID_REGISTER = { displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] };

describe('RegisterSupplier', () => {
  it('accepts a name and at least one claimed capability', () => {
    expect(registerSupplierSchema.parse(VALID_REGISTER)).toEqual(VALID_REGISTER);
  });

  it('refuses an organizationId in the body', () => {
    // The organization comes from the verified token. A body field would let a
    // supplier register a profile for somebody else's organization.
    expect(
      registerSupplierSchema.safeParse({ ...VALID_REGISTER, organizationId: 'ORG_OTHER' }).success,
    ).toBe(false);
  });

  it('refuses a status in the body', () => {
    // Suspension is a platform-operator decision. A supplier that could set
    // this would lift its own suspension at registration time.
    expect(registerSupplierSchema.safeParse({ ...VALID_REGISTER, status: 'ACTIVE' }).success).toBe(
      false,
    );
  });

  it('refuses a score or rating', () => {
    expect(registerSupplierSchema.safeParse({ ...VALID_REGISTER, score: 90 }).success).toBe(false);
    expect(registerSupplierSchema.safeParse({ ...VALID_REGISTER, rating: 5 }).success).toBe(false);
  });

  it('refuses a qualifiedFor field — claiming is not qualification', () => {
    expect(
      registerSupplierSchema.safeParse({ ...VALID_REGISTER, qualifiedFor: ['GOODS_SUPPLY'] })
        .success,
    ).toBe(false);
  });

  it('refuses a capability outside the bounded vocabulary', () => {
    expect(
      registerSupplierSchema.safeParse({ ...VALID_REGISTER, capabilities: ['HAULAGE'] }).success,
    ).toBe(false);
  });

  it('refuses a duplicate capability', () => {
    // Also a unique index. The DTO refusal is what makes it a 400 naming the
    // field rather than a constraint violation surfacing as a 500.
    const result = registerSupplierSchema.safeParse({
      ...VALID_REGISTER,
      capabilities: ['GOODS_SUPPLY', 'GOODS_SUPPLY'],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/only once/);
  });

  it('refuses an empty capability list', () => {
    expect(registerSupplierSchema.safeParse({ ...VALID_REGISTER, capabilities: [] }).success).toBe(
      false,
    );
  });

  it('refuses a name that is only whitespace', () => {
    expect(
      registerSupplierSchema.safeParse({ ...VALID_REGISTER, displayName: '   ' }).success,
    ).toBe(false);
  });

  it('trims a name rather than storing the padding', () => {
    expect(
      registerSupplierSchema.parse({ ...VALID_REGISTER, displayName: '  A shop  ' }).displayName,
    ).toBe('A shop');
  });
});

describe('SubmitQualification', () => {
  it('accepts a capability with no evidence at all', () => {
    // No accepted document says a submission must carry documents, or which,
    // or how many. Requiring some number would be inventing an admissions rule.
    const parsed = submitQualificationSchema.parse({ capability: 'CONTRACTING' });

    expect(parsed.evidence).toEqual([]);
  });

  it('accepts opaque document identifiers with optional labels', () => {
    const parsed = submitQualificationSchema.parse({
      capability: 'GOODS_SUPPLY',
      evidence: [{ documentId: 'DOC_1', label: 'Trade licence' }, { documentId: 'DOC_2' }],
    });

    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.evidence[1].label).toBeUndefined();
  });

  it('refuses an empty evidence identifier', () => {
    // "Evidence references cannot be empty strings." A reference to nothing
    // still counts as an attachment when somebody reads the row.
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        evidence: [{ documentId: '' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a whitespace-only evidence identifier', () => {
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        evidence: [{ documentId: '   ' }],
      }).success,
    ).toBe(false);
  });

  it('refuses the same document attached twice', () => {
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        evidence: [{ documentId: 'DOC_1' }, { documentId: 'DOC_1' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a document URL or object key masquerading as a label field', () => {
    // Only `documentId` and `label` exist. A `url` or `objectKey` would be a
    // caller telling this service where to fetch bytes, which it never does.
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        evidence: [{ documentId: 'DOC_1', url: 'https://example.invalid/doc' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a state in the body — a submitter cannot approve itself', () => {
    expect(
      submitQualificationSchema.safeParse({ capability: 'GOODS_SUPPLY', state: 'APPROVED' })
        .success,
    ).toBe(false);
  });

  it('refuses decidedBy or decidedAt in the body', () => {
    expect(
      submitQualificationSchema.safeParse({ capability: 'GOODS_SUPPLY', decidedBy: 'USR_X' })
        .success,
    ).toBe(false);
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        decidedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('refuses an expiry or validity period', () => {
    // No accepted document defines one, and accepting the field would let a
    // client invent the rule the service refuses to invent.
    expect(
      submitQualificationSchema.safeParse({
        capability: 'GOODS_SUPPLY',
        validUntil: '2027-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('the decision DTOs', () => {
  it('approves with an optional private note', () => {
    expect(approveQualificationSchema.parse({})).toEqual({});
    expect(approveQualificationSchema.parse({ note: 'Called the referee' }).note).toBe(
      'Called the referee',
    );
  });

  it('requires a stated reason to reject', () => {
    // Published on SUPPLIER_REJECTED. A rejection whose reason the supplier
    // cannot see is a decision they can never act on.
    expect(rejectQualificationSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a one-character reason', () => {
    // A required field that "x" satisfies answers who and when but not why.
    expect(rejectQualificationSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });

  it('keeps the published reason and the private note as separate fields', () => {
    const parsed = rejectQualificationSchema.parse({
      reason: 'The submission named no evidence at all',
      note: 'Third attempt from this organization',
    });

    expect(parsed.reason).not.toBe(parsed.note);
  });

  it('refuses a decidedBy override on either decision', () => {
    // The actor is taken from the request context, so an approval always names
    // the human who actually made it.
    expect(approveQualificationSchema.safeParse({ decidedBy: 'USR_SOMEONE' }).success).toBe(false);
    expect(
      rejectQualificationSchema.safeParse({ reason: 'A stated reason', decidedBy: 'USR_X' })
        .success,
    ).toBe(false);
  });
});

describe('the suspension DTOs', () => {
  it('requires a stated reason to suspend', () => {
    expect(suspendSupplierSchema.safeParse({}).success).toBe(false);
    expect(suspendSupplierSchema.parse({ reason: 'Two undelivered orders' }).reason).toBe(
      'Two undelivered orders',
    );
  });

  it('requires a stated reason to reinstate', () => {
    // A lifting nobody explained is a gap in the record exactly where somebody
    // will later ask what happened.
    expect(reinstateSupplierSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an `until` date — no rule defines a timed suspension', () => {
    expect(
      suspendSupplierSchema.safeParse({
        reason: 'Two undelivered orders',
        until: '2026-10-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('the directory query', () => {
  it('defaults to the platform page size', () => {
    expect(searchSuppliersQuerySchema.parse({}).limit).toBe(25);
  });

  it('refuses a page size above the platform maximum', () => {
    expect(searchSuppliersQuerySchema.safeParse({ limit: '10000' }).success).toBe(false);
  });

  it('refuses an unknown filter rather than ignoring it', () => {
    // A silently ignored filter returns a wider set than the caller asked for,
    // which for a directory is a disclosure the caller did not intend to make.
    expect(searchSuppliersQuerySchema.safeParse({ organizationId: 'ORG_1' }).success).toBe(false);
  });

  it('refuses a free-text or rating sort', () => {
    // No search index is deployed for this service, and no score exists
    // (Q-12, ADR-042). Accepting and ignoring `sort` is what ADR-042 refused.
    expect(searchSuppliersQuerySchema.safeParse({ sort: 'RATING' }).success).toBe(false);
    expect(searchSuppliersQuerySchema.safeParse({ q: 'workshop' }).success).toBe(false);
  });

  it('refuses qualifiedFor combined with status=SUSPENDED', () => {
    // A contradiction: a suspended supplier is never currently qualified. The
    // honest answer is a 400 saying so, not an empty page the caller has to
    // interpret — and not one filter silently overwriting the other.
    const result = searchSuppliersQuerySchema.safeParse({
      qualifiedFor: 'WORKSHOP_SERVICE',
      status: 'SUSPENDED',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/never currently qualified/);
  });

  it('allows qualifiedFor with status=ACTIVE, which is merely redundant', () => {
    expect(
      searchSuppliersQuerySchema.safeParse({ qualifiedFor: 'WORKSHOP_SERVICE', status: 'ACTIVE' })
        .success,
    ).toBe(true);
  });
});

describe('ListQualifiedFor', () => {
  it('requires the capability', () => {
    // "List everyone qualified" is a different query with a different cost. A
    // caller who forgot the filter gets a 400 rather than the whole directory.
    expect(listQualifiedForQuerySchema.safeParse({}).success).toBe(false);
  });

  it('accepts a capability with pagination', () => {
    const parsed = listQualifiedForQuerySchema.parse({
      capability: 'WORKSHOP_SERVICE',
      limit: '10',
    });

    expect(parsed).toEqual({ capability: 'WORKSHOP_SERVICE', limit: 10 });
  });
});

describe('the review queue query', () => {
  it('defaults to the submissions awaiting a decision', () => {
    // The queue a reviewer opens is the one with work in it.
    expect(reviewQueueQuerySchema.parse({}).state).toBe('SUBMITTED');
  });

  it('allows looking back at decided submissions', () => {
    expect(reviewQueueQuerySchema.parse({ state: 'REJECTED' }).state).toBe('REJECTED');
  });

  it('refuses a state outside the machine', () => {
    expect(reviewQueueQuerySchema.safeParse({ state: 'EXPIRED' }).success).toBe(false);
  });
});
