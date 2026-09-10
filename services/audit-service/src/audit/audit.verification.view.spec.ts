import {
  auditChainVerificationSchema,
  DIVERGENCE_REASONS,
  DIVERGENCE_REASON_VALUES,
  RESPONSE_CANONICAL_VERSION,
  VERIFICATION_SCOPES,
  VERIFICATION_STATUSES,
  type AuditChainMonthResult,
  type AuditChainVerification,
} from './audit.verification.view';
import { CANONICAL_VERSION } from './audit.canonical';
import { toJsonSchema } from '../openapi/zod-schema';

/**
 * The response contract, asserted as a set of refusals.
 *
 * Every rule here is a statement a caller acts on without reading the rest of
 * the object: an alerting rule reads `valid`, a runbook reads
 * `firstDivergence`, a dashboard sums the counts. A response that says
 * `valid: true` beside a `DIVERGENT` status is not a cosmetic defect — it is
 * the endpoint reporting the opposite of what it found — so the schema refuses
 * it at the boundary rather than trusting the construction that produced it.
 *
 * `AuditVerificationService` parses its own result through this schema before
 * returning, which is what makes these properties of the endpoint rather than
 * of one function staying correct.
 */

const month = (overrides: Partial<AuditChainMonthResult> = {}): AuditChainMonthResult => ({
  month: '2026-08',
  status: 'VALID',
  recordsInRange: 3,
  recordsVerified: 3,
  unchainedRecords: 0,
  seededFromPredecessor: false,
  ...overrides,
});

const response = (overrides: Partial<AuditChainVerification> = {}): unknown => ({
  scope: 'ORGANIZATION',
  organizationId: 'ORG-1',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-31T00:00:00.000Z',
  status: 'VALID',
  valid: true,
  canonicalVersion: CANONICAL_VERSION,
  recordsInRange: 3,
  recordsVerified: 3,
  unchainedRecords: 0,
  months: [month()],
  firstDivergence: null,
  ...overrides,
});

const divergence = {
  month: '2026-08',
  auditEventId: '01JAUDIT0000000000000003',
  occurredAt: '2026-08-03T12:00:00.000Z',
  sequenceNo: '3',
  reason: DIVERGENCE_REASONS.RECORD_HASH_MISMATCH,
};

const accepts = (value: unknown): boolean => auditChainVerificationSchema.safeParse(value).success;

describe('the four outcomes', () => {
  it('publishes exactly four, and two scopes', () => {
    expect([...VERIFICATION_STATUSES]).toEqual([
      'VALID',
      'EMPTY',
      'UNVERIFIABLE_LEGACY',
      'DIVERGENT',
    ]);
    expect([...VERIFICATION_SCOPES]).toEqual(['ORGANIZATION', 'PLATFORM']);
  });

  it('keeps the divergence reasons a closed set safe to use as a metric label', () => {
    // Never an error message: a message can carry a row value, and a metric
    // label is the last place a value should reach (ADR-053 § 13).
    expect(DIVERGENCE_REASON_VALUES).toEqual(Object.values(DIVERGENCE_REASONS));
    expect(new Set(DIVERGENCE_REASON_VALUES).size).toBe(DIVERGENCE_REASON_VALUES.length);
  });

  it('states the canonical version every response reports', () => {
    expect(RESPONSE_CANONICAL_VERSION).toBe(CANONICAL_VERSION);
  });
});

describe('`valid` is true for exactly one status', () => {
  it('accepts a valid window that says so', () => {
    expect(accepts(response())).toBe(true);
  });

  it('refuses `valid: true` beside any other status', () => {
    // The single most dangerous inconsistency this endpoint could publish.
    for (const status of ['EMPTY', 'UNVERIFIABLE_LEGACY', 'DIVERGENT'] as const) {
      expect(accepts(response({ status, valid: true }))).toBe(false);
    }
  });

  it('refuses `valid: false` on a VALID window', () => {
    expect(accepts(response({ valid: false }))).toBe(false);
  });
});

describe('a divergence is reported exactly where there is one', () => {
  it('accepts a DIVERGENT window that names where', () => {
    expect(
      accepts(
        response({
          status: 'DIVERGENT',
          valid: false,
          months: [month({ status: 'DIVERGENT', recordsVerified: 2 })],
          recordsVerified: 2,
          firstDivergence: divergence,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a DIVERGENT window that names nowhere', () => {
    expect(accepts(response({ status: 'DIVERGENT', valid: false }))).toBe(false);
  });

  it('refuses a divergence on a window that did not diverge', () => {
    for (const status of ['VALID', 'EMPTY', 'UNVERIFIABLE_LEGACY'] as const) {
      expect(
        accepts(response({ status, valid: status === 'VALID', firstDivergence: divergence })),
      ).toBe(false);
    }
  });

  it('refuses a reason outside the closed set', () => {
    expect(
      accepts(
        response({
          status: 'DIVERGENT',
          valid: false,
          months: [month({ status: 'DIVERGENT' })],
          firstDivergence: { ...divergence, reason: 'SOMETHING_ELSE' } as unknown as never,
        }),
      ),
    ).toBe(false);
  });

  it('refuses a divergence reported anywhere but the last month walked', () => {
    // The walk stops at the first divergence, so a divergence in an earlier
    // month than the last one reported means months were walked past it.
    expect(
      accepts(
        response({
          status: 'DIVERGENT',
          valid: false,
          months: [month({ status: 'DIVERGENT' }), month({ month: '2026-09' })],
          firstDivergence: divergence,
        }),
      ),
    ).toBe(false);
  });

  it('refuses more than one divergent month', () => {
    expect(
      accepts(
        response({
          status: 'DIVERGENT',
          valid: false,
          months: [
            month({ status: 'DIVERGENT' }),
            month({ month: '2026-09', status: 'DIVERGENT' }),
          ],
          recordsInRange: 6,
          recordsVerified: 6,
          firstDivergence: { ...divergence, month: '2026-09' },
        }),
      ),
    ).toBe(false);
  });
});

describe('the counts', () => {
  it('refuses a negative count anywhere', () => {
    expect(accepts(response({ recordsInRange: -1 }))).toBe(false);
    expect(accepts(response({ recordsVerified: -1 }))).toBe(false);
    expect(accepts(response({ unchainedRecords: -1 }))).toBe(false);
    expect(accepts(response({ months: [month({ recordsVerified: -1 })] }))).toBe(false);
  });

  it('refuses a total that is not the sum of its months', () => {
    // A summary that does not add up would let a partial walk look complete.
    expect(
      accepts(
        response({
          months: [month(), month({ month: '2026-09' })],
          recordsInRange: 3,
          recordsVerified: 6,
        }),
      ),
    ).toBe(false);
  });

  it('accepts totals that do add up across months', () => {
    expect(
      accepts(
        response({
          months: [month(), month({ month: '2026-09' })],
          recordsInRange: 6,
          recordsVerified: 6,
        }),
      ),
    ).toBe(true);
  });

  it('refuses a non-integer count', () => {
    expect(accepts(response({ recordsVerified: 2.5, recordsInRange: 2.5 }))).toBe(false);
  });
});

describe('a status that contradicts its own window', () => {
  it('refuses VALID beside an unchained record', () => {
    // The narrowness of `UNVERIFIABLE_LEGACY` is a security property: a window
    // holding a record nothing could recompute is not a verified window.
    expect(
      accepts(response({ unchainedRecords: 1, months: [month({ unchainedRecords: 1 })] })),
    ).toBe(false);
  });

  it('refuses UNVERIFIABLE_LEGACY with nothing unchained in it', () => {
    expect(accepts(response({ status: 'UNVERIFIABLE_LEGACY', valid: false }))).toBe(false);
  });

  it('refuses EMPTY over a window that held records', () => {
    expect(accepts(response({ status: 'EMPTY', valid: false }))).toBe(false);
  });

  it('accepts an EMPTY window whose months are empty too', () => {
    expect(
      accepts(
        response({
          status: 'EMPTY',
          valid: false,
          recordsInRange: 0,
          recordsVerified: 0,
          months: [month({ status: 'EMPTY', recordsInRange: 0, recordsVerified: 0 })],
        }),
      ),
    ).toBe(true);
  });

  it('refuses a window status that disagrees with its months', () => {
    expect(
      accepts(response({ months: [month({ status: 'DIVERGENT' })], firstDivergence: null })),
    ).toBe(false);
  });
});

describe('the chain a response says it verified', () => {
  it('requires a null organization for exactly the platform scope', () => {
    expect(accepts(response({ scope: 'PLATFORM' }))).toBe(false);
    expect(accepts(response({ scope: 'PLATFORM', organizationId: null }))).toBe(true);
    expect(accepts(response({ organizationId: null }))).toBe(false);
  });

  it('refuses a window whose end precedes its start', () => {
    expect(accepts(response({ to: '2026-07-01T00:00:00.000Z' }))).toBe(false);
  });

  it('requires an offset on both boundaries', () => {
    expect(accepts(response({ from: '2026-08-01T00:00:00' }))).toBe(false);
  });

  it('refuses a month label that is not YYYY-MM', () => {
    expect(accepts(response({ months: [month({ month: '2026-08-01' })] }))).toBe(false);
  });

  it('refuses an unpublished field, so a hash cannot be added by accident', () => {
    // `.strict()`. A digest tells a caller nothing they can act on and gives
    // anyone allowed to call verify a stable fingerprint of a record's exact
    // contents — a wider disclosure than the record itself, for no gain.
    expect(accepts({ ...(response() as object), headHash: 'ab'.repeat(32) })).toBe(false);
    expect(accepts({ ...(response() as object), payload: {} })).toBe(false);
  });
});

describe('what the OpenAPI document publishes for it', () => {
  it('describes every field of the response, through the effects wrapper', () => {
    // The schema carries cross-field rules, which makes it a `ZodEffects` and
    // not a plain object. The converter unwraps those; if it ever stopped, the
    // document would publish an empty body for this endpoint and a generated
    // client would have nothing to bind to.
    const published = toJsonSchema(auditChainVerificationSchema) as {
      type?: string;
      properties?: Record<string, unknown>;
    };

    expect(published.type).toBe('object');
    expect(Object.keys(published.properties ?? {}).sort()).toEqual(
      [
        'canonicalVersion',
        'firstDivergence',
        'from',
        'months',
        'organizationId',
        'recordsInRange',
        'recordsVerified',
        'scope',
        'status',
        'to',
        'unchainedRecords',
        'valid',
      ].sort(),
    );
  });

  it('publishes no hash or payload field for a client to expect', () => {
    const published = JSON.stringify(toJsonSchema(auditChainVerificationSchema));

    expect(published).not.toContain('Hash');
    expect(published).not.toContain('payload');
  });
});
