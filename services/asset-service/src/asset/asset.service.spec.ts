import {
  RastaError,
  currentUnscopedReason,
  isUnscoped,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { AssetService } from './asset.service';
import type { AssetRepository } from './asset.repository';
import { ASSET_EVENTS } from './events';
import { AssetController } from './asset.controller';
import {
  updateAssetSchema,
  type CreateAssetDto,
  type TransferAssetDto,
  type UpdateAssetDto,
} from './dto';
import type { ClearanceAnswer, TransferClearance, WorkOwner } from './transfer-clearance';
import { transferClearanceTotal } from '../observability/metrics';

/**
 * Asset service behaviour, with the repository stubbed.
 *
 * The cases here are the ones where a mistake is a safety, security or
 * integrity defect rather than a cosmetic one: the invariant that an asset
 * cannot be commissioned without a complete dossier, the serial-number check
 * that must not leak another tenant's fleet, and the transfer that has to move
 * a machine's whole history with it.
 */

const DEH1 = 'ORG-DEH-0001';
const DEH2 = 'ORG-DEH-0002';
const ASSET_ID = 'AST_01JASSET0000000000000001';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: DEH1,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['FLEET_MANAGER'],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    organizationId: DEH1,
    assetTag: 'D1-TRK-001',
    name: 'کامیون حمل زباله',
    type: 'GARBAGE_TRUCK',
    manufacturer: null,
    model: null,
    serialNumber: 'CHASSIS-1',
    manufactureYear: null,
    status: 'ACTIVE',
    commissionedAt: new Date(0),
    decommissionedAt: null,
    decommissionedReason: null,
    specifications: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: 'SEED',
    updatedBy: 'SEED',
    version: 1,
    deletedAt: null,
    ...overrides,
  };
}

function policyRow(validTo: Date) {
  return {
    id: 'INS_1',
    policyNumber: 'POL-1',
    insurerName: 'بیمه نمونه',
    coverage: 'THIRD_PARTY',
    premiumMinor: 1000n,
    insuredValueMinor: null,
    validFrom: new Date(0),
    validTo,
    status: 'ACTIVE',
  };
}

interface Harness {
  service: AssetService;
  repository: jest.Mocked<AssetRepository>;
  enqueued: Array<{ eventName: string; payload: Record<string, unknown> }>;
  timeline: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  tx: TxMock;
  clearance: FakeClearance;
}

/**
 * The owners of the machine's work (ADR-062), answering from a script.
 * Clear by default; `answers` replaces an owner's answer, and a function is
 * called so it can throw.
 */
interface FakeClearance extends TransferClearance {
  asked: WorkOwner[];
  released: WorkOwner[];
  clock: number;
}

function fakeClearance(
  answers: Partial<Record<WorkOwner, ClearanceAnswer | (() => Promise<ClearanceAnswer>)>> = {},
): FakeClearance {
  const fake: FakeClearance = {
    fenceTtlSeconds: 600,
    asked: [],
    released: [],
    clock: 0,
    now: () => fake.clock,
    ask: async (owner, organizationId, assetId, fenceId) => {
      expect(organizationId).toBe(DEH1);
      expect(assetId).toBe(ASSET_ID);
      expect(fenceId).toMatch(/^TRF_[0-9A-Z]{26}$/);
      fake.asked.push(owner);
      const answer = answers[owner];
      if (typeof answer === 'function') return answer();
      return answer ?? { clear: true };
    },
    release: async (owner) => {
      fake.released.push(owner);
    },
  };
  return fake;
}

interface TxMock {
  asset: { create: jest.Mock; updateMany: jest.Mock };
  assetTransfer: { create: jest.Mock; updateMany: jest.Mock };
  assetLocation: { updateMany: jest.Mock };
  assetDocumentRef: { updateMany: jest.Mock };
  assetTimelineEntry: { updateMany: jest.Mock };
  insurancePolicy: { updateMany: jest.Mock };
  insuranceClaim: { updateMany: jest.Mock };
  technicalInspection: { updateMany: jest.Mock };
}

function harness(
  overrides: Partial<Record<string, unknown>> = {},
  clearance: FakeClearance = fakeClearance(),
): Harness {
  const enqueued: Harness['enqueued'] = [];
  const timeline: Harness['timeline'] = [];
  const updates: Harness['updates'] = [];

  const tx = {
    asset: {
      create: jest.fn((args: { data: Record<string, unknown> }) => assetRow(args.data)),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { count: 1 };
      }),
    },
    assetTransfer: { create: jest.fn(), updateMany: jest.fn() },
    insurancePolicy: { updateMany: jest.fn() },
    insuranceClaim: { updateMany: jest.fn() },
    technicalInspection: { updateMany: jest.fn() },
    assetLocation: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    assetDocumentRef: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    assetTimelineEntry: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        timeline.push(args.data);
        return args.data;
      }),
      updateMany: jest.fn(),
    },
    processedEvent: { create: jest.fn() },
  };

  const repository = {
    client: {
      assetDocumentRef: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
      assetLocation: { findFirst: jest.fn(async () => null) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    enqueueEvent: jest.fn(
      async (_tx: unknown, input: { eventName: string; payload: Record<string, unknown> }) => {
        enqueued.push({ eventName: input.eventName, payload: input.payload });
        return 'EVT_1';
      },
    ),
    findById: jest.fn(async () => assetRow()),
    // Every status write is a compare-and-set. The data is recorded where the
    // tests look for it, and one row matches unless a test says otherwise.
    compareAndSetStatus: jest.fn(
      async (_tx: unknown, _id: string, _expected: string, data: Record<string, unknown>) => {
        updates.push(data);
        return 1;
      },
    ),
    ownershipGeneration: jest.fn(async () => 0),
    databaseClock: jest.fn(async () => new Date('2026-09-25T12:00:00.000Z')),
    lockAsset: jest.fn(async () => ({ status: 'ACTIVE' })),
    hasOpenClaims: jest.fn(async () => false),
    findBySerialNumber: jest.fn(async () => null),
    findByAssetTag: jest.fn(async () => null),
    findActivePolicy: jest.fn(async () => null),
    findLatestInspection: jest.fn(async () => null),
    findOrganizationRef: jest.fn(async () => ({
      id: DEH2,
      name: 'دهیاری نمونه دو',
      status: 'ACTIVE',
    })),
    list: jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listTimeline: jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    costSummary: jest.fn(async () => []),
    countTransfers: jest.fn(async () => 0),
    findNearby: jest.fn(async () => []),
    setLocationPoint: jest.fn(),
    readCoordinate: jest.fn(async () => null),
    ...overrides,
  } as unknown as jest.Mocked<AssetRepository>;

  // The re-read after a compare-and-set sees the write, as it would in the
  // database: the row the lookup returns, with the last update applied.
  const lookup = repository.findById;
  repository.findById = jest.fn(async (...args: Parameters<AssetRepository['findById']>) => {
    const row = await lookup(...args);
    return row && args[1] !== undefined && updates.length > 0
      ? { ...row, ...(updates.at(-1) as object) }
      : row;
  }) as never;

  return {
    service: new AssetService(repository, undefined, clearance),
    repository,
    enqueued,
    timeline,
    updates,
    tx: tx as unknown as TxMock,
    clearance,
  };
}

const run = <T>(fn: () => Promise<T>, ctx: Partial<RequestContext> = {}): Promise<T> =>
  runWithContext(context(ctx), fn);

const CREATE: CreateAssetDto = {
  name: 'لودر',
  type: 'LOADER',
  specifications: {},
};

describe('AssetService', () => {
  describe('registration', () => {
    it('registers an asset as REGISTERED, not ACTIVE', async () => {
      const h = harness();
      const created = await run(() => h.service.create(CREATE));

      // Registration is paperwork, not commissioning. An asset that went
      // straight to ACTIVE would be dispatchable before anyone checked whether
      // it is insured.
      expect(created.status).toBe('REGISTERED');
      expect(h.enqueued.map((e) => e.eventName)).toEqual([ASSET_EVENTS.ASSET_CREATED]);
    });

    it('scopes the new asset to the caller organization, not to a body field', async () => {
      const h = harness();
      await run(() => h.service.create(CREATE), { organizationId: DEH2 });

      expect(h.enqueued[0]?.payload.organizationId).toBe(DEH2);
    });

    it('refuses a serial number already registered anywhere on the platform', async () => {
      const h = harness({
        findBySerialNumber: jest.fn(async () => assetRow({ organizationId: DEH2 })),
      });

      await expect(
        run(() => h.service.create({ ...CREATE, serialNumber: 'CHASSIS-1' })),
      ).rejects.toThrow(RastaError);
    });

    it('does not disclose which organization holds a clashing serial number', async () => {
      // A check that named the other tenant would let anyone enumerate another
      // dehyari's fleet by guessing chassis numbers.
      const h = harness({
        findBySerialNumber: jest.fn(async () => assetRow({ organizationId: DEH2 })),
      });

      const error = await run(() =>
        h.service.create({ ...CREATE, serialNumber: 'CHASSIS-1' }).catch((e: RastaError) => e),
      );

      expect(JSON.stringify(error)).not.toContain(DEH2);
    });

    it('allows two organizations to use the same asset tag', async () => {
      // Tags are what humans call a machine — "۱۲" in two villages is not a
      // clash, and treating it as one would make the field unusable.
      const h = harness({ findByAssetTag: jest.fn(async () => null) });
      await expect(
        run(() => h.service.create({ ...CREATE, assetTag: '12' })),
      ).resolves.toBeTruthy();
      expect(h.repository.findByAssetTag).toHaveBeenCalledWith(DEH1, '12');
    });
  });

  describe('editing — a stale edit must not overwrite a newer one (PR #158 review)', () => {
    const at = (version: number, overrides: Record<string, unknown> = {}) =>
      harness({ findById: jest.fn(async () => assetRow({ version, ...overrides })) });

    it('exposes the version an edit must be made against', async () => {
      const h = at(4);

      // An edit that changes nothing answers with the row as it is.
      const view = await run(() =>
        h.service.update(ASSET_ID, { name: 'کامیون حمل زباله', expectedVersion: 4 }),
      );

      expect(view.version).toBe(4);
    });

    it('applies an edit made against the current version, guarded on that version', async () => {
      const h = at(3);

      await run(() => h.service.update(ASSET_ID, { name: 'نام تازه', expectedVersion: 3 }));

      expect(h.tx.asset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ASSET_ID, version: 3 }),
          data: expect.objectContaining({ name: 'نام تازه', version: { increment: 1 } }),
        }),
      );
      expect(h.enqueued.map((event) => event.eventName)).toEqual(['ASSET_UPDATED']);
    });

    it('refuses an edit made against an older version and writes nothing', async () => {
      // Editor B opened the form at version 2; editor A saved, making it 3.
      const h = at(3);

      await expect(
        run(() => h.service.update(ASSET_ID, { assetTag: 'OLD-TAG', expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
      expect(h.enqueued).toHaveLength(0);
    });

    it('refuses an edit from a version that does not exist yet', async () => {
      const h = at(3);

      await expect(
        run(() => h.service.update(ASSET_ID, { name: 'نام تازه', expectedVersion: 9 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an edit that lost the race between the read and the write', async () => {
      // Both requests read version 3 and both pass the read-side check; the
      // row's own version predicate decides, and the loser writes nothing.
      const h = at(3);
      h.tx.asset.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        run(() => h.service.update(ASSET_ID, { name: 'نام تازه', expectedVersion: 3 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(h.enqueued).toHaveLength(0);
    });

    it('writes and announces only the fields that really change', async () => {
      const h = at(1);

      await run(() =>
        h.service.update(ASSET_ID, {
          name: 'کامیون حمل زباله', // what it already is
          assetTag: 'D1-TRK-002',
          manufacturer: null, // already empty
          expectedVersion: 1,
        }),
      );

      const call = h.tx.asset.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(Object.keys(call.data).sort()).toEqual(['assetTag', 'updatedBy', 'version']);
      expect(h.enqueued).toEqual([
        expect.objectContaining({
          eventName: 'ASSET_UPDATED',
          payload: expect.objectContaining({ changedFields: ['assetTag'] }),
        }),
      ]);
    });

    it('counts clearing a field as a change, and leaving an empty one empty as none', async () => {
      const h = at(1, { manufacturer: 'ایسوزو', model: null });

      await run(() =>
        h.service.update(ASSET_ID, { manufacturer: null, model: null, expectedVersion: 1 }),
      );

      expect(h.enqueued[0]?.payload).toMatchObject({ changedFields: ['manufacturer'] });
    });

    it('treats an edit that changes nothing as no edit: no write, no event, no new version', async () => {
      const h = at(5);

      const view = await run(() =>
        h.service.update(ASSET_ID, {
          name: 'کامیون حمل زباله',
          assetTag: 'D1-TRK-001',
          specifications: {},
          expectedVersion: 5,
        }),
      );

      expect(view.version).toBe(5);
      expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
      expect(h.enqueued).toHaveLength(0);
    });

    it('still refuses a stale version when the edit would have changed nothing', async () => {
      const h = at(5);

      await expect(
        run(() => h.service.update(ASSET_ID, { name: 'کامیون حمل زباله', expectedVersion: 4 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    });

    it('does not look for a tag clash when the tag is not being changed', async () => {
      const h = at(1);

      await run(() =>
        h.service.update(ASSET_ID, {
          assetTag: 'D1-TRK-001',
          name: 'نام تازه',
          expectedVersion: 1,
        }),
      );

      expect(h.repository.findByAssetTag).not.toHaveBeenCalled();
    });

    it('still refuses a decommissioned asset, whatever version is named', async () => {
      const h = at(2, { status: 'DECOMMISSIONED' });

      await expect(
        run(() => h.service.update(ASSET_ID, { name: 'نام تازه', expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    describe('the request body', () => {
      it('accepts a version together with a field', () => {
        expect(updateAssetSchema.safeParse({ name: 'نام تازه', expectedVersion: 2 }).success).toBe(
          true,
        );
      });

      it('requires a version: a request that does not say what it was made against is refused', () => {
        const result = updateAssetSchema.safeParse({ name: 'نام تازه' });
        expect(result.success).toBe(false);
        expect(
          !result.success && result.error.issues.map((issue) => issue.path.join('.')),
        ).toContain('expectedVersion');
      });

      it('does not accept a version alone as an edit', () => {
        expect(updateAssetSchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
      });

      it.each([0, -1, 1.5, 'x', '2', true, null, [], {}])(
        'does not accept %j as a version',
        (version) => {
          expect(
            updateAssetSchema.safeParse({ name: 'نام تازه', expectedVersion: version }).success,
          ).toBe(false);
        },
      );
    });

    describe('through the controller, as a direct API client reaches it', () => {
      // The pipe the controller binds to `PATCH :id`'s body, found from its own
      // route metadata, then the handler it hands the parsed body to. Nothing is
      // reconstructed: if the controller stopped validating, or validated a
      // different schema, this is what would notice.
      const bodyPipe = (): { transform: (value: unknown, meta: { type: 'body' }) => unknown } => {
        const args = Reflect.getMetadata('__routeArguments__', AssetController, 'update') as Record<
          string,
          { pipes: Array<{ transform: (value: unknown, meta: { type: 'body' }) => unknown }> }
        >;
        const found = Object.values(args).flatMap((entry) => entry.pipes);
        expect(found).toHaveLength(1);
        return found[0];
      };

      const patch = async (h: Harness, body: unknown) => {
        const controller = new AssetController(h.service, undefined as never, undefined as never);
        const parsed = bodyPipe().transform(body, { type: 'body' }) as UpdateAssetDto;
        return controller.update(ASSET_ID, parsed);
      };

      it('refuses a PATCH that omits the version with a 400, whatever else it says, and writes nothing', async () => {
        const h = harness({ findById: jest.fn(async () => assetRow({ version: 3 })) });

        await expect(run(() => patch(h, { assetTag: 'OLD-TAG' }))).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });

        expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
        expect(h.enqueued).toHaveLength(0);
      });

      it('answers a PATCH made against a stale version with a 409 and writes nothing', async () => {
        const h = harness({ findById: jest.fn(async () => assetRow({ version: 3 })) });

        await expect(
          run(() => patch(h, { assetTag: 'OLD-TAG', expectedVersion: 2 })),
        ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

        expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
      });

      it('applies a PATCH made against the current version, guarded on it', async () => {
        const h = harness({ findById: jest.fn(async () => assetRow({ version: 3 })) });

        await run(() => patch(h, { assetTag: 'NEW-TAG', expectedVersion: 3 }));

        expect(h.tx.asset.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: ASSET_ID, version: 3 }) }),
        );
      });
    });
  });

  describe('activation — the dossier invariant', () => {
    const registered = () => assetRow({ status: 'REGISTERED' });

    it('refuses to activate an asset with no insurance', async () => {
      const h = harness({ findById: jest.fn(async () => registered()) });

      await expect(run(() => h.service.activate(ASSET_ID, {}))).rejects.toThrow(
        /insurance policy currently in force/,
      );
    });

    it('names everything that is missing, not just the first thing', async () => {
      const h = harness({ findById: jest.fn(async () => registered()) });

      const error = (await run(() =>
        h.service.activate(ASSET_ID, {}).catch((e: RastaError) => e),
      )) as RastaError;

      // An operator who fixes one blocker should not have to retry to discover
      // the next.
      expect(error.message).toContain('insurance');
      expect(error.message).toContain('ownership title');
    });

    it('activates once insurance and an ownership document are on file', async () => {
      const h = harness({
        findById: jest.fn(async () => registered()),
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
      });
      (h.repository.client.assetDocumentRef.findFirst as jest.Mock).mockResolvedValue({
        id: 'DOC_1',
        kind: 'OWNERSHIP_TITLE',
      });

      const result = await run(() => h.service.activate(ASSET_ID, {}));

      expect(result.status).toBe('ACTIVE');
      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_ACTIVATED);
    });

    it("counts the previous owner's policy after a transfer, as the project owner decided", async () => {
      // docs/24 Q-66: the insurance follows the vehicle. Under the default,
      // every coverage follows, so the lookup carries no ownership clause.
      const h = harness({
        findById: jest.fn(async () => assetRow({ status: 'REGISTERED' })),
        ownershipGeneration: jest.fn(async () => 1),
      });

      await expect(run(() => h.service.activate(ASSET_ID, {}))).rejects.toThrow(/insurance/);
      expect(h.repository.findActivePolicy).toHaveBeenCalledWith(
        ASSET_ID,
        expect.any(Date),
        undefined,
      );
    });

    it('refuses to activate an asset that is already active', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'ACTIVE' })) });
      await expect(run(() => h.service.activate(ASSET_ID, {}))).rejects.toThrow(RastaError);
    });
  });

  describe('status changes', () => {
    it('refuses a transition a user does not own', async () => {
      const h = harness();
      await expect(
        run(() =>
          // @ts-expect-error — ChangeStatusDto's schema already excludes ASSIGNED; this
          // proves the service refuses it too if a caller bypasses the DTO.
          h.service.changeStatus(ASSET_ID, { status: 'ASSIGNED', reason: 'دستی' }),
        ),
      ).rejects.toThrow(/not done directly/);
    });

    it('accepts the same transition when it arrives as an event', async () => {
      const h = harness();
      await run(() =>
        h.service.applyEventStatusChange(h.tx as never, ASSET_ID, 'ASSIGNED', 'from fleet'),
      );

      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_STATUS_CHANGED);
    });

    it('ignores an event proposing an illegal transition rather than failing', async () => {
      // A dead-lettered message over a race that resolves itself would create
      // triage work for no benefit.
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'DECOMMISSIONED' })) });

      await expect(
        run(() =>
          h.service.applyEventStatusChange(h.tx as never, ASSET_ID, 'ACTIVE', 'from maintenance'),
        ),
      ).resolves.toBeUndefined();
      expect(h.enqueued).toHaveLength(0);
    });

    it('ignores an event about an asset it has never seen', async () => {
      const h = harness({ findById: jest.fn(async () => null) });

      await expect(
        run(() => h.service.applyEventStatusChange(h.tx as never, 'AST_UNKNOWN', 'ASSIGNED', 'x')),
      ).resolves.toBeUndefined();
    });

    it('records every status change on the timeline', async () => {
      const h = harness();
      await run(() => h.service.changeStatus(ASSET_ID, { status: 'IDLE', reason: 'فصل غیرکاری' }));

      expect(h.timeline.map((t) => t.category)).toContain('LIFECYCLE');
      expect(h.timeline.at(-1)?.description).toBe('فصل غیرکاری');
    });
  });

  describe('compare-and-set on status (audit L3-07)', () => {
    it('matches the update on the status the transition was judged from', async () => {
      const h = harness();
      await run(() => h.service.changeStatus(ASSET_ID, { status: 'IDLE', reason: 'x' }));

      expect(h.repository.compareAndSetStatus).toHaveBeenCalledWith(
        h.tx,
        ASSET_ID,
        'ACTIVE',
        expect.objectContaining({ status: 'IDLE' }),
        {},
      );
    });

    it.each<[string, (h: Harness) => Promise<unknown>]>([
      [
        'a user status change',
        (h: Harness) => h.service.changeStatus(ASSET_ID, { status: 'IDLE', reason: 'x' }),
      ],
      ['a decommission', (h: Harness) => h.service.decommission(ASSET_ID, { reason: 'فرسوده' })],
      [
        'an event-driven status change',
        (h: Harness) => h.service.applyEventStatusChange(h.tx as never, ASSET_ID, 'ASSIGNED', 'x'),
      ],
    ])('fails %s with a conflict when the status changed since the read', async (_name, act) => {
      // The race the audit describes: both requests read ACTIVE, one commits
      // DECOMMISSIONED, and the other must not write over it.
      const h = harness({ compareAndSetStatus: jest.fn(async () => 0) });

      await expect(run(() => act(h))).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(h.enqueued).toHaveLength(0);
      expect(h.timeline).toHaveLength(0);
    });

    it('refuses an edit that lost the race to a decommission', async () => {
      const h = harness();
      h.tx.asset.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        run(() => h.service.update(ASSET_ID, { name: 'نام تازه', expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(h.tx.asset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ASSET_ID, status: { not: 'DECOMMISSIONED' } }),
        }),
      );
    });

    it('turns a unique-index violation from a concurrent create into ALREADY_EXISTS', async () => {
      // Both requests pass the tag pre-check; the partial unique index decides.
      const h = harness();
      h.tx.asset.create.mockRejectedValueOnce(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      await expect(
        run(() => h.service.create({ ...CREATE, assetTag: 'T-1' })),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    });
  });

  describe('transfer of ownership', () => {
    const dto: TransferAssetDto = {
      toOrganizationId: DEH2,
      reason: 'واگذاری به دهیاری همجوار',
    };

    it('moves the tenant column without changing the identity', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      const update = h.updates.at(-1);
      expect(update?.organizationId).toBe(DEH2);
      // Same id, same row. A transfer that created a new asset would orphan
      // every maintenance and ledger record pointing at the old one.
      expect(update).not.toHaveProperty('id');
    });

    it('resets the asset to REGISTERED so the new owner re-commissions it', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      expect(h.updates.at(-1)?.status).toBe('REGISTERED');
    });

    it('moves the whole history to the new owner', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      // Timeline, locations and documents all follow the asset — otherwise the
      // new owner sees a machine with no past, and the old owner keeps rows
      // for a machine they no longer hold.
      const moved = { organizationId: DEH2 };
      expect(h.tx.assetTimelineEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );
      expect(h.tx.assetLocation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );
      expect(h.tx.assetDocumentRef.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );
      // Audit L3-08: the insurance and inspection record, and the earlier
      // transfers, are part of that history too.
      for (const table of [
        h.tx.insurancePolicy,
        h.tx.insuranceClaim,
        h.tx.technicalInspection,
        h.tx.assetTransfer,
      ]) {
        expect(table.updateMany).toHaveBeenCalledWith({
          where: { assetId: ASSET_ID },
          data: moved,
        });
      }

      // All of it in one transaction: a partial move would split a machine's
      // history across two tenants.
      expect(h.repository.transaction).toHaveBeenCalledTimes(1);
      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_TRANSFERRED);
      expect(h.enqueued.at(-1)?.payload).toMatchObject({
        fromOrganizationId: DEH1,
        toOrganizationId: DEH2,
      });
    });

    it('declares the cross-tenant write instead of relying on implicit scoping', async () => {
      // The transfer writes rows owned by the *receiving* organization while
      // the caller acts for the sending one. The tenant guard refuses that by
      // default — correctly — so the crossing has to be declared, with a
      // reason, rather than worked around.
      const h = harness();
      let reasonInside: string | undefined;
      let unscopedInside = false;

      (h.repository.transaction as jest.Mock).mockImplementation(
        async (fn: (t: unknown) => Promise<unknown>) => {
          unscopedInside = isUnscoped();
          reasonInside = currentUnscopedReason();
          return fn(h.tx);
        },
      );

      await run(() => h.service.transfer(ASSET_ID, dto));

      expect(unscopedInside).toBe(true);
      expect(reasonInside).toContain(DEH1);
      expect(reasonInside).toContain(DEH2);
    });

    it('proves ownership under scoping before lifting it', async () => {
      // The order is what makes the escape hatch safe: the asset is fetched
      // scoped — so the caller has provably got it — and only then is scoping
      // lifted for the write.
      const h = harness();
      const scoped: boolean[] = [];
      (h.repository.findById as jest.Mock).mockImplementation(async () => {
        scoped.push(!isUnscoped());
        return assetRow();
      });

      await run(() => h.service.transfer(ASSET_ID, dto));

      // The first lookup, the one that proves ownership, is scoped. The re-read
      // after the write runs inside the declared crossing, by design.
      expect(scoped[0]).toBe(true);
    });

    it('refuses a transfer to an organization that does not exist', async () => {
      const h = harness({ findOrganizationRef: jest.fn(async () => null) });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(RastaError);
    });

    it('refuses a transfer to a suspended organization', async () => {
      const h = harness({
        findOrganizationRef: jest.fn(async () => ({ id: DEH2, name: 'x', status: 'SUSPENDED' })),
      });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(/not active/);
    });

    it('refuses to transfer a decommissioned asset', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'DECOMMISSIONED' })) });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(RastaError);
    });

    it.each(['ASSIGNED', 'IN_MAINTENANCE'])(
      'refuses to transfer an asset that is %s (audit L3-03)',
      async (status) => {
        // The open assignment or repair would stay with the previous owner.
        const h = harness({ findById: jest.fn(async () => assetRow({ status })) });

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
        });
        expect(h.repository.transaction).not.toHaveBeenCalled();
      },
    );

    it('refuses to transfer an asset with an open insurance claim, and moves nothing', async () => {
      const h = harness({ hasOpenClaims: jest.fn(async () => true) });

      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(
        /claim that is still open/,
      );
      // The check runs inside the transaction, so the throw rolls back the
      // compare-and-set too. Nothing after it ran.
      expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
      expect(h.tx.insurancePolicy.updateMany).not.toHaveBeenCalled();
      expect(h.enqueued).toHaveLength(0);
    });

    it('matches the transfer on the owner as well as the status', async () => {
      // Unscoped, so without the owner in the predicate a concurrent transfer
      // that already moved the asset would go unnoticed.
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      expect(h.repository.compareAndSetStatus).toHaveBeenCalledWith(
        h.tx,
        ASSET_ID,
        'ACTIVE',
        expect.objectContaining({ organizationId: DEH2, status: 'REGISTERED' }),
        { organizationId: DEH1 },
      );
    });

    it('fails a transfer that lost a race, before writing anything', async () => {
      const h = harness({ compareAndSetStatus: jest.fn(async () => 0) });

      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
      expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
    });

    it('refuses a transfer to the organization that already owns it', async () => {
      const h = harness();
      await expect(
        run(() => h.service.transfer(ASSET_ID, { ...dto, toOrganizationId: DEH1 })),
      ).rejects.toThrow(/already belongs/);
    });

    // ADR-062, docs/23 D-033: the owners of the work are asked, not the
    // status this service built from their events.
    describe('clearance from the owners of the work', () => {
      it('asks fleet and maintenance, and keeps their fences when the transfer lands', async () => {
        const h = harness();
        await run(() => h.service.transfer(ASSET_ID, dto));

        expect(h.clearance.asked.sort()).toEqual(['fleet-service', 'maintenance-service']);
        // Their consumers lift them on ASSET_TRANSFERRED; lifted now, the
        // previous owner could open work before the replicas catch up.
        expect(h.clearance.released).toEqual([]);
        expect(h.tx.assetTransfer.create).toHaveBeenCalled();
      });

      it('refuses when maintenance has open work the status never showed, and lifts fleet’s fence', async () => {
        const h = harness(
          {},
          fakeClearance({ 'maintenance-service': { clear: false, open: { openRequests: 1 } } }),
        );

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
          internalContext: expect.objectContaining({
            rule: 'OPEN_OPERATIONAL_ACTIVITY',
            owner: 'maintenance-service',
            openRequests: 1,
          }),
        });
        // Every owner, not only the one that answered clear (review #127 #4).
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
        expect(h.updates).toEqual([]);
        expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
        expect(h.enqueued).toEqual([]);
      });

      it('refuses when fleet has an assignment it has not published yet', async () => {
        const h = harness(
          {},
          fakeClearance({ 'fleet-service': { clear: false, open: { openAssignments: 1 } } }),
        );

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          internalContext: expect.objectContaining({ owner: 'fleet-service', openAssignments: 1 }),
        });
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
        expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
      });

      it.each([
        ['unreachable', () => RastaError.upstreamUnavailable('maintenance-service')],
        ['timed out', () => RastaError.upstreamTimeout('maintenance-service', 3000)],
      ])('fails closed when an owner is %s', async (_label, failure) => {
        const h = harness(
          {},
          fakeClearance({
            'maintenance-service': async () => {
              throw failure();
            },
          }),
        );

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toBeInstanceOf(
          RastaError,
        );
        // The owner that failed may have committed its fence before its
        // answer was lost: it is released too.
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
        expect(h.updates).toEqual([]);
        expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
      });

      it('names open work before an outage, because a person can act on it', async () => {
        const h = harness(
          {},
          fakeClearance({
            'fleet-service': async () => {
              throw RastaError.upstreamUnavailable('fleet-service');
            },
            'maintenance-service': { clear: false, open: { openRepairOrders: 2 } },
          }),
        );

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          internalContext: expect.objectContaining({ rule: 'OPEN_OPERATIONAL_ACTIVITY' }),
        });
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('never transfers when no clearance was configured', async () => {
        const h = harness();
        const bare = new AssetService(h.repository);

        await expect(run(() => bare.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          code: 'UPSTREAM_UNAVAILABLE',
        });
        expect(h.tx.assetTransfer.create).not.toHaveBeenCalled();
      });

      it('lifts the fences when the transfer itself fails', async () => {
        const h = harness({ compareAndSetStatus: jest.fn(async () => 0) });

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toMatchObject({
          code: 'OPTIMISTIC_LOCK_FAILED',
        });
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('does not record a transfer confirmed more than half a fence ago, measured from before asking', async () => {
        const clearance = fakeClearance();
        const h = harness(
          {
            // The owners answer, then the commit stalls until the fences
            // are about to lapse.
            databaseClock: jest.fn(async () => {
              clearance.clock = 300_000;
              return new Date('2026-09-25T12:00:00.000Z');
            }),
          },
          clearance,
        );

        // Thrown inside the transaction, after its last write, so the
        // database rolls all of it back (proved against PostgreSQL in
        // asset-integrity.int-spec.ts).
        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(
          /took too long to confirm/,
        );
        expect(clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('checks the deadline after every write, so only the commit is outside it', async () => {
        const clearance = fakeClearance();
        const h = harness({}, clearance);
        // The last write of the transfer stalls until the fences are about to
        // lapse; a check before it would have passed.
        h.tx.assetTransfer.updateMany.mockImplementation(() => {
          clearance.clock = 300_000;
          return { count: 1 };
        });

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(
          /took too long to confirm/,
        );
      });

      it('keeps the fences when the commit’s outcome is unknown: the transaction ran to its end', async () => {
        const h = harness({
          // Every write and the deadline ran; then COMMIT failed or its
          // acknowledgement was lost. The transfer may have landed.
          transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
            await fn(h.tx);
            throw new Error('Connection terminated unexpectedly');
          }),
        });

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(
          /Connection terminated/,
        );
        // Released now, the previous owner could open work before the owners
        // consume ASSET_TRANSFERRED; the owners resolve them at expiry instead.
        expect(h.clearance.released).toEqual([]);
      });

      it('releases every fence for an error raised before the transaction’s last step', async () => {
        const h = harness({
          hasOpenClaims: jest.fn(async () => {
            throw new Error('Connection terminated unexpectedly');
          }),
        });

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(
          /Connection terminated/,
        );
        expect(h.clearance.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('counts each owner’s answer by outcome', async () => {
        const counter = jest.spyOn(transferClearanceTotal, 'inc');
        const h = harness(
          {},
          fakeClearance({
            'fleet-service': async () => {
              throw RastaError.upstreamTimeout('fleet-service', 3000);
            },
            'maintenance-service': { clear: false, open: { openRequests: 1 } },
          }),
        );

        await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toBeInstanceOf(
          RastaError,
        );
        expect(counter.mock.calls.map(([labels]) => labels)).toEqual([
          { service: 'asset-service', owner: 'fleet-service', outcome: 'unavailable' },
          { service: 'asset-service', owner: 'maintenance-service', outcome: 'open_work' },
        ]);
        counter.mockRestore();
      });

      it('does not ask anyone when the local checks already refuse', async () => {
        const h = harness();
        await expect(
          run(() => h.service.transfer(ASSET_ID, { ...dto, toOrganizationId: DEH1 })),
        ).rejects.toThrow(/already belongs/);
        expect(h.clearance.asked).toEqual([]);
      });
    });
  });

  describe('dossier compliance', () => {
    it('reports an asset with no insurance and no inspection as inoperable', async () => {
      const h = harness();
      const dossier = await run(() => h.service.dossier(ASSET_ID));

      expect(dossier.compliance.operable).toBe(false);
      expect(dossier.compliance.blockers).toEqual([
        'No insurance policy is currently in force',
        'No technical inspection on record',
      ]);
    });

    it('reports every blocker at once', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'OUT_OF_SERVICE' })) });
      const dossier = await run(() => h.service.dossier(ASSET_ID));

      expect(dossier.compliance.blockers).toHaveLength(3);
    });

    it('treats a failed inspection as a blocker even when it has not expired', async () => {
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
        findLatestInspection: jest.fn(async () => ({
          id: 'INP_1',
          certificateNo: 'C-1',
          centerName: null,
          inspectedAt: new Date(0),
          validTo: new Date(Date.now() + 86_400_000),
          result: 'FAILED',
          notes: null,
        })),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));
      expect(dossier.compliance.operable).toBe(false);
      expect(dossier.compliance.blockers).toContain('The most recent technical inspection failed');
    });

    it('reports a fully compliant asset as operable', async () => {
      const soon = new Date(Date.now() + 30 * 86_400_000);
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(soon)),
        findLatestInspection: jest.fn(async () => ({
          id: 'INP_1',
          certificateNo: 'C-1',
          centerName: null,
          inspectedAt: new Date(0),
          validTo: soon,
          result: 'PASSED',
          notes: null,
        })),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));
      expect(dossier.compliance.operable).toBe(true);
      expect(dossier.compliance.blockers).toEqual([]);
    });

    it('puts money on the wire as a string, never a number', async () => {
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
        costSummary: jest.fn(async () => [
          { category: 'MAINTENANCE', total_minor: '12500000', entry_count: 3 },
        ]),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));

      // A rial amount past 2^53 silently loses precision as a JSON number
      // (ADR-022), so this is a correctness property, not a style preference.
      expect(typeof dossier.compliance.activeInsurance?.premiumMinor).toBe('string');
      expect(typeof dossier.costs.totalMinor).toBe('string');
      expect(dossier.costs.totalMinor).toBe('12500000');
    });

    it('raises 404 for an asset the caller cannot see', async () => {
      // The tenant guard turns a cross-tenant read into "not found" upstream of
      // this; the service must not soften it into a 403 that confirms the
      // asset exists somewhere.
      const h = harness({ findById: jest.fn(async () => null) });
      await expect(run(() => h.service.dossier(ASSET_ID))).rejects.toThrow(RastaError);
    });
  });

  describe('location', () => {
    it('passes the caller organization to the radius search explicitly', async () => {
      // Raw SQL is outside the Prisma tenant extension, so the scoping has to
      // be passed by hand — and omitting it would expose a neighbouring
      // dehyari's fleet.
      const h = harness();
      await run(() =>
        h.service.nearby({
          latitude: 31.85,
          longitude: 54.29,
          radiusMeters: 5000,
          limit: 20,
          availableOnly: true,
        }),
      );

      expect(h.repository.findNearby).toHaveBeenCalledWith(DEH1, expect.anything());
    });

    it('locks the asset exclusively before swapping its current location', async () => {
      // Two concurrent recordings would otherwise both demote the same row and
      // both insert a current one.
      const h = harness();
      Object.assign(h.repository.client.assetLocation, {
        findFirstOrThrow: jest.fn(async () => ({
          id: 'ALC_1',
          siteName: null,
          addressLine: null,
          source: 'MANUAL',
          recordedAt: new Date(0),
        })),
      });

      await run(() => h.service.recordLocation(ASSET_ID, { source: 'MANUAL' }));

      expect(h.repository.lockAsset).toHaveBeenCalledWith(h.tx, ASSET_ID, DEH1, 'EXCLUSIVE');
    });

    it('refuses a location for an asset that changed owner after the read', async () => {
      const h = harness({ lockAsset: jest.fn(async () => null) });

      await expect(
        run(() => h.service.recordLocation(ASSET_ID, { source: 'MANUAL' })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(h.tx.assetLocation.updateMany).not.toHaveBeenCalled();
    });
  });
});
