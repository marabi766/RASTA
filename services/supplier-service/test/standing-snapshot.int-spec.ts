import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  apiTenant,
  auditorActor,
  internalToken,
  platformAdmin,
  procurementUser,
  startApi,
  supplierActor,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * The standing snapshot construction-service bootstraps from (ADR-061 § 4,
 * CON-002 PR 5), over HTTP through the real application.
 *
 * Three things are proven: **who may ask** (construction-service, with a token
 * signed for no tenant, and nobody else — not a person with any role, not another
 * service, not construction-service acting for a tenant), **what comes back**
 * (identifiers and instants about standing, nothing a person typed), and **that
 * paging is a page** (a cursor walks every supplier once). The consumer side of the
 * same contract is `services/construction-service/test/supplier-snapshot-client.int-spec.ts`.
 */
describe('supplier standing snapshot', () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  const platformOrg = apiTenant('SNAP-PLATFORM');
  const orgs = {
    approved: apiTenant('SNAP-APPROVED'),
    suspended: apiTenant('SNAP-SUSPENDED'),
    lifted: apiTenant('SNAP-LIFTED'),
    workshop: apiTenant('SNAP-WORKSHOP'),
    pending: apiTenant('SNAP-PENDING'),
    neverQualified: apiTenant('SNAP-NEVER'),
  };
  const organizations = [platformOrg, ...Object.values(orgs)];
  const ids: Record<string, string> = {};

  const asSupplier = (org: string) => `Bearer ${supplierActor(org)}`;
  const asPlatform = () => `Bearer ${platformAdmin(platformOrg)}`;

  async function register(key: keyof typeof orgs, capabilities: string[]) {
    const created = await http()
      .post('/v1/suppliers')
      .set('authorization', asSupplier(orgs[key]))
      .send({ displayName: `Name of ${key} that must never leave`, capabilities })
      .expect(201);
    ids[key] = created.body.id as string;
  }

  async function qualify(key: keyof typeof orgs, capability: string, decide: boolean) {
    const submitted = await http()
      .post(`/v1/suppliers/${ids[key]}/qualifications`)
      .set('authorization', asSupplier(orgs[key]))
      .send({
        capability,
        statement: 'private statement',
        evidence: [{ documentId: `DOC-${key}` }],
      })
      .expect(201);
    if (decide) {
      await http()
        .post(`/v1/suppliers/${ids[key]}/qualifications/${submitted.body.id}/approve`)
        .set('authorization', asPlatform())
        .send({ note: 'private reviewer note' })
        .expect(200);
    }
  }

  const suspend = (key: keyof typeof orgs) =>
    http()
      .post(`/v1/suppliers/${ids[key]}/suspend`)
      .set('authorization', asPlatform())
      .send({ reason: 'A private reason for suspending' })
      .expect(200);
  const reinstate = (key: keyof typeof orgs) =>
    http()
      .post(`/v1/suppliers/${ids[key]}/reinstate`)
      .set('authorization', asPlatform())
      .send({ reason: 'A private reason for lifting it' })
      .expect(200);

  const snapshot = async (query = 'limit=200', token?: string) =>
    http()
      .get(`/v1/suppliers/standing-snapshot?${query}`)
      .set('x-internal-token', token ?? (await internalToken('construction-service')));

  /** Every page, following the cursor. */
  async function everything(limit: number) {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 500; pages += 1) {
      const response = await snapshot(`limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      items.push(...response.body.items);
      if (!response.body.hasMore) return items;
      cursor = response.body.nextCursor as string;
    }
    throw new Error('the snapshot never ended');
  }

  beforeAll(async () => {
    api = await startApi();
    await cleanup(api.prisma, organizations);

    await register('approved', ['CONTRACTING']);
    await qualify('approved', 'CONTRACTING', true);

    await register('suspended', ['CONTRACTING']);
    await qualify('suspended', 'CONTRACTING', true);
    await suspend('suspended');

    await register('lifted', ['CONTRACTING']);
    await qualify('lifted', 'CONTRACTING', true);
    await suspend('lifted');
    await reinstate('lifted');

    await register('workshop', ['WORKSHOP_SERVICE']);
    await qualify('workshop', 'WORKSHOP_SERVICE', true);

    await register('pending', ['CONTRACTING']);
    await qualify('pending', 'CONTRACTING', false);

    await register('neverQualified', ['CONTRACTING']);
    await suspend('neverQualified');
  }, 180_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  describe('who may ask', () => {
    it('answers construction-service with a platform-wide token', async () => {
      const response = await snapshot();
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual([
        'hasMore',
        'items',
        'nextCursor',
        'snapshotAt',
      ]);
      expect(Array.isArray(response.body.items)).toBe(true);
      expect(response.body.snapshotAt).toMatch(/Z$/);
    });

    it('refuses everybody else: no token, a person with any role, another service, a tenant-signed token, a relay', async () => {
      const path = '/v1/suppliers/standing-snapshot?limit=10';
      expect((await http().get(path)).status).toBe(401);

      for (const bearer of [
        asPlatform(),
        asSupplier(orgs.approved),
        `Bearer ${procurementUser(orgs.approved)}`,
        `Bearer ${auditorActor(orgs.approved)}`,
      ]) {
        expect((await http().get(path).set('authorization', bearer)).status).toBe(403);
      }

      for (const token of [
        await internalToken('marketplace-service'),
        await internalToken('fleet-service'),
        // construction-service, but acting for a tenant: a platform-wide read is not that.
        await internalToken('construction-service', { organizationId: orgs.approved }),
      ]) {
        expect((await http().get(path).set('x-internal-token', token)).status).toBe(403);
      }

      const relay = await internalToken('construction-service', { purpose: 'RELAY' });
      expect((await http().get(path).set('x-internal-token', relay)).status).toBe(401);
    });

    it('refuses fields it does not know and a limit past the platform bound', async () => {
      expect((await snapshot('limit=10&organizationId=ORG-X')).status).toBe(400);
      expect((await snapshot('limit=201')).status).toBe(400);
      expect((await snapshot('limit=0')).status).toBe(400);
    });
  });

  describe('what comes back', () => {
    it('carries each supplier that has anything to say about standing, and only identifiers and instants', async () => {
      const items = await everything(200);
      const byOrg = new Map(items.map((i) => [i.organizationId as string, i]));

      expect(byOrg.get(orgs.approved)).toEqual({
        organizationId: orgs.approved,
        contractingApprovedAt: expect.stringMatching(/Z$/),
        suspensions: [],
      });
      expect(byOrg.get(orgs.suspended)).toMatchObject({
        contractingApprovedAt: expect.stringMatching(/Z$/),
        suspensions: [
          {
            suspensionId: expect.any(String),
            suspendedAt: expect.stringMatching(/Z$/),
            reinstatedAt: null,
          },
        ],
      });
      // A lifted episode is still carried, with its lift, so a late old event converges.
      expect(byOrg.get(orgs.lifted)).toMatchObject({
        suspensions: [{ reinstatedAt: expect.stringMatching(/Z$/) }],
      });
      // Suspended before it was ever qualified: present, with no approval.
      expect(byOrg.get(orgs.neverQualified)).toMatchObject({
        contractingApprovedAt: null,
        suspensions: [{ reinstatedAt: null }],
      });
      // Nothing to say about standing: qualified only for something else, or still undecided.
      expect(byOrg.has(orgs.workshop)).toBe(false);
      expect(byOrg.has(orgs.pending)).toBe(false);
    });

    it('leaks nothing a person typed: no name, reason, note, statement, evidence or actor', async () => {
      const text = JSON.stringify(await everything(200));
      for (const secret of [
        'must never leave',
        'private',
        'DOC-',
        'reason',
        'note',
        'statement',
        'decidedBy',
        'suspendedBy',
        'displayName',
      ]) {
        expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
      }
    });

    it('agrees with the suspension record: the open episode is the one in the snapshot', async () => {
      const items = await everything(200);
      const mine = items.find((i) => i.organizationId === orgs.suspended) as {
        suspensions: { suspensionId: string }[];
      };
      const row = await runUnscoped('the suite reads the episode it wrote', () =>
        api.prisma.client.suspension.findFirst({ where: { supplierId: ids.suspended } }),
      );
      expect(mine.suspensions.map((s) => s.suspensionId)).toEqual([row!.id]);
    });
  });

  describe('one contractor, now (authoritative)', () => {
    const one = async (organizationId: string, token?: string) =>
      http()
        .get(`/v1/suppliers/standing-snapshot/${organizationId}`)
        .set('x-internal-token', token ?? (await internalToken('construction-service')));

    it('answers who is approved and who is suspended, with the episodes', async () => {
      const approved = await one(orgs.approved);
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({
        organizationId: orgs.approved,
        contractingApprovedAt: expect.stringMatching(/Z$/),
        suspensions: [],
        asOf: expect.stringMatching(/Z$/),
      });

      const suspended = await one(orgs.suspended);
      expect(suspended.body.suspensions).toEqual([
        {
          suspensionId: expect.any(String),
          suspendedAt: expect.stringMatching(/Z$/),
          reinstatedAt: null,
        },
      ]);
      expect((await one(orgs.lifted)).body.suspensions[0].reinstatedAt).toMatch(/Z$/);
      expect((await one(orgs.neverQualified)).body.contractingApprovedAt).toBeNull();
    });

    it('is a 200 with nothing for an organization it has no profile for, and for one not qualified for CONTRACTING', async () => {
      for (const org of ['ORG-NOBODY-HERE', orgs.workshop, orgs.pending]) {
        const response = await one(org);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          organizationId: org,
          contractingApprovedAt: null,
          suspensions: [],
        });
      }
    });

    it('reads the moment it is asked: a suspension just committed is in the next answer', async () => {
      // The delayed-outbox case: committed here, not yet relayed to any consumer.
      expect((await one(orgs.approved)).body.suspensions).toEqual([]);
      await suspend('approved');
      const now = await one(orgs.approved);
      expect(now.body.suspensions).toHaveLength(1);
      expect(now.body.suspensions[0].reinstatedAt).toBeNull();
      await reinstate('approved');
      expect((await one(orgs.approved)).body.suspensions[0].reinstatedAt).toMatch(/Z$/);
    });

    it('has the same access as the snapshot: construction-service with a tenant-less token, nobody else', async () => {
      const path = `/v1/suppliers/standing-snapshot/${orgs.approved}`;
      expect((await http().get(path)).status).toBe(401);
      for (const bearer of [asPlatform(), asSupplier(orgs.approved)]) {
        expect((await http().get(path).set('authorization', bearer)).status).toBe(403);
      }
      for (const token of [
        await internalToken('marketplace-service'),
        await internalToken('construction-service', { organizationId: orgs.approved }),
      ]) {
        expect((await one(orgs.approved, token)).status).toBe(403);
      }
    });

    it('leaks nothing a person typed', async () => {
      const text = JSON.stringify([
        (await one(orgs.suspended)).body,
        (await one(orgs.lifted)).body,
      ]);
      for (const secret of ['must never leave', 'private', 'DOC-', 'reason', 'note']) {
        expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
      }
    });
  });

  describe('paging', () => {
    it('walks every supplier exactly once with a small page, in id order', async () => {
      const small = await everything(1);
      const large = await everything(200);

      expect(small.map((i) => i.organizationId)).toEqual(large.map((i) => i.organizationId));
      expect(new Set(small.map((i) => i.organizationId)).size).toBe(small.length);
      const ours = [orgs.approved, orgs.suspended, orgs.lifted, orgs.neverQualified];
      for (const org of ours) expect(small.map((i) => i.organizationId)).toContain(org);
    });
  });
});
