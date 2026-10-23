import { Prisma } from '../generated/prisma';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { FleetRepository } from './fleet.repository';
import type { RecordUsageDto } from './dto';
import { UsageService, usageRequestHash } from './usage.service';

/**
 * The binding of a `clientReference` to the request that took it (ADR-073
 * plan, PR 1 "fleet A").
 *
 * Before it, any submission whose reference was taken got the stored record
 * back: a resend with another body was told its new reading was saved, and a
 * colleague who knew the reference read the record through `POST`. These pin
 * that a replay goes only to the same caller with the same body, who may still
 * read the record — on all three paths that can find it (before validation,
 * under the asset lock, and after a unique violation) — and that every other
 * request gets one indistinguishable `409`.
 *
 * Against a real database, with real concurrency: test/usage-outbox.int-spec.ts.
 */
describe('UsageService replay binding', () => {
  const ORG = 'ORG-UNIT';
  const ASSET = 'AST_UNIT';
  const DRIVER_A = 'DRV_A';
  const DRIVER_B = 'DRV_B';

  const context = (overrides: Partial<RequestContext> = {}): RequestContext => ({
    correlationId: 'unit',
    requestId: 'unit',
    organizationId: ORG,
    userId: 'USR-SUPERVISOR-1',
    roles: ['FLEET_MANAGER'],
    organizationIds: [ORG],
    authType: 'USER',
    startedAt: Date.now(),
    ...overrides,
  });
  const supervisor1 = context();
  const supervisor2 = context({ userId: 'USR-SUPERVISOR-2', roles: ['ORGANIZATION_ADMIN'] });
  const driverA = context({ userId: 'USR-DRIVER-A', roles: ['DRIVER'] });
  const driverB = context({ userId: 'USR-DRIVER-B', roles: ['DRIVER'] });
  const service = (name: string) =>
    context({ userId: undefined, roles: ['SERVICE'], authType: 'SERVICE', callerService: name });

  const as = <T>(ctx: RequestContext, fn: () => Promise<T>) => runWithContext(ctx, fn);

  const dto = (overrides: Partial<RecordUsageDto> = {}): RecordUsageDto => ({
    assetId: ASSET,
    periodStart: '2026-08-01T06:00:00.000Z',
    periodEnd: '2026-08-01T14:00:00.000Z',
    hours: '7.50',
    source: 'MANUAL',
    clientReference: 'offline-ref-0001',
    ...overrides,
  });

  /** The row `request` created when `creator` sent it. */
  const storedRow = (
    creator: RequestContext,
    request: RecordUsageDto,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 'USG_STORED',
    organizationId: ORG,
    assetId: request.assetId,
    driverId: DRIVER_A,
    assignmentId: 'ASG_1',
    periodStart: new Date(request.periodStart),
    periodEnd: new Date(request.periodEnd),
    hours: request.hours === undefined ? null : new Prisma.Decimal(request.hours),
    kilometres: null,
    hourMeter: null,
    odometer: null,
    source: request.source,
    notes: request.notes ?? null,
    clientReference: request.clientReference ?? null,
    requestHash: runWithContext(creator, () => usageRequestHash(request)),
    recordedAt: new Date('2026-08-01T14:05:00.000Z'),
    recordedBy: creator.userId ?? 'SYSTEM',
    ...overrides,
  });

  type Row = ReturnType<typeof storedRow>;

  function setup(
    rows: {
      /** What the lookup before validation finds. */
      before?: Row | null;
      /** What the lookup under the asset lock finds. */
      underLock?: Row | null;
      /** What the lookup after a unique violation finds. */
      afterViolation?: Row | null;
    } = {},
    options: { insertFails?: boolean } = {},
  ) {
    const drivers: Record<string, { id: string }> = {
      'USR-DRIVER-A': { id: DRIVER_A },
      'USR-DRIVER-B': { id: DRIVER_B },
    };
    const tx = {
      usageRecord: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (options.insertFails) throw Object.assign(new Error('unique'), { code: 'P2002' });
          return { ...storedRow(supervisor1, dto()), ...data, recordedAt: new Date() };
        }),
      },
    };
    const repository = {
      findUsageByClientReference: jest.fn(async (_reference: string, inTx?: unknown) => {
        if (inTx) return rows.underLock ?? null;
        // After the insert was tried, the lookup is the unique-violation one.
        return (
          (tx.usageRecord.create.mock.calls.length > 0 ? rows.afterViolation : rows.before) ?? null
        );
      }),
      findDriverByUserId: jest.fn(async (userId: string) => drivers[userId] ?? null),
      findAssetRef: jest.fn(async () => ({ id: ASSET, organizationId: ORG })),
      findActiveAssignmentForDriver: jest.fn(async (driverId: string) => ({
        id: `ASG_${driverId}`,
        assetId: ASSET,
      })),
      findActiveAssignmentForAsset: jest.fn(async () => null),
      findDriverById: jest.fn(async (driverId: string) => ({ id: driverId })),
      transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
      lockAssetRef: jest.fn(async () => undefined),
      findOverlappingUsage: jest.fn(async () => null),
      enqueueEvent: jest.fn(async () => undefined),
    };
    return {
      repository,
      tx,
      usage: new UsageService(repository as unknown as FleetRepository),
    };
  }

  /** The refusal, and that it is the same one whatever the reason. */
  async function refusal(promise: Promise<unknown>): Promise<RastaError> {
    const error = await promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RastaError);
    const rasta = error as RastaError;
    expect(rasta.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(rasta.status).toBe(409);
    // Nothing of the stored record reaches the caller: no details, and the
    // message names neither the record nor any of its values.
    expect(rasta.details).toBeUndefined();
    expect(rasta.message).toBe('This clientReference was already used for a different request');
    return rasta;
  }

  describe('before validation', () => {
    it('replays the record to the same caller sending the same body, before any check', async () => {
      const request = dto();
      const { usage, repository } = setup({ before: storedRow(supervisor1, request) });

      const view = await as(supervisor1, () => usage.record(request));

      expect(view.id).toBe('USG_STORED');
      expect(view.hours).toBe('7.5');
      // Replay before validation: a resync of an accepted reading is not
      // re-judged by rules that may have changed since.
      expect(repository.findAssetRef).not.toHaveBeenCalled();
      expect(repository.transaction).not.toHaveBeenCalled();
    });

    it('recognises the same body in another key order', async () => {
      const request = dto({ notes: 'shift A' });
      const reordered = JSON.parse(
        JSON.stringify(Object.fromEntries(Object.entries(request).reverse())),
      ) as RecordUsageDto;
      const { usage } = setup({ before: storedRow(supervisor1, request) });

      await expect(as(supervisor1, () => usage.record(reordered))).resolves.toMatchObject({
        id: 'USG_STORED',
      });
    });

    it('refuses the same caller sending another body, with nothing of the record', async () => {
      const { usage, repository } = setup({ before: storedRow(supervisor1, dto()) });

      await refusal(as(supervisor1, () => usage.record(dto({ hours: '9.00' }))));
      expect(repository.transaction).not.toHaveBeenCalled();
    });

    it('refuses another caller sending the same body, exactly as a changed body', async () => {
      // Both may read every record of the organization: only the binding to
      // the caller refuses this one.
      const { usage } = setup({ before: storedRow(supervisor1, dto()) });

      const changed = await refusal(as(supervisor1, () => usage.record(dto({ hours: '9.00' }))));
      const colleague = await refusal(as(supervisor2, () => usage.record(dto())));

      expect(colleague.code).toBe(changed.code);
      expect(colleague.message).toBe(changed.message);
    });

    it("refuses a DRIVER replaying another driver's reference", async () => {
      const { usage } = setup({ before: storedRow(driverA, dto(), { driverId: DRIVER_A }) });

      await refusal(as(driverB, () => usage.record(dto())));
    });

    it('lets a DRIVER replay their own record', async () => {
      const { usage } = setup({ before: storedRow(driverA, dto(), { driverId: DRIVER_A }) });

      await expect(as(driverA, () => usage.record(dto()))).resolves.toMatchObject({
        id: 'USG_STORED',
      });
    });

    it('refuses the very request that created the record once its caller may no longer read it', async () => {
      // Recorded as a fleet manager under driver B; the same user is now only
      // a DRIVER with driver record A. `GET` would answer 404, so the replay
      // returns nothing either — the binding alone would have let it through.
      const creator = context({ userId: 'USR-DRIVER-A' });
      const { usage } = setup({ before: storedRow(creator, dto(), { driverId: DRIVER_B }) });

      await refusal(as(driverA, () => usage.record(dto())));
    });

    it('binds a service caller to its service', async () => {
      const { usage } = setup({ before: storedRow(service('maintenance-service'), dto()) });

      await expect(
        as(service('maintenance-service'), () => usage.record(dto())),
      ).resolves.toMatchObject({ id: 'USG_STORED' });
      await refusal(as(service('marketplace-service'), () => usage.record(dto())));
    });
  });

  describe('a row recorded before the binding (request_hash NULL)', () => {
    const legacy = (creator: RequestContext, overrides: Record<string, unknown> = {}) =>
      storedRow(creator, dto(), { requestHash: null, ...overrides });

    it('replays to the user who recorded it when every field is equal', async () => {
      // `7.5` stored, `7.50` sent: the column kept the number, not the text.
      const { usage } = setup({ before: legacy(supervisor1) });

      await expect(as(supervisor1, () => usage.record(dto()))).resolves.toMatchObject({
        id: 'USG_STORED',
      });
    });

    it.each([
      ['hours', { hours: '7.75' }],
      ['kilometres', { kilometres: '12' }],
      ['periodEnd', { periodEnd: '2026-08-01T13:00:00.000Z' }],
      ['notes', { notes: 'added' }],
      ['source', { source: 'TELEMATICS' as const }],
      ['driverId', { driverId: DRIVER_B }],
    ])('refuses the same user when %s differs', async (_field, change) => {
      const { usage } = setup({ before: legacy(supervisor1) });

      await refusal(as(supervisor1, () => usage.record(dto(change))));
    });

    it('refuses another user sending the same fields', async () => {
      const { usage } = setup({ before: legacy(supervisor1) });

      await refusal(as(supervisor2, () => usage.record(dto())));
    });

    it('never replays a row a service recorded: which service was not stored', async () => {
      const { usage } = setup({ before: legacy(service('maintenance-service')) });

      await refusal(as(service('maintenance-service'), () => usage.record(dto())));
    });
  });

  describe('under the asset lock', () => {
    it('replays a twin that committed while this request waited, before the overlap check', async () => {
      const request = dto();
      const { usage, repository, tx } = setup({ underLock: storedRow(supervisor1, request) });

      const view = await as(supervisor1, () => usage.record(request));

      expect(view.id).toBe('USG_STORED');
      expect(repository.findOverlappingUsage).not.toHaveBeenCalled();
      expect(tx.usageRecord.create).not.toHaveBeenCalled();
      expect(repository.enqueueEvent).not.toHaveBeenCalled();
    });

    it("refuses another caller's twin there too", async () => {
      const { usage, repository } = setup({ underLock: storedRow(supervisor2, dto()) });

      await refusal(as(supervisor1, () => usage.record(dto())));
      expect(repository.findOverlappingUsage).not.toHaveBeenCalled();
    });
  });

  describe('after a unique violation', () => {
    it('replays the winner to the same caller with the same body', async () => {
      const request = dto();
      const { usage } = setup(
        { afterViolation: storedRow(supervisor1, request) },
        { insertFails: true },
      );

      await expect(as(supervisor1, () => usage.record(request))).resolves.toMatchObject({
        id: 'USG_STORED',
      });
    });

    it('refuses a winner whose body differs', async () => {
      const { usage } = setup(
        { afterViolation: storedRow(supervisor1, dto({ hours: '1.00' })) },
        { insertFails: true },
      );

      await refusal(as(supervisor1, () => usage.record(dto())));
    });

    it("refuses another caller's winner", async () => {
      const { usage } = setup(
        { afterViolation: storedRow(supervisor2, dto()) },
        { insertFails: true },
      );

      await refusal(as(supervisor1, () => usage.record(dto())));
    });
  });

  it('stores the binding on a new record', async () => {
    const request = dto();
    const { usage, tx } = setup();

    await as(supervisor1, () => usage.record(request));

    const data = tx.usageRecord.create.mock.calls[0]![0].data;
    expect(data.requestHash).toBe(runWithContext(supervisor1, () => usageRequestHash(request)));
    expect(data.requestHash).not.toBe(runWithContext(supervisor2, () => usageRequestHash(request)));
  });

  it('stores no binding on a record with no reference', async () => {
    const { usage, tx, repository } = setup();

    await as(supervisor1, () => usage.record(dto({ clientReference: undefined })));

    expect(tx.usageRecord.create.mock.calls[0]![0].data.requestHash).toBeNull();
    expect(repository.findUsageByClientReference).not.toHaveBeenCalled();
  });
});
