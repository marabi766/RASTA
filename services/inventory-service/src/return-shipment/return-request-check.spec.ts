import type { RastaError } from '@rasta/nest-common';
import type { CreateReturnShipmentDto } from './dto';
import { assertShipmentMatchesRequest } from './return-request-check';
import type { ReturnRequestFact } from './return-request-source';

const SUPPLIER = 'ORG_SUPPLIER';
const BUYER = 'ORG_BUYER';

const request = (change: Partial<ReturnRequestFact> = {}): ReturnRequestFact => ({
  returnRequestId: 'RET_1',
  orderId: 'ORD_1',
  buyerOrganizationId: BUYER,
  supplierOrganizationId: SUPPLIER,
  status: 'AUTHORIZED',
  lines: [
    { orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 3 },
    { orderLineId: 'OLN_B', productId: 'PRD_B', quantity: 2 },
  ],
  dispatchReservedAt: null,
  partialDispatchAllowed: false,
  ...change,
});

const dto = (change: Partial<CreateReturnShipmentDto> = {}): CreateReturnShipmentDto => ({
  returnRequestId: 'RET_1',
  orderId: 'ORD_1',
  buyerOrganizationId: BUYER,
  destinationWarehouseId: 'WHS_1',
  lines: [
    { orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 3 },
    { orderLineId: 'OLN_B', productId: 'PRD_B', quantity: 2 },
  ],
  ...change,
});

/** The refusal thrown, as the client reads it: top-level code and the closed reason. */
function refusalOf(run: () => void): { code: string; reason: string | undefined } {
  try {
    run();
  } catch (error) {
    const refused = error as RastaError;
    return { code: refused.code, reason: refused.details?.[0]?.code };
  }
  throw new Error('expected a refusal');
}

describe('assertShipmentMatchesRequest', () => {
  it('accepts a shipment that is exactly the authorized request', () => {
    expect(() => assertShipmentMatchesRequest(dto(), SUPPLIER, request())).not.toThrow();
  });

  it('treats a request of another supplier as not there (404), never as a mismatch', () => {
    expect(refusalOf(() => assertShipmentMatchesRequest(dto(), 'ORG_OTHER', request()))).toEqual({
      code: 'NOT_FOUND',
      reason: undefined,
    });
  });

  it.each(['REQUESTED', 'REJECTED', 'CANCELLED', 'IN_TRANSIT', 'RECEIVED', 'RESOLVED'])(
    'refuses a %s request as RETURN_REQUEST_NOT_AUTHORIZED',
    (status) => {
      expect(
        refusalOf(() => assertShipmentMatchesRequest(dto(), SUPPLIER, request({ status }))),
      ).toEqual({ code: 'BUSINESS_RULE_VIOLATION', reason: 'RETURN_REQUEST_NOT_AUTHORIZED' });
    },
  );

  it.each([
    ['another order', { orderId: 'ORD_2' }],
    ['another buyer', { buyerOrganizationId: 'ORG_ELSE' }],
  ])('refuses %s as RETURN_REQUEST_MISMATCH', (_name, change) => {
    expect(refusalOf(() => assertShipmentMatchesRequest(dto(change), SUPPLIER, request()))).toEqual(
      { code: 'BUSINESS_RULE_VIOLATION', reason: 'RETURN_REQUEST_MISMATCH' },
    );
  });

  const lines = {
    unknownLine: [
      { orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 3 },
      { orderLineId: 'OLN_X', productId: 'PRD_B', quantity: 2 },
    ],
    otherProduct: [
      { orderLineId: 'OLN_A', productId: 'PRD_Z', quantity: 3 },
      { orderLineId: 'OLN_B', productId: 'PRD_B', quantity: 2 },
    ],
    more: [
      { orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 4 },
      { orderLineId: 'OLN_B', productId: 'PRD_B', quantity: 2 },
    ],
    fewerUnits: [
      { orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 1 },
      { orderLineId: 'OLN_B', productId: 'PRD_B', quantity: 2 },
    ],
    fewerLines: [{ orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 3 }],
  };

  it.each(Object.entries(lines))(
    'refuses lines that are %s as RETURN_LINES_MISMATCH without a partial dispatch',
    (_name, changed) => {
      expect(
        refusalOf(() => assertShipmentMatchesRequest(dto({ lines: changed }), SUPPLIER, request())),
      ).toEqual({ code: 'BUSINESS_RULE_VIOLATION', reason: 'RETURN_LINES_MISMATCH' });
    },
  );

  it('with a partial dispatch allowed, accepts fewer lines or units — never another line, product or more', () => {
    const partial = request({ partialDispatchAllowed: true });
    for (const accepted of [lines.fewerUnits, lines.fewerLines]) {
      expect(() =>
        assertShipmentMatchesRequest(dto({ lines: accepted }), SUPPLIER, partial),
      ).not.toThrow();
    }
    for (const refused of [lines.unknownLine, lines.otherProduct, lines.more]) {
      expect(
        refusalOf(() => assertShipmentMatchesRequest(dto({ lines: refused }), SUPPLIER, partial)),
      ).toEqual({ code: 'BUSINESS_RULE_VIOLATION', reason: 'RETURN_LINES_MISMATCH' });
    }
  });
});
