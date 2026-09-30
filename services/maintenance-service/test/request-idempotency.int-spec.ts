import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { RequestService } from '../src/maintenance/request.service';
import { RepairOrderService } from '../src/maintenance/repair-order.service';
import { UnverifiedWorkshopDirectory } from '../src/maintenance/workshop.directory';
import { CREATE_REQUEST_ENDPOINT, RequestController } from '../src/maintenance/request.controller';
import { IdempotencyStore } from '../src/maintenance/idempotency';
import type { CreateRequestDto } from '../src/maintenance/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, tenants } from './helpers';

/**
 * Idempotency-Key on POST /v1/maintenance-requests (#157, docs/06 § 6.8),
 * against real PostgreSQL. The controller is driven directly with the real
 * service and store, so every claim is about what the database holds: how
 * many requests exist, and what each caller was answered.
 */
describe('maintenance request creation under an Idempotency-Key', () => {
  let prisma: PrismaService;
  let requests: RequestService;
  let store: IdempotencyStore;
  let controller: RequestController;

  const org = tenants();
  const reporter = 'USR-ITEST-REPORTER';

  beforeAll(async () => {
    prisma = newPrisma();
    const repository = new MaintenanceRepository(prisma);
    requests = new RequestService(repository);
    store = new IdempotencyStore(prisma, { MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24 });
    controller = new RequestController(
      requests,
      new RepairOrderService(repository, new UnverifiedWorkshopDirectory()),
      store,
    );
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  async function machine(organizationId = org.a): Promise<string> {
    const assetId = id('AST-ITEST');
    await seedAsset(prisma, assetId, organizationId);
    return assetId;
  }

  const breakdown = (assetId: string, title = 'نشتی روغن'): CreateRequestDto => ({
    assetId,
    type: 'CORRECTIVE',
    severity: 'HIGH',
    title,
  });

  const create = (
    dto: CreateRequestDto,
    key: string | undefined,
    { organizationId = org.a, userId = reporter } = {},
  ) => asActor({ organizationId, userId }, () => controller.create(dto, key));

  const requestsFor = (assetId: string) =>
    prisma.client.$queryRawUnsafe<{ id: string; organization_id: string }[]>(
      'SELECT id, organization_id FROM maintenance_request WHERE asset_id = $1',
      assetId,
    );

  const keyRow = (organizationId: string, key: string) =>
    prisma.client.$queryRawUnsafe<{ state: string; claim_token: string; request_hash: string }[]>(
      'SELECT state, claim_token, request_hash FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2 AND key = $3',
      organizationId,
      CREATE_REQUEST_ENDPOINT,
      key,
    );

  it('answers a concurrent double submit once: one request, and both callers get the same 201 body', async () => {
    const assetId = await machine();
    const key = id('KEY');

    const [first, second] = await Promise.all([
      create(breakdown(assetId), key),
      create(breakdown(assetId), key),
    ]);

    expect(second).toEqual(first);
    const rows = await requestsFor(assetId);
    expect(rows.map((row) => row.id)).toEqual([(first as { id: string }).id]);
    expect((await keyRow(org.a, key))[0]?.state).toBe('COMPLETED');
  });

  it('replays a retry after completion instead of raising the work again', async () => {
    const assetId = await machine();
    const key = id('KEY');

    const original = await create(breakdown(assetId), key);
    const retry = await create(breakdown(assetId), key);

    expect(retry).toEqual(original);
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('does not raise the work again after the first request was closed, while the key is live', async () => {
    // Without the key this retry would succeed: the duplicate-open control
    // no longer applies once the first request is cancelled.
    const assetId = await machine();
    const key = id('KEY');

    const original = (await create(breakdown(assetId), key)) as { id: string; status: string };
    await asActor({ organizationId: org.a, userId: reporter }, () =>
      requests.cancel(original.id, { reason: 'reported twice by mistake' }),
    );

    const retry = await create(breakdown(assetId), key);

    expect(retry).toEqual(original);
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('refuses the same key with a different body, or from another user, and writes nothing', async () => {
    const assetId = await machine();
    const key = id('KEY');
    await create(breakdown(assetId), key);

    await expect(create(breakdown(assetId, 'another title'), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    // A DRIVER sees only what they reported: another user's key is never
    // answered with this request.
    await expect(
      create(breakdown(assetId), key, { userId: 'USR-ITEST-SOMEONE-ELSE' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('keeps keys per tenant: the same key in two organizations is two requests', async () => {
    const key = id('KEY');
    const inA = await machine(org.a);
    const inB = await machine(org.b);

    const a = (await create(breakdown(inA), key, { organizationId: org.a })) as { id: string };
    const b = (await create(breakdown(inB), key, { organizationId: org.b })) as { id: string };

    expect(a.id).not.toBe(b.id);
    expect((await requestsFor(inA)).map((row) => row.organization_id)).toEqual([org.a]);
    expect((await requestsFor(inB)).map((row) => row.organization_id)).toEqual([org.b]);
    expect(await keyRow(org.a, key)).toHaveLength(1);
    expect(await keyRow(org.b, key)).toHaveLength(1);
  });

  it('fences a stale claim: A’s late complete or release after expiry and B’s re-claim changes nothing', async () => {
    const key = id('KEY');
    const body = { anything: 'the same request' };
    await asActor({ organizationId: org.a, userId: reporter }, async () => {
      const a = await store.claim(CREATE_REQUEST_ENDPOINT, key, body);
      if (a.kind !== 'PROCEED') throw new Error('A should own the key');

      // A's claim expires while its work is still running.
      await prisma.client.$executeRawUnsafe(
        `UPDATE idempotency_key SET expires_at = now() - interval '1 second' WHERE organization_id = $1 AND key = $2`,
        org.a,
        key,
      );

      const b = await store.claim(CREATE_REQUEST_ENDPOINT, key, body);
      if (b.kind !== 'PROCEED') throw new Error('B should re-claim the expired key');
      expect(b.token).not.toBe(a.token);

      await store.complete(CREATE_REQUEST_ENDPOINT, key, a.token, 201, { from: 'A' });
      await store.release(CREATE_REQUEST_ENDPOINT, key, a.token);
      expect(await keyRow(org.a, key)).toEqual([
        expect.objectContaining({ state: 'IN_PROGRESS', claim_token: b.token }),
      ]);

      await store.complete(CREATE_REQUEST_ENDPOINT, key, b.token, 201, { from: 'B' });
      await store.release(CREATE_REQUEST_ENDPOINT, key, a.token);
      const replay = await store.claim(CREATE_REQUEST_ENDPOINT, key, body);
      expect(replay).toEqual({ kind: 'REPLAY', status: 201, body: { from: 'B' } });
    });
  });

  it('releases the key when the work fails, so a corrected retry can run', async () => {
    const key = id('KEY');
    const missing = id('AST-ITEST-MISSING');

    await expect(create(breakdown(missing), key)).rejects.toBeDefined();
    expect(await keyRow(org.a, key)).toEqual([]);

    const assetId = await machine();
    const created = (await create(breakdown(assetId), key)) as { id: string };
    expect((await requestsFor(assetId)).map((row) => row.id)).toEqual([created.id]);
  });

  it('keeps the create path as it was when no key is sent', async () => {
    const assetId = await machine();

    await create(breakdown(assetId), undefined);
    await expect(create(breakdown(assetId), undefined)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
    expect(await requestsFor(assetId)).toHaveLength(1);
  });

  it('refuses a key that is present but too short, rather than ignoring it', async () => {
    const assetId = await machine();
    await expect(create(breakdown(assetId), 'short')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await requestsFor(assetId)).toHaveLength(0);
  });
});
