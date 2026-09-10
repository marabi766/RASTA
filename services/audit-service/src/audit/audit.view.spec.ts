import {
  auditEventPageSchema,
  auditEventViewSchema,
  toAuditEventView,
  type AuditEventRow,
} from './audit.view';

/**
 * What leaves the service, asserted against the schema the OpenAPI document is
 * generated from — so the contract and the mapper cannot drift.
 *
 * The 64-bit fields are the reason this file exists. `JSON.stringify` throws on
 * a native `bigint`, and the shim people reach for emits a JSON *number*, which
 * silently loses precision above 2^53 in every ordinary client. AGENTS.md § 3
 * settles it for money and the same reasoning applies to any 64-bit integer a
 * client may compare or echo back.
 */

const OCCURRED_AT = new Date('2026-09-05T10:00:00.000Z');
const RECORDED_AT = new Date('2026-09-05T10:00:02.500Z');

function row(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: '01JAUDIT0000000000000001',
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
    actorType: 'USER',
    actorId: 'USR-1',
    actorRoles: [],
    organizationId: 'ORG-1',
    action: 'asset.decommissioned',
    resourceType: 'Asset',
    resourceId: 'AST-1',
    outcome: 'SUCCESS',
    errorCode: null,
    reason: null,
    changes: null,
    occurrenceCount: 1,
    sourceService: 'asset-service',
    sourceServiceVersion: '1.0.0',
    sourceEventId: '01JEVENT0000000000000001',
    sourceEventName: 'ASSET_DECOMMISSIONED',
    sourceTopic: 'rasta.asset.v1',
    sourceIp: null,
    sourceUserAgent: null,
    correlationId: 'corr-1',
    causationId: null,
    traceparent: null,
    sourceStreamSeq: null,
    sequenceNo: 1n,
    ...overrides,
  };
}

describe('the audit record a caller receives', () => {
  it('matches the published schema exactly', () => {
    // `.strict()`, so an added column that nobody documented fails here rather
    // than appearing in a response the contract does not describe.
    expect(auditEventViewSchema.safeParse(toAuditEventView(row())).success).toBe(true);
  });

  it('serialises both 64-bit columns as strings', () => {
    const view = toAuditEventView(
      row({ sequenceNo: 9007199254740993n, sourceStreamSeq: 9007199254740995n }),
    );

    expect(view.sequenceNo).toBe('9007199254740993');
    expect(view.sourceStreamSeq).toBe('9007199254740995');
  });

  it('keeps a value a JSON number could not hold', () => {
    // The negative control for the `toJSON` shim, stated without ever writing
    // the value as a `number` literal — the source text `9007199254740993`
    // *is itself* rounded to 9007199254740992 by the parser, so an assertion
    // against it would compare two rounded values and pass for the wrong
    // reason. The comparison is therefore made in `bigint`, which is exact.
    const view = toAuditEventView(row({ sequenceNo: 9007199254740993n }));

    // The string survives the round trip exactly.
    expect(view.sequenceNo).toBe('9007199254740993');
    expect(BigInt(view.sequenceNo)).toBe(9007199254740993n);

    // Routing it through `number` — which is what a JSON numeric encoding
    // would do — loses the record's position to a neighbour's.
    const throughNumber = Number(view.sequenceNo);
    expect(Number.isSafeInteger(throughNumber)).toBe(false);
    expect(BigInt(throughNumber)).not.toBe(9007199254740993n);
    expect(BigInt(throughNumber)).toBe(9007199254740992n);
  });

  it('survives JSON serialisation, which a bigint does not', () => {
    expect(() => JSON.stringify(toAuditEventView(row()))).not.toThrow();
    expect(() => JSON.stringify({ sequenceNo: 1n })).toThrow(TypeError);
  });

  it('keeps a null stream sequence null rather than turning it into "null"', () => {
    expect(toAuditEventView(row({ sourceStreamSeq: null })).sourceStreamSeq).toBeNull();
  });

  it('renders both instants as ISO strings with an offset', () => {
    const view = toAuditEventView(row());

    expect(view.occurredAt).toBe('2026-09-05T10:00:00.000Z');
    expect(view.recordedAt).toBe('2026-09-05T10:00:02.500Z');
  });

  it('publishes an explicit null for a record with no changes', () => {
    // A missing key and an explicit null are different claims to a client, and
    // `undefined` would drop the key from the body entirely.
    const view = toAuditEventView(row({ changes: undefined }));

    expect(view.changes).toBeNull();
    expect('changes' in view).toBe(true);
  });

  it('keeps the null organization of a platform-scoped record', () => {
    // Only a SYSTEM_ADMIN ever sees one, and the mapper must not invent a
    // tenant for it.
    expect(toAuditEventView(row({ organizationId: null })).organizationId).toBeNull();
  });

  it('publishes no integrity or correction field', () => {
    // AUD-003 and AUD-007. Two permanently null fields would tell a client that
    // verification exists here and returned "nothing wrong".
    const view = toAuditEventView(row()) as Record<string, unknown>;

    expect(view).not.toHaveProperty('recordHash');
    expect(view).not.toHaveProperty('previousHash');
    expect(view).not.toHaveProperty('correctionOf');
  });
});

describe('one page of records', () => {
  it('accepts a page that has another behind it', () => {
    const page = {
      items: [toAuditEventView(row())],
      nextCursor: 'b3BhcXVl',
      hasMore: true,
    };
    expect(auditEventPageSchema.safeParse(page).success).toBe(true);
  });

  it('accepts an empty last page', () => {
    expect(
      auditEventPageSchema.safeParse({ items: [], nextCursor: null, hasMore: false }).success,
    ).toBe(true);
  });

  it('refuses a page that omits the cursor field rather than nulling it', () => {
    // A client distinguishes "no more pages" from "the server forgot"; only one
    // of those is a fact.
    expect(auditEventPageSchema.safeParse({ items: [], hasMore: false }).success).toBe(false);
  });
});
