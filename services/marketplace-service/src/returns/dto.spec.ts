import { createReturnSchema, decideReturnSchema, listReturnsQuerySchema } from './dto';

const valid = {
  reason: 'The pump housing arrived cracked',
  lines: [{ orderLineId: 'OLN_1', quantity: 2 }],
};

describe('a return request carries no money and no status', () => {
  it('accepts an order, a reason and lines', () => {
    expect(createReturnSchema.parse(valid).lines).toEqual([{ orderLineId: 'OLN_1', quantity: 2 }]);
  });

  it.each([
    ['refundAmountMinor', { refundAmountMinor: '1' }],
    ['status', { status: 'AUTHORIZED' }],
    ['orderId (the order is the path)', { orderId: 'ORD_01JBQ0000000000000000000AB' }],
    ['supplierOrganizationId', { supplierOrganizationId: 'ORG-OTHER' }],
  ])('refuses %s at the top level — refused, not ignored', (_name, extra) => {
    expect(createReturnSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
  });

  it('refuses a price on a line', () => {
    const lines = [{ orderLineId: 'OLN_1', quantity: 1, unitPriceMinor: '5' }];
    expect(createReturnSchema.safeParse({ ...valid, lines }).success).toBe(false);
  });

  it('needs at least one line and refuses a line twice', () => {
    expect(createReturnSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
    const twice = [
      { orderLineId: 'OLN_1', quantity: 1 },
      { orderLineId: 'OLN_1', quantity: 1 },
    ];
    expect(createReturnSchema.safeParse({ ...valid, lines: twice }).success).toBe(false);
  });

  it.each([0, -1, 1.5, 1_000_001])('refuses the quantity %s', (quantity) => {
    const lines = [{ orderLineId: 'OLN_1', quantity }];
    expect(createReturnSchema.safeParse({ ...valid, lines }).success).toBe(false);
  });

  it('wants a reason of at least a sentence', () => {
    expect(createReturnSchema.safeParse({ ...valid, reason: 'broken' }).success).toBe(false);
    expect(createReturnSchema.safeParse({ ...valid, reason: 'x'.repeat(1001) }).success).toBe(
      false,
    );
  });

  it('refuses a reason made of control or bidi-override characters', () => {
    const reason = 'The pump arrived ‮cracked, send money';
    expect(createReturnSchema.safeParse({ ...valid, reason }).success).toBe(false);
  });
});

describe('a decision is one of two words, nothing else', () => {
  it('accepts AUTHORIZE and REJECT', () => {
    expect(decideReturnSchema.parse({ decision: 'AUTHORIZE' }).decision).toBe('AUTHORIZE');
    expect(decideReturnSchema.parse({ decision: 'REJECT' }).decision).toBe('REJECT');
  });

  it.each([
    [{}],
    [{ decision: 'CANCEL' }],
    [{ decision: 'REFUND' }],
    [{ decision: 'AUTHORIZE', refundAmountMinor: '1' }],
  ])('refuses %j', (body) => {
    expect(decideReturnSchema.safeParse(body).success).toBe(false);
  });
});

describe('listing return requests', () => {
  it('defaults to the buyer side and a page of 25', () => {
    expect(listReturnsQuerySchema.parse({})).toEqual({ role: 'BUYER', limit: 25 });
  });

  it('knows only the eight statuses and two roles', () => {
    expect(listReturnsQuerySchema.safeParse({ status: 'REFUNDED' }).success).toBe(false);
    // RUN-005 PR 3: the physical states are listed like the commercial ones.
    expect(listReturnsQuerySchema.safeParse({ status: 'RESOLVED' }).success).toBe(true);
    expect(listReturnsQuerySchema.safeParse({ status: 'IN_TRANSIT' }).success).toBe(true);
    expect(listReturnsQuerySchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
    expect(
      listReturnsQuerySchema.safeParse({ status: 'AUTHORIZED', role: 'SUPPLIER' }).success,
    ).toBe(true);
  });
});
