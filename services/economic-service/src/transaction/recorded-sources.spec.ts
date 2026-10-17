import { createTransactionSchema } from './dto';
import {
  ECONOMIC_RECORDED_SOURCE_TYPES,
  isEconomicRecordedSource,
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

  it('compares exactly: the unique key does too', () => {
    expect(isEconomicRecordedSource('MAINTENANCE_REQUEST')).toBe(true);
    expect(isEconomicRecordedSource('Maintenance_Request')).toBe(false);
  });
});
