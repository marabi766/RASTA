import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { InsuranceService } from './insurance.service';
import type { AssetRepository } from '../asset/asset.repository';
import type { AssetService } from '../asset/asset.service';
import { INSURANCE_EVENTS } from '../asset/events';
import type { CreateInspectionDto, CreatePolicyDto } from '../asset/dto';

/**
 * Insurance and inspection.
 *
 * The behaviour worth pinning down is the part with consequences outside this
 * service: a failed inspection has to reach fleet-service as its own event, an
 * expiring policy has to be warned about before it lapses, and a policy that
 * has already expired must not be accepted as if the asset were covered.
 */

const DEH1 = 'ORG-DEH-0001';
const ASSET_ID = 'AST_01JASSET0000000000000001';
const day = 86_400_000;

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: DEH1,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['FLEET_MANAGER'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

interface Harness {
  service: InsuranceService;
  enqueued: Array<{ eventName: string; payload: Record<string, unknown> }>;
  appended: Array<Record<string, unknown>>;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const enqueued: Harness['enqueued'] = [];
  const appended: Harness['appended'] = [];

  const tx = {
    insurancePolicy: {
      create: jest.fn((args: { data: Record<string, unknown> }) => ({
        ...args.data,
        premiumMinor: args.data.premiumMinor ?? null,
        insuredValueMinor: args.data.insuredValueMinor ?? null,
      })),
    },
    technicalInspection: {
      create: jest.fn((args: { data: Record<string, unknown> }) => args.data),
    },
  };

  const repository = {
    client: {
      insurancePolicy: { findMany: jest.fn(async () => []) },
      technicalInspection: { findMany: jest.fn(async () => []) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    enqueueEvent: jest.fn(
      async (_tx: unknown, input: { eventName: string; payload: Record<string, unknown> }) => {
        enqueued.push({ eventName: input.eventName, payload: input.payload });
        return 'EVT_1';
      },
    ),
    findById: jest.fn(async () => ({ id: ASSET_ID, organizationId: DEH1 })),
    findPoliciesExpiringWithin: jest.fn(async () => []),
    findInspectionsExpiringWithin: jest.fn(async () => []),
    expireLapsedPolicies: jest.fn(async () => []),
    ...overrides,
  } as unknown as AssetRepository;

  const assets = {
    appendTimeline: jest.fn(async (_tx: unknown, entry: Record<string, unknown>) => {
      appended.push(entry);
    }),
  } as unknown as AssetService;

  return { service: new InsuranceService(repository, assets, 30), enqueued, appended };
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(context(), fn);

const POLICY: CreatePolicyDto = {
  policyNumber: 'POL-1',
  insurerName: 'بیمه نمونه',
  coverage: 'THIRD_PARTY',
  validFrom: new Date(Date.now() - 10 * day).toISOString(),
  validTo: new Date(Date.now() + 300 * day).toISOString(),
};

const INSPECTION: CreateInspectionDto = {
  certificateNo: 'C-1',
  inspectedAt: new Date(Date.now() - day).toISOString(),
  validTo: new Date(Date.now() + 300 * day).toISOString(),
  result: 'PASSED',
};

describe('InsuranceService', () => {
  describe('recording a policy', () => {
    it('publishes INSURANCE_RECORDED and adds a dossier line', async () => {
      const h = harness();
      const policy = await run(() => h.service.recordPolicy(ASSET_ID, POLICY));

      expect(policy.status).toBe('ACTIVE');
      expect(h.enqueued.map((e) => e.eventName)).toEqual([INSURANCE_EVENTS.INSURANCE_RECORDED]);
      expect(h.appended[0]).toMatchObject({ category: 'INSURANCE' });
    });

    it('refuses a policy that has already expired', async () => {
      // Accepting one would let an asset read as compliant while it is not.
      const h = harness();

      await expect(
        run(() =>
          h.service.recordPolicy(ASSET_ID, {
            ...POLICY,
            validFrom: new Date(Date.now() - 400 * day).toISOString(),
            validTo: new Date(Date.now() - day).toISOString(),
          }),
        ),
      ).rejects.toThrow(/already expired/);
    });

    it('puts the premium on the wire as a string', async () => {
      const h = harness();
      const policy = await run(() =>
        h.service.recordPolicy(ASSET_ID, { ...POLICY, premiumMinor: '4500000000' }),
      );

      // Rial premiums exceed 2^53 quickly; a JSON number would lose precision.
      expect(policy.premiumMinor).toBe('4500000000');
      expect(typeof policy.premiumMinor).toBe('string');
    });

    it('raises 404 for an asset the caller cannot see', async () => {
      const h = harness({ findById: jest.fn(async () => null) });
      await expect(run(() => h.service.recordPolicy(ASSET_ID, POLICY))).rejects.toThrow(RastaError);
    });
  });

  describe('recording an inspection', () => {
    it('publishes only INSPECTION_RECORDED when the asset passed', async () => {
      const h = harness();
      await run(() => h.service.recordInspection(ASSET_ID, INSPECTION));

      expect(h.enqueued.map((e) => e.eventName)).toEqual([INSURANCE_EVENTS.INSPECTION_RECORDED]);
    });

    it('publishes a separate INSPECTION_FAILED when the asset failed', async () => {
      // A failed inspection is a safety event: fleet-service has to stop
      // offering the machine for dispatch, and it should not have to inspect
      // the result field of a generic "recorded" event to find that out.
      const h = harness();
      await run(() =>
        h.service.recordInspection(ASSET_ID, {
          ...INSPECTION,
          result: 'FAILED',
          notes: 'ترمز ناایمن',
        }),
      );

      expect(h.enqueued.map((e) => e.eventName)).toEqual([
        INSURANCE_EVENTS.INSPECTION_RECORDED,
        INSURANCE_EVENTS.INSPECTION_FAILED,
      ]);
      expect(h.enqueued[1]?.payload.notes).toBe('ترمز ناایمن');
    });
  });

  describe('expiry sweep', () => {
    it('warns about a policy inside the window and says how long is left', async () => {
      const h = harness({
        findPoliciesExpiringWithin: jest.fn(async () => [
          {
            id: 'INS_1',
            assetId: ASSET_ID,
            organizationId: DEH1,
            insurerName: 'بیمه نمونه',
            validTo: new Date(Date.now() + 20 * day),
          },
        ]),
      });

      const result = await h.service.runExpirySweep();

      expect(result.warned).toBe(1);
      const warning = h.enqueued.find((e) => e.eventName === INSURANCE_EVENTS.INSURANCE_EXPIRING);
      // notification-service picks a template from this without recomputing
      // dates, so a 30-day and a 3-day reminder read differently.
      expect(warning?.payload.daysRemaining).toBe(20);
    });

    it('marks lapsed policies expired and announces it', async () => {
      const h = harness({
        expireLapsedPolicies: jest.fn(async () => [
          {
            id: 'INS_2',
            assetId: ASSET_ID,
            organizationId: DEH1,
            validTo: new Date(Date.now() - day),
          },
        ]),
      });

      const result = await h.service.runExpirySweep();

      expect(result.expired).toBe(1);
      expect(h.enqueued.map((e) => e.eventName)).toContain(INSURANCE_EVENTS.INSURANCE_EXPIRED);
    });

    it('warns about expiring inspections as well as policies', async () => {
      const h = harness({
        findInspectionsExpiringWithin: jest.fn(async () => [
          {
            id: 'INP_1',
            assetId: ASSET_ID,
            organizationId: DEH1,
            validTo: new Date(Date.now() + 5 * day),
          },
        ]),
      });

      const result = await h.service.runExpirySweep();

      expect(result.warned).toBe(1);
      expect(h.enqueued.map((e) => e.eventName)).toContain(INSURANCE_EVENTS.INSPECTION_EXPIRING);
    });

    it('publishes nothing when nothing is expiring', async () => {
      const h = harness();
      const result = await h.service.runExpirySweep();

      expect(result).toEqual({ warned: 0, expired: 0 });
      expect(h.enqueued).toHaveLength(0);
    });
  });
});
