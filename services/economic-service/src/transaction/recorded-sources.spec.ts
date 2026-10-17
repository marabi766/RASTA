import { createTransactionSchema } from './dto';
import {
  ECONOMIC_RECORDED_SOURCE_TYPES,
  isEconomicRecordedSource,
  mayRecordSource,
  OWNER_RECORDED_SOURCE_TYPES,
  RECORDED_SOURCE_REFUSAL,
} from './recorded-sources';

const body = (sourceType?: string) => ({
  transactionType: 'MAINTENANCE_SERVICE',
  counterpartyOrganizationId: 'ORG-PAYEE',
  grossAmountMinor: '1000',
  ...(sourceType === undefined ? {} : { sourceType, sourceReference: 'REF-1' }),
});

describe('source types economic-service records itself', () => {
  it('reserves exactly the types its own writers record', () => {
    expect(Object.values(ECONOMIC_RECORDED_SOURCE_TYPES).sort()).toEqual([
      'MAINTENANCE_REQUEST',
      'PAYMENT_INTENT',
      'STATEMENT',
    ]);
  });

  it.each(Object.values(ECONOMIC_RECORDED_SOURCE_TYPES))(
    'refuses %s on POST /v1/transactions, on sourceType, with a fixed text',
    (sourceType) => {
      for (const sent of [sourceType, ` ${sourceType} `]) {
        const parsed = createTransactionSchema.safeParse(body(sent));
        expect(parsed.success).toBe(false);
        const issues = parsed.error?.issues ?? [];
        expect(issues).toContainEqual(
          expect.objectContaining({
            code: 'custom',
            path: ['sourceType'],
            message: RECORDED_SOURCE_REFUSAL,
          }),
        );
        expect(issues.every((issue) => issue.path.join('.') === 'sourceType')).toBe(true);
      }
    },
  );

  it.each([undefined, 'ORDER', 'E2E', 'maintenance_request', 'MAINTENANCE_REQUESTS'])(
    'accepts %s as before',
    (sourceType) => {
      expect(createTransactionSchema.safeParse(body(sourceType)).success).toBe(true);
    },
  );

  describe('ORDER: marketplace-service’s alone, as a MARKETPLACE_ORDER', () => {
    const saga = { authType: 'SERVICE', callerService: 'marketplace-service' };

    it('admits marketplace-service, signed as itself, recording a MARKETPLACE_ORDER', () => {
      expect(OWNER_RECORDED_SOURCE_TYPES).toEqual({
        ORDER: { service: 'marketplace-service', transactionType: 'MARKETPLACE_ORDER' },
      });
      expect(mayRecordSource(saga, 'ORDER', 'MARKETPLACE_ORDER')).toBe(true);
    });

    it.each([
      ['a person', { authType: 'USER' }, 'MARKETPLACE_ORDER'],
      [
        'a person naming the service',
        { authType: 'USER', callerService: 'marketplace-service' },
        'MARKETPLACE_ORDER',
      ],
      [
        'a relayed request',
        { authType: 'RELAY', callerService: 'marketplace-service' },
        'MARKETPLACE_ORDER',
      ],
      [
        'contract-service',
        { authType: 'SERVICE', callerService: 'contract-service' },
        'MARKETPLACE_ORDER',
      ],
      [
        'procurement-service',
        { authType: 'SERVICE', callerService: 'procurement-service' },
        'MARKETPLACE_ORDER',
      ],
      ['a service with no name', { authType: 'SERVICE' }, 'MARKETPLACE_ORDER'],
      ['marketplace-service as another type', saga, 'LOGISTICS'],
    ])('refuses %s', (_who, caller, transactionType) => {
      expect(mayRecordSource(caller, 'ORDER', transactionType)).toBe(false);
    });

    it('leaves every other caller-owned type, and none, to every caller', () => {
      for (const sourceType of [undefined, 'E2E', 'order', 'SHIPMENT']) {
        expect(mayRecordSource({ authType: 'USER' }, sourceType, 'LOGISTICS')).toBe(true);
      }
    });

    it('still refuses the types economic-service records, even to marketplace-service', () => {
      for (const sourceType of Object.values(ECONOMIC_RECORDED_SOURCE_TYPES)) {
        expect(mayRecordSource(saga, sourceType, 'MARKETPLACE_ORDER')).toBe(false);
      }
    });
  });

  it('compares exactly: the unique key does too', () => {
    expect(isEconomicRecordedSource('MAINTENANCE_REQUEST')).toBe(true);
    expect(isEconomicRecordedSource('Maintenance_Request')).toBe(false);
  });
});
