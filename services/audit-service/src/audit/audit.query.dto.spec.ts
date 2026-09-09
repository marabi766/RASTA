import { encodeAuditCursor } from './audit.cursor';
import {
  auditEventIdSchema,
  buildAuditEventDetailQuerySchema,
  buildAuditEventQuerySchema,
  DEFAULT_MAX_QUERY_WINDOW_DAYS,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
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
