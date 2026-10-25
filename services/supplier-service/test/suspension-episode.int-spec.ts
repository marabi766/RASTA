import request from 'supertest';
import { isRastaError, runUnscoped } from '@rasta/nest-common';
import type { SuspensionWrite } from '../src/supplier/supplier.repository';
import {
  asOperator,
  asSupplier,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';
import { apiTenant, platformAdmin, startApi, supplierActor, type ApiHarness } from './api-helpers';

/**
 * A suspension command names the episode it was decided on, and the service
 * enforces it atomically (Codex review of PR 366, finding 2).
 *
 * Before: reinstating lifted "whichever episode is open now". An operator who
 * opened the reinstatement form during episode A and sent it after another
 * operator had lifted A and suspended the supplier again (episode B) lifted B,
 * with the explanation written for A, and `SUPPLIER_REINSTATED` named B. The
 * same cycle seen from the suspend form suspended the supplier again on a
 * reason written before the intervening episode.
 *
 * Against PostgreSQL, because the property is about when the comparison runs:
 * after the status flip has locked the supplier row, inside the transaction.
 * The race cases interleave a real committed cycle between the service's
 * pre-check (which passes) and its write, so a comparison made only on the
 * earlier read would let the stale command through.
 */
describe('a suspension command is bound to the episode it was decided on', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function aSupplier(): Promise<{ org: string; id: string }> {
    const org = newOrganizationId();
    organizations.push(org);
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    return { org, id: supplier.id };
  }

  const suspend = (id: string, latestSuspensionId: string | null, reason = 'A stated reason') =>
    asOperator(() => w.suspensions.suspend(id, { reason, latestSuspensionId }));
  const reinstate = (id: string, suspensionId: string, reason = 'A stated lifting') =>
    asOperator(() => w.suspensions.reinstate(id, { reason, suspensionId }));

  async function episodes(id: string) {
    return runUnscoped('the suite reads the episodes directly', () =>
      w.prisma.client.suspension.findMany({
        where: { supplierId: id },
        orderBy: [{ suspendedAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!isRastaError(error)) throw new Error(`expected a platform error, got ${String(error)}`);
    return error;
  }

  const EPISODE_CHANGED = (path: string) => ({
    status: 409,
    code: 'OPTIMISTIC_LOCK_FAILED',
    details: [expect.objectContaining({ path, code: 'SUSPENSION_EPISODE_CHANGED' })],
  });

  /** Suspended (A), lifted, suspended again (B) — each by another operator. */
  async function inSecondEpisode() {
    const supplier = await aSupplier();
    const a = (await suspend(supplier.id, null, 'The first stated reason')).suspensions[0]!.id;
    await reinstate(supplier.id, a, 'The first episode was resolved');
    const b = (await suspend(supplier.id, a, 'The second stated reason')).suspensions[0]!.id;
    return { ...supplier, a, b };
  }

  describe('reinstating', () => {
    it('refuses to lift episode B with a form read during episode A, and writes nothing', async () => {
      const { org, id, a, b } = await inSecondEpisode();
      const eventsBefore = await outboxFor(w.prisma, org);

      const error = await refusal(reinstate(id, a, 'Meant for the first episode'));

      expect(error).toMatchObject(EPISODE_CHANGED('suspensionId'));
      const rows = await episodes(id);
      expect(rows.map((row) => [row.id, row.reinstatedAt === null])).toEqual([
        [a, false],
        [b, true],
      ]);
      expect(rows[1]!.reinstatementNote).toBeNull();
      expect(rows[0]!.reinstatementNote).toBe('The first episode was resolved');
      const supplier = await w.repository.findSupplier(id);
      expect(supplier?.status).toBe('SUSPENDED');
      expect(await outboxFor(w.prisma, org)).toHaveLength(eventsBefore.length);
    });

    it('lifts B when the command names B, and announces B', async () => {
      const { org, id, b } = await inSecondEpisode();

      const reinstated = await reinstate(id, b, 'The second episode was resolved');

      expect(reinstated.status).toBe('ACTIVE');
      const last = (await outboxFor(w.prisma, org)).at(-1)!;
      expect(last.eventName).toBe('SUPPLIER_REINSTATED');
      expect(last.aggregateId).toBe(b);
    });

    it('refuses when the cycle commits between the pre-check and the write', async () => {
      // The read before the transaction sees A open, so `assertReinstatable`
      // passes; another operator then lifts A and suspends again before this
      // command's transaction flips the status. Only the comparison inside the
      // transaction can see that.
      const supplier = await aSupplier();
      const a = (await suspend(supplier.id, null)).suspensions[0]!.id;
      const original = w.repository.closeSuspension.bind(w.repository);
      let b: string | null = null;
      let interleaved = false;
      jest
        .spyOn(w.repository, 'closeSuspension')
        .mockImplementation(async (tx, input): Promise<SuspensionWrite> => {
          if (!interleaved) {
            interleaved = true;
            await reinstate(supplier.id, a, 'Another operator lifted it first');
            b = (await suspend(supplier.id, a, 'And suspended it again')).suspensions[0]!.id;
          }
          return original(tx, input);
        });

      const error = await refusal(reinstate(supplier.id, a, 'The stale lifting'));

      expect(interleaved).toBe(true);
      expect(error).toMatchObject(EPISODE_CHANGED('suspensionId'));
      const rows = await episodes(supplier.id);
      expect(rows.map((row) => row.id)).toEqual([a, b]);
      expect(rows[0]!.reinstatementNote).toBe('Another operator lifted it first');
      expect(rows[1]!.reinstatedAt).toBeNull();
      expect((await w.repository.findSupplier(supplier.id))?.status).toBe('SUSPENDED');
      expect(
        (await outboxFor(w.prisma, supplier.org)).filter(
          (row) => row.eventName === 'SUPPLIER_REINSTATED',
        ),
      ).toHaveLength(1);
    });
  });

  describe('suspending', () => {
    it('refuses a suspension decided before another episode was opened and closed', async () => {
      const supplier = await aSupplier();
      const a = (await suspend(supplier.id, null)).suspensions[0]!.id;
      await reinstate(supplier.id, a);
      const eventsBefore = await outboxFor(w.prisma, supplier.org);

      const error = await refusal(suspend(supplier.id, null, 'Read before the first episode'));

      expect(error).toMatchObject(EPISODE_CHANGED('latestSuspensionId'));
      expect((await episodes(supplier.id)).map((row) => row.id)).toEqual([a]);
      expect((await w.repository.findSupplier(supplier.id))?.status).toBe('ACTIVE');
      expect(await outboxFor(w.prisma, supplier.org)).toHaveLength(eventsBefore.length);

      const suspended = await suspend(supplier.id, a, 'Read after the first episode');
      expect(suspended.status).toBe('SUSPENDED');
      expect(suspended.suspensions).toHaveLength(2);
    });

    it('refuses when the cycle commits between the pre-check and the write', async () => {
      const supplier = await aSupplier();
      const original = w.repository.openSuspension.bind(w.repository);
      let interleaved = false;
      jest
        .spyOn(w.repository, 'openSuspension')
        .mockImplementation(async (tx, input): Promise<SuspensionWrite> => {
          if (!interleaved) {
            interleaved = true;
            const a = (await suspend(supplier.id, null, 'Another operator suspended'))
              .suspensions[0]!.id;
            await reinstate(supplier.id, a, 'And lifted it again');
          }
          return original(tx, input);
        });

      const error = await refusal(suspend(supplier.id, null, 'The stale suspension'));

      expect(interleaved).toBe(true);
      expect(error).toMatchObject(EPISODE_CHANGED('latestSuspensionId'));
      expect(await episodes(supplier.id)).toHaveLength(1);
      expect((await w.repository.findSupplier(supplier.id))?.status).toBe('ACTIVE');
    });
  });
});

describe('the episode refusal over HTTP', () => {
  let api: ApiHarness;
  const supplierOrg = apiTenant('EPISODE-SUPPLIER');
  const platformOrg = apiTenant('EPISODE-PLATFORM');

  beforeAll(async () => {
    api = await startApi();
    await cleanup(api.prisma, [supplierOrg]);
  });

  afterAll(async () => {
    await cleanup(api.prisma, [supplierOrg]);
    await api.close();
  });

  it('answers 409 OPTIMISTIC_LOCK_FAILED with the closed detail code, and requires the field', async () => {
    const http = () => request(api.app.getHttpServer());
    const operator = `Bearer ${platformAdmin(platformOrg)}`;
    const registered = await http()
      .post('/v1/suppliers')
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] })
      .expect(201);
    const path = `/v1/suppliers/${registered.body.id}`;

    // The expectation is required: an omitted one would be an unchecked one.
    await http()
      .post(`${path}/suspend`)
      .set('authorization', operator)
      .send({ reason: 'A stated reason' })
      .expect(400);

    const first = await http()
      .post(`${path}/suspend`)
      .set('authorization', operator)
      .send({ reason: 'A stated reason', latestSuspensionId: null })
      .expect(200);
    const a = first.body.suspensions[0].id as string;

    await http()
      .post(`${path}/reinstate`)
      .set('authorization', operator)
      .send({ reason: 'A stated lifting' })
      .expect(400);
    await http()
      .post(`${path}/reinstate`)
      .set('authorization', operator)
      .send({ reason: 'A stated lifting', suspensionId: a })
      .expect(200);
    await http()
      .post(`${path}/suspend`)
      .set('authorization', operator)
      .send({ reason: 'A second stated reason', latestSuspensionId: a })
      .expect(200);

    const stale = await http()
      .post(`${path}/reinstate`)
      .set('authorization', operator)
      .send({ reason: 'Meant for the first episode', suspensionId: a })
      .expect(409);

    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
    expect(stale.body.details).toEqual([
      expect.objectContaining({ path: 'suspensionId', code: 'SUSPENSION_EPISODE_CHANGED' }),
    ]);
  });
});
