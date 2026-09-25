import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ClaimService } from './claim.service';
import type { ClaimAuthority } from './claim-access';
import type { AssetRepository } from '../asset/asset.repository';
import type { AssetService } from '../asset/asset.service';
import { INSURANCE_EVENTS } from '../asset/events';
import type { SubmitClaimDto } from '../asset/dto';

/**
 * Claims, at the level of what leaves the service: which events are enqueued
 * with which payload, what the dossier gets, and which requests are refused
 * before any row changes.
 *
 * The state-machine edges and the authority rule have their own specs; this
 * one proves the service wires them in the right order — authority before
 * the row is read, the transition guard before the write, the outbox and the
 * dossier line inside the same transaction as the row.
 */

const DEH1 = 'ORG-DEH-0001';
const ASSET_ID = 'AST_01JASSET0000000000000001';
const POLICY_ID = 'INS_01JPOLICY000000000000001';
const CLAIM_ID = 'CLM_01JCLAIM0000000000000001';
const day = 86_400_000;

const authority: ClaimAuthority = {
  decisionRoles: ['ORGANIZATION_ADMIN', 'UNION_ADMIN'],
  approvalCeilingMinor: null,
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'corr-sample',
    requestId: 'req-sample',
    organizationId: DEH1,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['ORGANIZATION_ADMIN'],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

interface ClaimRow {
  id: string;
  assetId: string;
  policyId: string;
  organizationId: string;
  claimNumber: string | null;
  description: string;
  incidentAt: Date;
  claimedAmountMinor: bigint | null;
  approvedAmountMinor: bigint | null;
  status: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNotes: string | null;
  settledAt: Date | null;
  settlementReference: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function claimRow(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: CLAIM_ID,
    assetId: ASSET_ID,
    policyId: POLICY_ID,
    organizationId: DEH1,
    claimNumber: null,
    description: 'برخورد با مانع در جاده روستایی',
    incidentAt: new Date(Date.now() - 3 * day),
    claimedAmountMinor: 120_000_000n,
    approvedAmountMinor: null,
    status: 'SUBMITTED',
    decidedAt: null,
    decidedBy: null,
    decisionNotes: null,
    settledAt: null,
    settlementReference: null,
    createdBy: 'USR-SEED-FLEET-MANAGER',
    updatedBy: 'USR-SEED-FLEET-MANAGER',
    createdAt: new Date(Date.now() - 2 * day),
    updatedAt: new Date(Date.now() - 2 * day),
    ...overrides,
  };
}

interface Harness {
  service: ClaimService;
  enqueued: Array<{ eventName: string; aggregateId: string; payload: Record<string, unknown> }>;
  appended: Array<Record<string, unknown>>;
  /** The claim row as the fake database currently holds it. */
  row: () => ClaimRow | null;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
}

function harness(
  options: {
    claim?: ClaimRow | null;
    policy?: Record<string, unknown> | null;
    asset?: Record<string, unknown> | null;
    authority?: ClaimAuthority;
    /** Simulates a concurrent request that moved the claim first. */
    loseRace?: boolean;
    /** Whether the policy counts for the asset's current owner (docs/24 Q-66). */
    policyCounts?: boolean;
  } = {},
): Harness {
  const enqueued: Harness['enqueued'] = [];
  const appended: Harness['appended'] = [];
  const updates: Harness['updates'] = [];
  let stored: ClaimRow | null = options.claim === undefined ? claimRow() : options.claim;

  const policy =
    options.policy === undefined
      ? {
          id: POLICY_ID,
          assetId: ASSET_ID,
          status: 'ACTIVE',
          validFrom: new Date(Date.now() - 100 * day),
          validTo: new Date(Date.now() + 200 * day),
        }
      : options.policy;

  const insuranceClaim = {
    findFirst: jest.fn(async (args: { where: { id?: string; assetId?: string } }) =>
      stored && stored.id === args.where.id && stored.assetId === args.where.assetId
        ? stored
        : null,
    ),
    findMany: jest.fn(async () => (stored ? [stored] : [])),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      stored = claimRow({
        ...(args.data as Partial<ClaimRow>),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return stored;
    }),
    updateMany: jest.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        if (options.loseRace || !stored || stored.status !== args.where.status) {
          return { count: 0 };
        }
        stored = { ...stored, ...(args.data as Partial<ClaimRow>), updatedAt: new Date() };
        return { count: 1 };
      },
    ),
  };

  const client = {
    insuranceClaim,
    insurancePolicy: {
      findFirst: jest.fn(async (args: { where: { id: string; assetId: string } }) =>
        policy && policy.id === args.where.id && policy.assetId === args.where.assetId
          ? policy
          : null,
      ),
    },
    assetTimelineEntry: { findMany: jest.fn(async () => []) },
  };

  const repository = {
    client,
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(client)),
    enqueueEvent: jest.fn(
      async (
        _tx: unknown,
        input: { eventName: string; aggregateId: string; payload: Record<string, unknown> },
      ) => {
        enqueued.push({
          eventName: input.eventName,
          aggregateId: input.aggregateId,
          payload: input.payload,
        });
        return 'EVT_1';
      },
    ),
    findById: jest.fn(async () =>
      options.asset === undefined ? { id: ASSET_ID, organizationId: DEH1 } : options.asset,
    ),
    latestTransferAt: jest.fn(async () => null),
    lockAsset: jest.fn(async () => ({ status: 'ACTIVE' })),
  } as unknown as AssetRepository;

  const assets = {
    appendTimeline: jest.fn(async (_tx: unknown, entry: Record<string, unknown>) => {
      appended.push(entry);
    }),
    policyCountsForCurrentOwner: jest.fn(async () => options.policyCounts ?? true),
  } as unknown as AssetService;

  return {
    service: new ClaimService(repository, assets, options.authority ?? authority),
    enqueued,
    appended,
    row: () => stored,
    updates,
  };
}

const run = <T>(fn: () => Promise<T>, overrides: Partial<RequestContext> = {}): Promise<T> =>
  runWithContext(context(overrides), fn);

const SUBMISSION: SubmitClaimDto = {
  policyId: POLICY_ID,
  description: 'برخورد با مانع در جاده روستایی',
  incidentAt: new Date(Date.now() - 3 * day).toISOString(),
  claimedAmountMinor: '120000000',
};

describe('ClaimService', () => {
  describe('filing a claim', () => {
    it("takes a claim on the previous owner's policy, which follows the vehicle", async () => {
      // docs/24 Q-66, the project owner's decision: the new owner may claim on
      // an inherited policy, and the claim is filed under the new owner.
      const h = harness({ policyCounts: true });
      const claim = await run(() => h.service.submitClaim(ASSET_ID, SUBMISSION));
      expect(claim.id).toBeDefined();
      expect(h.row()).toMatchObject({ organizationId: DEH1 });
    });

    it('refuses it only where a narrowed configuration says the coverage stays behind', async () => {
      const h = harness({ policyCounts: false });
      await expect(run(() => h.service.submitClaim(ASSET_ID, SUBMISSION))).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'POLICY_FROM_PREVIOUS_OWNER' }),
      });
    });

    it('opens the claim, publishes INSURANCE_CLAIM_OPENED and writes a dossier line', async () => {
      const h = harness({ claim: null });
      const claim = await run(() => h.service.submitClaim(ASSET_ID, SUBMISSION));

      expect(claim.status).toBe('SUBMITTED');
      expect(claim.id).toMatch(/^CLM_/);
      expect(h.enqueued.map((e) => e.eventName)).toEqual([INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED]);
      expect(h.enqueued[0]?.aggregateId).toBe(claim.id);
      expect(h.appended[0]).toMatchObject({
        category: 'INSURANCE',
        sourceEventId: `${claim.id}:SUBMITTED`,
      });
    });

    it('puts the claimed amount on the wire and on the event as a string', async () => {
      const h = harness({ claim: null });
      const claim = await run(() => h.service.submitClaim(ASSET_ID, SUBMISSION));

      expect(claim.claimedAmountMinor).toBe('120000000');
      expect(h.enqueued[0]?.payload.claimedAmountMinor).toBe('120000000');
    });

    it('answers 404 for a policy on a different asset, not 422', async () => {
      // Confirming that the policy exists elsewhere would map another
      // machine's — or another tenant's — cover. Same code as a missing one.
      const h = harness({ claim: null, policy: { id: POLICY_ID, assetId: 'AST_OTHER' } });

      await expect(run(() => h.service.submitClaim(ASSET_ID, SUBMISSION))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(h.enqueued).toHaveLength(0);
    });

    it('refuses an incident outside the policy term', async () => {
      const h = harness({
        claim: null,
        policy: {
          id: POLICY_ID,
          assetId: ASSET_ID,
          status: 'ACTIVE',
          validFrom: new Date(Date.now() - day),
          validTo: new Date(Date.now() + 200 * day),
        },
      });

      await expect(run(() => h.service.submitClaim(ASSET_ID, SUBMISSION))).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({ rule: 'INCIDENT_OUTSIDE_POLICY_TERM' }),
      });
    });

    it('refuses a claim against a cancelled policy', async () => {
      const h = harness({
        claim: null,
        policy: {
          id: POLICY_ID,
          assetId: ASSET_ID,
          status: 'CANCELLED',
          validFrom: new Date(Date.now() - 100 * day),
          validTo: new Date(Date.now() + 200 * day),
        },
      });

      await expect(run(() => h.service.submitClaim(ASSET_ID, SUBMISSION))).rejects.toThrow(
        /cancelled policy/,
      );
    });

    it('raises 404 for an asset the caller cannot see', async () => {
      const h = harness({ claim: null, asset: null });
      await expect(run(() => h.service.submitClaim(ASSET_ID, SUBMISSION))).rejects.toThrow(
        RastaError,
      );
    });
  });

  describe('review', () => {
    it('moves SUBMITTED to UNDER_REVIEW and names the reviewer on the event', async () => {
      const h = harness();
      const claim = await run(() => h.service.startReview(ASSET_ID, CLAIM_ID, {}));

      expect(claim.status).toBe('UNDER_REVIEW');
      expect(h.enqueued[0]).toMatchObject({
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_REVIEW_STARTED,
        payload: expect.objectContaining({ reviewedBy: 'USR-SEED-DEHYARI-ADMIN' }),
      });
    });

    it('guards the write with the status it read, so a lost race is a 409 and not a silent overwrite', async () => {
      const h = harness({ loseRace: true });

      await expect(run(() => h.service.startReview(ASSET_ID, CLAIM_ID, {}))).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(h.updates[0]?.where).toMatchObject({ status: 'SUBMITTED' });
      expect(h.enqueued).toHaveLength(0);
      expect(h.appended).toHaveLength(0);
    });
  });

  describe('decision', () => {
    it('refuses a caller outside the configured roles before touching the claim', async () => {
      const h = harness({ claim: claimRow({ status: 'UNDER_REVIEW' }) });

      await expect(
        run(() => h.service.decide(ASSET_ID, CLAIM_ID, { decision: 'APPROVED', notes: 'ok' }), {
          roles: ['FLEET_MANAGER'],
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

      expect(h.updates).toHaveLength(0);
      expect(h.enqueued).toHaveLength(0);
    });

    it('approves with an amount, records who and when, and publishes INSURANCE_CLAIM_DECIDED', async () => {
      const h = harness({ claim: claimRow({ status: 'UNDER_REVIEW' }) });
      const claim = await run(() =>
        h.service.decide(ASSET_ID, CLAIM_ID, {
          decision: 'APPROVED',
          approvedAmountMinor: '100000000',
          notes: 'مطابق ارزیابی کارشناس',
        }),
      );

      expect(claim.status).toBe('APPROVED');
      expect(claim.approvedAmountMinor).toBe('100000000');
      expect(claim.decidedBy).toBe('USR-SEED-DEHYARI-ADMIN');
      expect(claim.decidedAt).not.toBeNull();

      expect(h.enqueued[0]).toMatchObject({
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_DECIDED,
        payload: expect.objectContaining({
          decision: 'APPROVED',
          approvedAmountMinor: '100000000',
          decidedBy: 'USR-SEED-DEHYARI-ADMIN',
        }),
      });
      expect(h.appended[0]).toMatchObject({
        sourceEventId: `${CLAIM_ID}:APPROVED`,
        amountMinor: 100_000_000n,
      });
    });

    it('rejects with a reason and never with an amount', async () => {
      const h = harness({ claim: claimRow({ status: 'UNDER_REVIEW' }) });
      const claim = await run(() =>
        h.service.decide(ASSET_ID, CLAIM_ID, { decision: 'REJECTED', notes: 'خارج از پوشش' }),
      );

      expect(claim.status).toBe('REJECTED');
      expect(claim.approvedAmountMinor).toBeNull();
      expect(claim.decisionNotes).toBe('خارج از پوشش');
      expect(h.enqueued[0]?.payload).toMatchObject({
        decision: 'REJECTED',
        approvedAmountMinor: null,
      });
    });

    it('refuses to decide a claim nobody has reviewed', async () => {
      const h = harness();

      await expect(
        run(() => h.service.decide(ASSET_ID, CLAIM_ID, { decision: 'APPROVED' })),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(h.enqueued).toHaveLength(0);
    });

    it('refuses an approval above the configured ceiling, and writes nothing', async () => {
      const h = harness({
        claim: claimRow({ status: 'UNDER_REVIEW' }),
        authority: { ...authority, approvalCeilingMinor: 50_000_000n },
      });

      await expect(
        run(() =>
          h.service.decide(ASSET_ID, CLAIM_ID, {
            decision: 'APPROVED',
            approvedAmountMinor: '100000000',
          }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      expect(h.updates).toHaveLength(0);
      expect(h.row()?.status).toBe('UNDER_REVIEW');
    });

    it('lets SYSTEM_ADMIN decide regardless of the configured roles', async () => {
      const h = harness({ claim: claimRow({ status: 'UNDER_REVIEW' }) });
      const claim = await run(
        () => h.service.decide(ASSET_ID, CLAIM_ID, { decision: 'REJECTED', notes: 'تکراری' }),
        { roles: ['SYSTEM_ADMIN'] },
      );
      expect(claim.status).toBe('REJECTED');
    });
  });

  describe('settlement', () => {
    it('records that an approved claim was settled, with the reference, and moves no money', async () => {
      const h = harness({
        claim: claimRow({
          status: 'APPROVED',
          approvedAmountMinor: 100_000_000n,
          decidedAt: new Date(),
          decidedBy: 'USR-SEED-DEHYARI-ADMIN',
        }),
      });

      const claim = await run(() =>
        h.service.recordSettlement(ASSET_ID, CLAIM_ID, { settlementReference: 'INSURER-PAY-1' }),
      );

      expect(claim.status).toBe('SETTLED');
      expect(claim.settlementReference).toBe('INSURER-PAY-1');
      expect(claim.settledAt).not.toBeNull();
      expect(h.enqueued[0]).toMatchObject({
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_SETTLEMENT_RECORDED,
        payload: expect.objectContaining({
          approvedAmountMinor: '100000000',
          settlementReference: 'INSURER-PAY-1',
          recordedBy: 'USR-SEED-DEHYARI-ADMIN',
        }),
      });
      // The only side effects are the row, the event and the dossier line.
      expect(h.enqueued).toHaveLength(1);
      expect(h.appended).toHaveLength(1);
    });

    it('sits behind the same authority as the decision', async () => {
      const h = harness({ claim: claimRow({ status: 'APPROVED' }) });

      await expect(
        run(() => h.service.recordSettlement(ASSET_ID, CLAIM_ID, {}), {
          roles: ['FLEET_MANAGER'],
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    });

    it('refuses to settle a rejected claim', async () => {
      const h = harness({ claim: claimRow({ status: 'REJECTED' }) });

      await expect(
        run(() => h.service.recordSettlement(ASSET_ID, CLAIM_ID, {})),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });
  });

  describe('reads', () => {
    it('answers 404 for a claim on another asset', async () => {
      const h = harness();
      await expect(run(() => h.service.getClaim('AST_OTHER', CLAIM_ID))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('returns money as strings and the history oldest first', async () => {
      const h = harness();
      const claim = await run(() => h.service.getClaim(ASSET_ID, CLAIM_ID));

      expect(typeof claim.claimedAmountMinor).toBe('string');
      expect(claim.history).toEqual([]);
    });
  });
});
