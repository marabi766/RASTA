import { encodeAuditCursor } from './audit.cursor';
import {
  auditEventIdSchema,
  buildAuditEventDetailQuerySchema,
  buildAuditEventQuerySchema,
  buildAuditVerifyQuerySchema,
  DEFAULT_MAX_QUERY_WINDOW_DAYS,
  DEFAULT_MAX_VERIFICATION_RECORDS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  VERIFY_SCOPES,
} from './audit.query.dto';

/**
 * The boundary rules, asserted where they are enforced.
 *
 * The mandatory window is the one that matters most and it is not a nicety:
 * `audit_event` is partitioned monthly across years, so an unbounded range
 * scans every partition. ADR-053 § 10 calls that an accidental denial of
 * service and requires a `400` that **names the configured limit** rather than
 * a silent truncation.
 */

const schema = buildAuditEventQuerySchema();
const detailSchema = buildAuditEventDetailQuerySchema();

const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-31T00:00:00.000Z';

const parse = (query: Record<string, unknown>) => schema.safeParse(query);

const messagesOf = (result: ReturnType<typeof parse>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

const pathsOf = (result: ReturnType<typeof parse>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));

describe('the mandatory window', () => {
  it('accepts a well-formed window', () => {
    const result = parse({ from: FROM, to: TO });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from.toISOString()).toBe(FROM);
      expect(result.data.to.toISOString()).toBe(TO);
    }
  });

  it('refuses a query with no window at all', () => {
    expect(pathsOf(parse({})).sort()).toEqual(['from', 'to']);
  });

  it.each([['from'], ['to']])('refuses a query missing %s', (missing) => {
    const query: Record<string, unknown> = { from: FROM, to: TO };
    delete query[missing];
    expect(pathsOf(parse(query))).toContain(missing);
  });

  it('refuses a boundary with no timezone offset, which is not an instant', () => {
    expect(parse({ from: '2026-08-01T00:00:00', to: TO }).success).toBe(false);
  });

  it('refuses `to` earlier than `from`', () => {
    expect(messagesOf(parse({ from: TO, to: FROM }))).toEqual([
      '`to` must not be earlier than `from`',
    ]);
  });

  it('reports a reversed window once, not also as too wide', () => {
    // Both would be true; the second would be noise on top of the real problem.
    expect(messagesOf(parse({ from: '2027-01-01T00:00:00.000Z', to: FROM }))).toHaveLength(1);
  });

  it('accepts a window exactly at the ceiling', () => {
    expect(
      parse({ from: '2026-06-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }).success,
    ).toBe(true);
  });

  it('refuses a window one day wider than the ceiling, naming the limit', () => {
    const messages = messagesOf(
      parse({ from: '2026-05-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`${DEFAULT_MAX_QUERY_WINDOW_DAYS} days`);
    expect(messages[0]).toContain('AUDIT_MAX_QUERY_WINDOW_DAYS');
  });

  it('names the configured ceiling rather than the default', () => {
    // An operator who lowered the ceiling must not get a 400 quoting a number
    // their deployment does not use.
    const narrow = buildAuditEventQuerySchema(7);
    const result = narrow.safeParse({ from: FROM, to: TO });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('7 days');
      expect(result.error.issues[0]?.message).not.toContain('90 days');
    }
  });

  it('applies the same ceiling to the detail endpoint', () => {
    // The detail lookup needs the window for a different reason — the composite
    // identity `(occurred_at, id)` means an id alone scans every partition —
    // but the ceiling is the same one.
    expect(detailSchema.safeParse({}).success).toBe(false);
    expect(
      detailSchema.safeParse({ from: '2026-05-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' })
        .success,
    ).toBe(false);
    expect(detailSchema.safeParse({ from: FROM, to: TO }).success).toBe(true);
  });
});

describe('paging', () => {
  it('defaults the page size to the platform default', () => {
    const result = parse({ from: FROM, to: TO });
    expect(result.success && result.data.limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('accepts the maximum', () => {
    const result = parse({ from: FROM, to: TO, limit: String(MAX_PAGE_LIMIT) });
    expect(result.success && result.data.limit).toBe(MAX_PAGE_LIMIT);
  });

  it('refuses a page size above the maximum rather than clamping it', () => {
    expect(parse({ from: FROM, to: TO, limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
  });

  it.each([['0'], ['-1'], ['1.5'], ['many']])('refuses limit=%s', (limit) => {
    expect(parse({ from: FROM, to: TO, limit }).success).toBe(false);
  });

  it('decodes a valid cursor into a position', () => {
    const cursor = encodeAuditCursor({ occurredAt: new Date(TO), id: '01JABC' });
    const result = parse({ from: FROM, to: TO, cursor });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cursor?.id).toBe('01JABC');
      expect(result.data.cursor?.occurredAt.toISOString()).toBe(TO);
    }
  });

  it('refuses a malformed cursor as a validation failure on `cursor`', () => {
    const result = parse({ from: FROM, to: TO, cursor: 'not-a-cursor' });
    expect(pathsOf(result)).toEqual(['cursor']);
  });
});

describe('filters', () => {
  it('accepts the documented search fields', () => {
    const result = parse({
      from: FROM,
      to: TO,
      organizationId: 'ORG-1',
      actorId: 'USR-1',
      actorType: 'USER',
      action: 'ASSET_DECOMMISSIONED',
      resourceType: 'Asset',
      resourceId: 'AST-1',
      correlationId: 'corr-1',
      outcome: 'SUCCESS',
    });
    expect(result.success).toBe(true);
  });

  it('refuses `resourceId` without `resourceType`', () => {
    // The resource index is composite. A bare `resourceId` is the one filter
    // here that would read as indexed and be a scan.
    expect(pathsOf(parse({ from: FROM, to: TO, resourceId: 'AST-1' }))).toEqual(['resourceType']);
  });

  it('refuses an unknown parameter rather than ignoring it', () => {
    // Dropping it silently would answer a narrower question than the one asked
    // while looking like it had answered the right one.
    expect(parse({ from: FROM, to: TO, organisationId: 'ORG-1' }).success).toBe(false);
  });

  it('refuses a value out of the enum', () => {
    expect(parse({ from: FROM, to: TO, outcome: 'MAYBE' }).success).toBe(false);
    expect(parse({ from: FROM, to: TO, actorType: 'ROBOT' }).success).toBe(false);
  });

  it('refuses a filter longer than the column it is compared against', () => {
    expect(parse({ from: FROM, to: TO, organizationId: 'O'.repeat(129) }).success).toBe(false);
    expect(parse({ from: FROM, to: TO, actorId: 'A'.repeat(257) }).success).toBe(false);
  });

  it('refuses a blank filter, which is not a filter', () => {
    expect(parse({ from: FROM, to: TO, organizationId: '   ' }).success).toBe(false);
  });

  it('reports every problem at once', () => {
    // One 400 listing everything, rather than one problem per round trip.
    expect(pathsOf(parse({ outcome: 'MAYBE' })).sort()).toEqual(['from', 'outcome', 'to']);
  });

  it('offers no sort or free-text parameter', () => {
    expect(parse({ from: FROM, to: TO, orderBy: 'recordedAt' }).success).toBe(false);
    expect(parse({ from: FROM, to: TO, q: 'anything' }).success).toBe(false);
  });
});

describe('the path parameter', () => {
  it('accepts a ULID', () => {
    expect(auditEventIdSchema.safeParse('01JB0V5W0000000000000000A').success).toBe(true);
  });

  it.each([[''], ['A'.repeat(65)], ["' OR 1=1 --"], ['../../etc/passwd'], ['a b']])(
    'refuses %s',
    (id) => {
      expect(auditEventIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe('the verification query', () => {
  const verifySchema = buildAuditVerifyQuerySchema();

  const parseVerify = (query: Record<string, unknown>) => verifySchema.safeParse(query);

  const verifyPaths = (result: ReturnType<typeof parseVerify>): string[] =>
    result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));

  it('defaults to the organization scope', () => {
    // The default is the narrow one. A default of PLATFORM would mean a
    // caller who omitted the parameter was asking for the records that have no
    // tenant, which ADR-053 § 10 reserves to SYSTEM_ADMIN.
    const result = parseVerify({ from: FROM, to: TO });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe('ORGANIZATION');
      expect(result.data.organizationId).toBeUndefined();
    }
  });

  it('publishes exactly the two chain families', () => {
    expect([...VERIFY_SCOPES]).toEqual(['ORGANIZATION', 'PLATFORM']);
  });

  it('parses both boundaries into instants', () => {
    const result = parseVerify({ from: FROM, to: TO, organizationId: 'ORG-1' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from.toISOString()).toBe(FROM);
      expect(result.data.to.toISOString()).toBe(TO);
      expect(result.data.organizationId).toBe('ORG-1');
    }
  });

  it('requires the window, like every other audit query', () => {
    // Verification walks every chain position the window touches, so an
    // unbounded range is not a slow query — it is a full read of the store.
    expect(verifyPaths(parseVerify({})).sort()).toEqual(['from', 'to']);
  });

  it('refuses a window wider than the configured ceiling, naming the number', () => {
    const narrow = buildAuditVerifyQuerySchema(7);
    const result = narrow.safeParse({ from: FROM, to: TO });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('7');
    }
  });

  it('refuses `to` earlier than `from`', () => {
    expect(parseVerify({ from: TO, to: FROM }).success).toBe(false);
  });

  it('refuses an organization named alongside the platform scope', () => {
    // Refused rather than ignored: a request that named both is a client that
    // believes one of the two is being honoured, and guessing which would be
    // answering a question nobody asked.
    expect(
      verifyPaths(parseVerify({ from: FROM, to: TO, scope: 'PLATFORM', organizationId: 'ORG-1' })),
    ).toContain('organizationId');
  });

  it('accepts the platform scope on its own', () => {
    expect(parseVerify({ from: FROM, to: TO, scope: 'PLATFORM' }).success).toBe(true);
  });

  it('refuses a scope outside the two', () => {
    expect(parseVerify({ from: FROM, to: TO, scope: 'EVERYTHING' }).success).toBe(false);
  });

  it('offers none of the search filters, so a caller cannot believe it narrowed', () => {
    // A verification is over a whole chain segment. A filter here would look
    // like it verified a subset, which is not a thing a hash chain can do.
    for (const extra of ['actorId', 'action', 'resourceType', 'outcome', 'cursor', 'limit']) {
      expect(parseVerify({ from: FROM, to: TO, [extra]: 'anything' }).success).toBe(false);
    }
  });

  it('refuses an organization identifier longer than the column', () => {
    expect(parseVerify({ from: FROM, to: TO, organizationId: 'O'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('publishes a record ceiling default that is separate from the window ceiling', () => {
    // The window bounds the time a verification covers; this bounds the work,
    // and a busy tenant writes more in a day than a quiet one does in a
    // quarter.
    expect(DEFAULT_MAX_VERIFICATION_RECORDS).toBe(100_000);
    expect(DEFAULT_MAX_VERIFICATION_RECORDS).not.toBe(DEFAULT_MAX_QUERY_WINDOW_DAYS);
  });
});
