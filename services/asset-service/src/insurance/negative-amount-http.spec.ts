import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { AssetController } from '../asset/asset.controller';
import { AssetService } from '../asset/asset.service';
import { IdempotencyStore } from '../asset/idempotency';
import { ClaimService } from './claim.service';
import { InsuranceService } from './insurance.service';
import { negativeAmountRefusal } from './negative-amount';

/**
 * A negative insurance amount at the HTTP boundary (audit L7-36), through the
 * real `AssetController` and its validation pipes.
 *
 *   - The API refuses it before any service runs: 400 `VALIDATION_FAILED` on
 *     the field, nothing written.
 *   - When the database is what refuses it (a write that reached it past the
 *     DTO), the service's answer reaches the client as the very same 400 —
 *     never a 500. `test/insurance-money.int-spec.ts` proves the service gives
 *     that answer against a real PostgreSQL; this proves the client sees it.
 */
describe('a negative insurance amount (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const insurance = { recordPolicy: jest.fn(), recordInspection: jest.fn() };
  const claims = { submitClaim: jest.fn(), decide: jest.fn() };
  const idempotency = { execute: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: {} },
        { provide: InsuranceService, useValue: insurance },
        { provide: ClaimService, useValue: claims },
        { provide: IdempotencyStore, useValue: idempotency },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter(QUIET_LOGGER as never));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    for (const mock of [...Object.values(insurance), ...Object.values(claims)]) {
      mock.mockReset().mockResolvedValue({ id: 'X_1' });
    }
    idempotency.execute
      .mockReset()
      .mockImplementation(
        async (
          _endpoint: string,
          _key: string,
          _body: unknown,
          _status: number,
          work: (f: object) => Promise<unknown>,
        ) => ({ result: await work({}) }),
      );
  });

  const POLICY = {
    policyNumber: 'POL-0001',
    insurerName: 'بیمه نمونه',
    coverage: 'THIRD_PARTY',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
  };
  const CLAIM = {
    policyId: 'INS_01J0000000000000000000000A',
    description: 'برخورد با مانع در جاده روستایی، آسیب به بدنه',
    incidentAt: '2026-01-02T00:00:00.000Z',
  };

  const ROUTES = [
    ['premiumMinor', '/v1/assets/AST_1/insurance-policies', POLICY, insurance.recordPolicy],
    ['insuredValueMinor', '/v1/assets/AST_1/insurance-policies', POLICY, insurance.recordPolicy],
    ['claimedAmountMinor', '/v1/assets/AST_1/insurance-claims', CLAIM, claims.submitClaim],
    [
      'approvedAmountMinor',
      '/v1/assets/AST_1/insurance-claims/CLM_1/decision',
      { decision: 'APPROVED' },
      claims.decide,
    ],
  ] as const;

  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(path).set('Idempotency-Key', 'record-key-0001').send(body);

  const ISSUE = (path: string) => ({
    path,
    code: 'invalid_string',
    message: 'Amount must be a non-negative integer string in minor units',
  });

  it.each(ROUTES)('the API refuses a negative %s at %s', async (field, path, body, service) => {
    const response = await post(path, { ...body, [field]: '-1' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details).toContainEqual(ISSUE(field));
    expect(service).not.toHaveBeenCalled();
  });

  it.each(ROUTES)(
    'a database refusal of %s reaches the client as the same 400 (%s)',
    async (field, path, body, service) => {
      const refusedByApi = await post(path, { ...body, [field]: '-1' });

      // The service got past the DTO and the database refused the amount.
      const constraint = {
        premiumMinor: 'ck_policy_premium_non_negative',
        insuredValueMinor: 'ck_policy_insured_value_non_negative',
        claimedAmountMinor: 'ck_claim_claimed_amount_non_negative',
        approvedAmountMinor: 'ck_claim_approved_amount_non_negative',
      }[field];
      service.mockRejectedValueOnce(
        negativeAmountRefusal({
          code: 'P2010',
          meta: { message: `violates check constraint "${constraint}"\nDETAIL: Failing row` },
        }),
      );
      const refusedByDatabase = await post(path, { ...body, [field]: '1' });

      expect(service).toHaveBeenCalledTimes(1);
      expect(refusedByDatabase.status).toBe(400);
      expect(refusedByDatabase.body.code).toBe('VALIDATION_FAILED');
      expect(refusedByDatabase.body.details).toEqual([ISSUE(field)]);
      // The API's own issue for the negative amount, verbatim. (The API also
      // adds a second, mistaken "exceeds the largest storable amount" issue for
      // a negative value — a pre-existing quirk of amountMinorSchema's bound
      // refinement in @rasta/contracts, outside this change.)
      expect(refusedByApi.body.details).toContainEqual(refusedByDatabase.body.details[0]);
      expect(JSON.stringify(refusedByDatabase.body)).not.toContain('Failing row');
    },
  );
});
