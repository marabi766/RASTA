import {
  cancelTenderSchema,
  createTenderSchema,
  listTendersQuerySchema,
  updateTenderSchema,
} from './dto';

/**
 * The boundary of the tender commands: what a client may send, and what it may
 * not (ADR-065 § 2, `.strict()` as a security control).
 */

const OPEN = '2026-11-01T08:00:00Z';
const CLOSE = '2026-11-30T20:30:00Z';
const BASE = { title: 'Road resurfacing', scopeOfWork: 'Two kilometres of the main road' };

describe('createTenderSchema', () => {
  it('accepts a bare draft: nature, visibility and window are chosen later, never defaulted', () => {
    const parsed = createTenderSchema.parse(BASE);
    expect(parsed).toEqual(BASE);
    expect(parsed).not.toHaveProperty('procurementNature');
    expect(parsed).not.toHaveProperty('visibility');
  });

  it('accepts a full draft', () => {
    expect(
      createTenderSchema.safeParse({
        ...BASE,
        procurementNature: 'FORMAL_TENDER',
        visibility: 'RESTRICTED',
        bidOpeningAt: OPEN,
        bidClosingAt: CLOSE,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['organizationId', 'ORG_X'],
    ['status', 'PUBLISHED'],
    ['version', 5],
    ['createdBy', 'USR_9'],
    ['openedAt', OPEN],
  ])('refuses %s in the body: it is decided by the token or the lifecycle', (field, value) => {
    expect(createTenderSchema.safeParse({ ...BASE, [field]: value }).success).toBe(false);
  });

  it('refuses a nature outside the four of docs/03', () => {
    expect(createTenderSchema.safeParse({ ...BASE, procurementNature: 'AUCTION' }).success).toBe(
      false,
    );
  });

  it.each([
    ['an offset', '2026-11-30T20:30:00+03:30'],
    ['no zone', '2026-11-30T20:30:00'],
    ['a date only', '2026-11-30'],
    ['prose', 'next Monday'],
  ])('refuses a deadline written with %s: a deadline has one reading (UTC, Z)', (_label, value) => {
    expect(
      createTenderSchema.safeParse({ ...BASE, bidOpeningAt: OPEN, bidClosingAt: value }).success,
    ).toBe(false);
  });

  it('refuses a window that is not a window: opening must precede closing', () => {
    expect(
      createTenderSchema.safeParse({ ...BASE, bidOpeningAt: CLOSE, bidClosingAt: OPEN }).success,
    ).toBe(false);
    expect(
      createTenderSchema.safeParse({ ...BASE, bidOpeningAt: OPEN, bidClosingAt: OPEN }).success,
    ).toBe(false);
  });

  it('refuses half a window', () => {
    expect(createTenderSchema.safeParse({ ...BASE, bidOpeningAt: OPEN }).success).toBe(false);
    expect(createTenderSchema.safeParse({ ...BASE, bidClosingAt: CLOSE }).success).toBe(false);
  });

  it('trims and bounds the text', () => {
    expect(createTenderSchema.parse({ ...BASE, title: '  Road  ' }).title).toBe('Road');
    expect(createTenderSchema.safeParse({ ...BASE, title: 'x' }).success).toBe(false);
    expect(createTenderSchema.safeParse({ ...BASE, scopeOfWork: 'y'.repeat(20_001) }).success).toBe(
      false,
    );
  });
});

describe('updateTenderSchema', () => {
  it('needs the version and at least one field', () => {
    expect(updateTenderSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateTenderSchema.safeParse({ title: 'New' }).success).toBe(false);
    expect(updateTenderSchema.safeParse({ expectedVersion: 1, title: 'New' }).success).toBe(true);
  });

  it('clears the nature, the visibility, or the whole window with null', () => {
    expect(
      updateTenderSchema.safeParse({
        expectedVersion: 2,
        procurementNature: null,
        visibility: null,
        bidOpeningAt: null,
        bidClosingAt: null,
      }).success,
    ).toBe(true);
  });

  it('never clears or sets half a window', () => {
    expect(updateTenderSchema.safeParse({ expectedVersion: 2, bidOpeningAt: null }).success).toBe(
      false,
    );
    expect(
      updateTenderSchema.safeParse({ expectedVersion: 2, bidOpeningAt: OPEN, bidClosingAt: null })
        .success,
    ).toBe(false);
    expect(updateTenderSchema.safeParse({ expectedVersion: 2, bidClosingAt: CLOSE }).success).toBe(
      false,
    );
  });

  it('refuses a status or an owner in the body', () => {
    expect(
      updateTenderSchema.safeParse({ expectedVersion: 1, title: 'New', status: 'AWARDED' }).success,
    ).toBe(false);
    expect(
      updateTenderSchema.safeParse({ expectedVersion: 1, title: 'New', organizationId: 'O' })
        .success,
    ).toBe(false);
  });
});

describe('cancelTenderSchema and listTendersQuerySchema', () => {
  it('requires a stated reason of at least eight characters', () => {
    expect(cancelTenderSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(cancelTenderSchema.safeParse({ expectedVersion: 1, reason: 'short' }).success).toBe(
      false,
    );
    expect(
      cancelTenderSchema.safeParse({ expectedVersion: 1, reason: 'Funding was withdrawn' }).success,
    ).toBe(true);
  });

  it('filters by a lifecycle state and refuses any other', () => {
    expect(listTendersQuerySchema.safeParse({ status: 'CLOSED' }).success).toBe(true);
    expect(listTendersQuerySchema.safeParse({ status: 'BID_OPEN' }).success).toBe(false);
  });
});
