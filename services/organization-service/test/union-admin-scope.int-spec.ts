import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { OrganizationService } from '../src/organization/organization.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl } from './helpers';

/**
 * Tenant isolation for `UNION_ADMIN` in the organization registry
 * (`docs/24` Q-80, provisional answer, 2026-09-28).
 *
 * A union administrator used to be this service's platform operator: acting
 * for its own union it read, restructured, suspended and set policy for any
 * organization. It now has the scope every other role has — its own
 * organization and what is beneath it — and `SYSTEM_ADMIN` is the only
 * operator. Creating a root, moving and changing status are the operator's
 * alone, even inside the union's own subtree.
 *
 * Booted from the **real** `AppModule`: the real `AuthGuard`, the ADR-060
 * tenant-bound role resolution (`org_roles` → the roles of the organization
 * the request resolves to), `RolesGuard`, the error filter and PostgreSQL.
 * Only the user-token verifier is a claims stub and the Kafka publisher and
 * relay are inert (outbox rows are still written — and counted).
 *
 * The tree, as in the seed: the union is **beside** the county, not above it.
 *
 *   province
 *   ├── union ── unionChild
 *   └── county ── dehyari
 */

const SECRET = randomBytes(24).toString('hex');
const inertRelay = { start: () => undefined, stop: async () => undefined };

interface TestClaims {
  /** The organization the token is active for (`org_id`). */
  active: string;
  /** `org_roles`: the roles held in each organization. */
  orgRoles: Record<string, string[]>;
  /** Realm roles; only the global ones (`SYSTEM_ADMIN`) are ever read. */
  realm?: string[];
}

const bearer = (claims: TestClaims) =>
  `Bearer test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;

describe('UNION_ADMIN in the organization registry (docs/24 Q-80)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let province: string;
  let union: string;
  let unionChild: string;
  let county: string;
  let dehyari: string;
  const created: string[] = [];

  let unionAdmin: string;
  let systemAdmin: string;
  /** The union administrator's own token, acting for the dehyari where it is only a DRIVER. */
  let unionAdminAsDriver: string;
  /** A union administrator who is also ORGANIZATION_ADMIN of the county beside it. */
  let unionAndCountyAdmin: string;

  const http = () => request(app.getHttpServer());
  const missing = () => `ORG_${ulid()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl();
    process.env.OIDC_ISSUER_URL ??= 'http://union-scope.invalid/realms/rasta';
    process.env.OIDC_JWKS_URI ??= 'http://union-scope.invalid/realms/rasta/certs';
    process.env.OIDC_AUDIENCE ??= 'rasta-api';
    process.env.INTERNAL_TOKEN_SECRET = SECRET;
    process.env.KAFKA_BROKERS ??= 'localhost:9092';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KafkaEventPublisher)
      .useValue(new InMemoryEventPublisher())
      .overrideProvider(OutboxRelay)
      .useValue(inertRelay)
      .overrideProvider(AUTH_OPTIONS)
      .useFactory({
        factory: (): AuthGuardOptions => ({
          serviceName: 'organization-service',
          internalTokens: new InternalTokenService(SECRET, 'rasta-internal', 300),
          tokenVerifier: {
            verifyUserToken: async (token: string) => {
              const [prefix, encoded] = token.split('.');
              if (prefix !== 'test' || !encoded) throw RastaError.unauthenticated('Malformed');
              const claims = JSON.parse(
                Buffer.from(encoded, 'base64url').toString('utf8'),
              ) as TestClaims;
              return {
                sub: `sub-${claims.active}`,
                rastaUserId: `USR-UNION-SCOPE-${ulid().slice(-8)}`,
                organizationId: claims.active,
                organizationIds: Object.keys(claims.orgRoles),
                organizationRoles: Object.entries(claims.orgRoles).flatMap(([org, roles]) =>
                  roles.map((role) => `${org}:${role}`),
                ),
                roles: claims.realm ?? [],
                username: 'union-scope-test',
                expiresAt: Date.now() + 60_000,
              };
            },
          } as unknown as TokenVerifier,
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    prisma = app.get(PrismaService);

    const organizations = moduleRef.get(OrganizationService);
    const create = async (name: string, type: string, parentId?: string, withPoint = false) => {
      const row = await asActor(
        { organizationId: 'ORG-UNION-SCOPE-OPERATOR', roles: ['SYSTEM_ADMIN'] },
        () =>
          organizations.create({
            name,
            type,
            metadata: {},
            ...(parentId ? { parentId } : {}),
            ...(withPoint
              ? { location: { kind: 'PRIMARY', coordinate: { latitude: 31.9, longitude: 54.36 } } }
              : {}),
          } as never),
      );
      created.push(row.id);
      return row.id;
    };
    const tag = ulid().slice(-6);
    province = await create(`استان آزمون ${tag}`, 'GOVERNMENT');
    union = await create('اتحادیه آزمون', 'UNION', province, true);
    unionChild = await create('واحد اتحادیه', 'COOPERATIVE', union, true);
    county = await create('شهرستان آزمون', 'GOVERNMENT', province, true);
    dehyari = await create('دهیاری آزمون', 'DEHYARI', county, true);

    unionAdmin = bearer({
      active: union,
      orgRoles: { [union]: ['UNION_ADMIN'], [dehyari]: ['DRIVER'] },
    });
    unionAdminAsDriver = unionAdmin;
    unionAndCountyAdmin = bearer({
      active: union,
      orgRoles: { [union]: ['UNION_ADMIN'], [county]: ['ORGANIZATION_ADMIN'] },
    });
    systemAdmin = bearer({
      active: union,
      orgRoles: { [union]: ['ORGANIZATION_ADMIN'] },
      realm: ['SYSTEM_ADMIN'],
    });
  });

  afterAll(async () => {
    if (prisma && created.length > 0) {
      // Children first: the tree is deleted leaf-up.
      for (const id of [...created].reverse()) {
        await prisma.client.$executeRawUnsafe(
          `DELETE FROM organization_policy WHERE organization_id = $1`,
          id,
        );
        await prisma.client.$executeRawUnsafe(
          `DELETE FROM organization_contact WHERE organization_id = $1`,
          id,
        );
        await prisma.client.$executeRawUnsafe(
          `DELETE FROM organization_location WHERE organization_id = $1`,
          id,
        );
      }
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM organization WHERE path <@ (SELECT path FROM organization WHERE id = $1)`,
        province,
      );
    }
    await app?.close();
  });

  /** A 404 body with what differs per request (correlation, time, path) set aside. */
  function shape(body: Record<string, unknown>) {
    const { correlationId: _c, timestamp: _t, path: _p, traceId: _r, ...rest } = body;
    return rest;
  }

  /** Every row a write could leave behind, for the organizations named. */
  async function footprint(ids: string[]) {
    const count = async (sql: string) =>
      Number(((await prisma.client.$queryRawUnsafe(sql, ids)) as { n: bigint }[])[0]?.n ?? 0);
    return {
      outbox: await count(`SELECT count(*) AS n FROM outbox_message WHERE aggregate_id = ANY($1)`),
      children: await count(`SELECT count(*) AS n FROM organization WHERE parent_id = ANY($1)`),
      policies: await count(
        `SELECT count(*) AS n FROM organization_policy WHERE organization_id = ANY($1)`,
      ),
      contacts: await count(
        `SELECT count(*) AS n FROM organization_contact WHERE organization_id = ANY($1)`,
      ),
      locations: await count(
        `SELECT count(*) AS n FROM organization_location WHERE organization_id = ANY($1)`,
      ),
      versions: await count(
        `SELECT coalesce(sum(version), 0) AS n FROM organization WHERE id = ANY($1)`,
      ),
      statuses: (
        (await prisma.client.$queryRawUnsafe(
          `SELECT string_agg(status::text, ',' ORDER BY id) AS s FROM organization WHERE id = ANY($1)`,
          ids,
        )) as { s: string }[]
      )[0]?.s,
    };
  }

  const policy = {
    key: 'approval.project.threshold_minor',
    value: '1000000',
    inheritable: true,
    description: 'آستانهٔ آزمون',
  };
  const location = { kind: 'BRANCH', coordinate: { latitude: 31.91, longitude: 54.37 } };
  const contact = {
    kind: 'ADMINISTRATIVE',
    displayName: 'مسئول آزمون',
    email: 'contact@example.test',
  };

  describe('outside its subtree: every endpoint answers as if the organization did not exist', () => {
    it.each([
      ['GET /:id', (id: string) => `/v1/organizations/${id}`],
      ['GET /:id/children', (id: string) => `/v1/organizations/${id}/children`],
      ['GET /:id/subtree', (id: string) => `/v1/organizations/${id}/subtree`],
      ['GET /:id/ancestors', (id: string) => `/v1/organizations/${id}/ancestors`],
      ['GET /:id/policies', (id: string) => `/v1/organizations/${id}/policies`],
    ])('%s → 404, the same body as for an id that does not exist', async (_label, path) => {
      const absent = await http().get(path(missing())).set('authorization', unionAdmin).expect(404);
      for (const id of [county, dehyari, province]) {
        const response = await http().get(path(id)).set('authorization', unionAdmin).expect(404);
        expect(shape(response.body)).toEqual(shape(absent.body));
        expect(JSON.stringify(response.body)).not.toContain('آزمون');
      }
    });

    it('GET / lists only its own organization and what is beneath it', async () => {
      const response = await http()
        .get('/v1/organizations?limit=100')
        .set('authorization', unionAdmin)
        .expect(200);
      const ids = (response.body.items as { id: string }[]).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([union, unionChild]));
      expect(ids).not.toContain(county);
      expect(ids).not.toContain(dehyari);
      expect(ids).not.toContain(province);

      // Filtering by a parent outside it does not reopen the tree: the county
      // is the province's child, and still not listed.
      const byParent = await http()
        .get(`/v1/organizations?limit=100&parentId=${province}`)
        .set('authorization', unionAdmin)
        .expect(200);
      expect((byParent.body.items as { id: string }[]).map((row) => row.id)).not.toContain(county);
    });

    it('GET /nearby finds only its own subtree, though the dehyari is at the same point', async () => {
      const response = await http()
        .get('/v1/organizations/nearby?latitude=31.9&longitude=54.36&radiusMeters=5000&limit=100')
        .set('authorization', unionAdmin)
        .expect(200);
      const ids = (response.body as { id: string }[]).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([union, unionChild]));
      expect(ids).not.toContain(county);
      expect(ids).not.toContain(dehyari);
    });

    it('writes to an organization outside it → 404, the same as a missing one, and nothing is written', async () => {
      const before = await footprint([county, dehyari, province]);
      const writes: [string, (id: string) => request.Test][] = [
        [
          'PATCH',
          (id) =>
            http()
              .patch(`/v1/organizations/${id}`)
              .set('authorization', unionAdmin)
              .send({ name: 'نام تازه' }),
        ],
        [
          'POST child',
          (id) =>
            http()
              .post('/v1/organizations')
              .set('authorization', unionAdmin)
              .send({ name: 'فرزند ناروا', type: 'DEHYARI', parentId: id }),
        ],
        [
          'POST location',
          (id) =>
            http()
              .post(`/v1/organizations/${id}/locations`)
              .set('authorization', unionAdmin)
              .send(location),
        ],
        [
          'POST contact',
          (id) =>
            http()
              .post(`/v1/organizations/${id}/contacts`)
              .set('authorization', unionAdmin)
              .send(contact),
        ],
        [
          'POST policy',
          (id) =>
            http()
              .post(`/v1/organizations/${id}/policies`)
              .set('authorization', unionAdmin)
              .send(policy),
        ],
      ];
      for (const [label, write] of writes) {
        const absent = await write(missing());
        expect([label, absent.status]).toEqual([label, 404]);
        for (const id of [county, dehyari]) {
          const response = await write(id);
          expect([label, id, response.status]).toEqual([label, id, 404]);
          expect(shape(response.body)).toEqual(shape(absent.body));
        }
      }
      expect(await footprint([county, dehyari, province])).toEqual(before);
    });
  });

  describe('the platform operator’s alone: 403 before anything is looked up — even inside its own subtree', () => {
    it.each([
      [
        'a move of the county',
        () =>
          http()
            .post(`/v1/organizations/${county}/move`)
            .send({ parentId: union, reason: 'آزمون جابه‌جایی' }),
      ],
      [
        'a move of its own child',
        () =>
          http()
            .post(`/v1/organizations/${unionChild}/move`)
            .send({ parentId: province, reason: 'آزمون جابه‌جایی' }),
      ],
      [
        'a move of an id that does not exist',
        () =>
          http()
            .post(`/v1/organizations/${missing()}/move`)
            .send({ parentId: union, reason: 'آزمون جابه‌جایی' }),
      ],
      [
        'suspending the county (it would cascade to the dehyari)',
        () =>
          http()
            .post(`/v1/organizations/${county}/status`)
            .send({ status: 'SUSPENDED', reason: 'آزمون تعلیق' }),
      ],
      [
        'suspending its own child',
        () =>
          http()
            .post(`/v1/organizations/${unionChild}/status`)
            .send({ status: 'SUSPENDED', reason: 'آزمون تعلیق' }),
      ],
      [
        'suspending an id that does not exist',
        () =>
          http()
            .post(`/v1/organizations/${missing()}/status`)
            .send({ status: 'SUSPENDED', reason: 'آزمون تعلیق' }),
      ],
    ])('%s → 403, and nothing is written', async (_label, send) => {
      const everyone = [province, union, unionChild, county, dehyari];
      const before = await footprint(everyone);
      const response = await send().set('authorization', unionAdmin);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('آزمون');
      expect(await footprint(everyone)).toEqual(before);
    });

    it('a new root → 403, and neither a row nor an event appears', async () => {
      // Self-contained: its own name, its own request, its own counts.
      const name = `ریشهٔ ناروا ${ulid().slice(-6)}`;
      const count = async (sql: string) =>
        Number(((await prisma.client.$queryRawUnsafe(sql, name)) as { n: bigint }[])[0]?.n ?? 0);
      const rows = () => count(`SELECT count(*) AS n FROM organization WHERE name = $1`);
      const events = () =>
        count(
          `SELECT count(*) AS n FROM outbox_message
            WHERE event_name = 'ORGANIZATION_CREATED' AND payload->>'name' = $1`,
        );
      expect([await rows(), await events()]).toEqual([0, 0]);

      const response = await http()
        .post('/v1/organizations')
        .set('authorization', unionAdmin)
        .send({ name, type: 'UNION' });

      expect(response.status).toBe(403);
      expect([await rows(), await events()]).toEqual([0, 0]);
    });
  });

  describe('inside its subtree: unchanged', () => {
    it('reads its own organization and its child, with the chain stopping at itself', async () => {
      for (const id of [union, unionChild]) {
        await http().get(`/v1/organizations/${id}`).set('authorization', unionAdmin).expect(200);
      }
      const children = await http()
        .get(`/v1/organizations/${union}/children`)
        .set('authorization', unionAdmin)
        .expect(200);
      // Its child is there and nothing from outside is; other tests may add
      // children of their own, so this is not an exact list.
      const childIds = (children.body as { id: string }[]).map((row) => row.id);
      expect(childIds).toContain(unionChild);
      for (const outside of [province, county, dehyari]) expect(childIds).not.toContain(outside);
      const ancestors = await http()
        .get(`/v1/organizations/${unionChild}/ancestors`)
        .set('authorization', unionAdmin)
        .expect(200);
      // Visibility flows downward: the province above the union is not shown.
      expect((ancestors.body as { id: string }[]).map((row) => row.id)).toEqual([union]);
    });

    it('edits, adds a location, a contact, a child and a governance policy beneath itself', async () => {
      await http()
        .patch(`/v1/organizations/${unionChild}`)
        .set('authorization', unionAdmin)
        .send({ shortName: 'واحد' })
        .expect(200);
      await http()
        .post(`/v1/organizations/${unionChild}/locations`)
        .set('authorization', unionAdmin)
        .send(location)
        .expect(201);
      await http()
        .post(`/v1/organizations/${unionChild}/contacts`)
        .set('authorization', unionAdmin)
        .send(contact)
        .expect(201);
      const child = await http()
        .post('/v1/organizations')
        .set('authorization', unionAdmin)
        .send({ name: 'نوهٔ اتحادیه', type: 'COOPERATIVE', parentId: unionChild })
        .expect(201);
      created.push(child.body.id as string);
      // Q-64: UNION_ADMIN sets governance policy — now within its own subtree.
      await http()
        .post(`/v1/organizations/${unionChild}/policies`)
        .set('authorization', unionAdmin)
        .send(policy)
        .expect(201);
    });
  });

  describe('SYSTEM_ADMIN: still the operator of the whole registry', () => {
    it('reads and lists outside the union, and restructures', async () => {
      await http()
        .get(`/v1/organizations/${dehyari}`)
        .set('authorization', systemAdmin)
        .expect(200);
      // The database holds other suites' trees too, so the list is read by parent.
      const listed = async (parentId: string) =>
        (
          (
            await http()
              .get(`/v1/organizations?limit=100&parentId=${parentId}`)
              .set('authorization', systemAdmin)
              .expect(200)
          ).body.items as { id: string }[]
        ).map((row) => row.id);
      expect(await listed(province)).toEqual(expect.arrayContaining([union, county]));
      expect(await listed(county)).toEqual([dehyari]);
      await http()
        .post(`/v1/organizations/${dehyari}/policies`)
        .set('authorization', systemAdmin)
        .send(policy)
        .expect(201);
    });

    it('moves the dehyari beneath the union — and the union’s view follows the tree', async () => {
      await http()
        .post(`/v1/organizations/${dehyari}/move`)
        .set('authorization', systemAdmin)
        .send({ parentId: union, reason: 'آزمون جابه‌جایی' })
        .expect(200);
      try {
        await http()
          .get(`/v1/organizations/${dehyari}`)
          .set('authorization', unionAdmin)
          .expect(200);
      } finally {
        // Back, whatever happened, so no other test depends on this one's outcome.
        await http()
          .post(`/v1/organizations/${dehyari}/move`)
          .set('authorization', systemAdmin)
          .send({ parentId: county, reason: 'آزمون بازگشت' })
          .expect(200);
      }
      await http().get(`/v1/organizations/${dehyari}`).set('authorization', unionAdmin).expect(404);
    });
  });

  describe('ADR-060: the union role does not travel with X-Organization-Id', () => {
    it('acting for the dehyari where it is a DRIVER, it has a DRIVER’s scope there', async () => {
      await http()
        .get(`/v1/organizations/${dehyari}`)
        .set('authorization', unionAdminAsDriver)
        .set('x-organization-id', dehyari)
        .expect(200);
      // Nothing of the union's authority comes along.
      await http()
        .get(`/v1/organizations/${union}`)
        .set('authorization', unionAdminAsDriver)
        .set('x-organization-id', dehyari)
        .expect(404);
      await http()
        .patch(`/v1/organizations/${dehyari}`)
        .set('authorization', unionAdminAsDriver)
        .set('x-organization-id', dehyari)
        .send({ name: 'نام راننده' })
        .expect(403);
      await http()
        .post(`/v1/organizations/${dehyari}/status`)
        .set('authorization', unionAdminAsDriver)
        .set('x-organization-id', dehyari)
        .send({ status: 'SUSPENDED', reason: 'آزمون تعلیق' })
        .expect(403);
    });

    it('acting for the county where it is ORGANIZATION_ADMIN, it has that scope there — and only there', async () => {
      const asCounty = (req: request.Test) =>
        req.set('authorization', unionAndCountyAdmin).set('x-organization-id', county);
      // The county's administrator: the county and what is beneath it.
      await asCounty(http().get(`/v1/organizations/${county}`)).expect(200);
      await asCounty(http().get(`/v1/organizations/${dehyari}`)).expect(200);
      await asCounty(http().patch(`/v1/organizations/${county}`))
        .send({ shortName: 'شهرستان' })
        .expect(200);
      // Not the union's authority: the union and the province are outside.
      await asCounty(http().get(`/v1/organizations/${union}`)).expect(404);
      await asCounty(http().get(`/v1/organizations/${province}`)).expect(404);
      // And not a platform operator's either.
      await asCounty(http().post(`/v1/organizations/${dehyari}/move`))
        .send({ parentId: county, reason: 'آزمون جابه‌جایی' })
        .expect(403);
      await asCounty(http().post(`/v1/organizations/${dehyari}/status`))
        .send({ status: 'SUSPENDED', reason: 'آزمون تعلیق' })
        .expect(403);
      await asCounty(http().post('/v1/organizations'))
        .send({ name: `ریشهٔ شهرستان ${ulid().slice(-6)}`, type: 'GOVERNMENT' })
        .expect(403);
    });

    it('the same token, acting for the union, does not carry the county role back', async () => {
      await http()
        .get(`/v1/organizations/${county}`)
        .set('authorization', unionAndCountyAdmin)
        .expect(404);
      await http()
        .patch(`/v1/organizations/${county}`)
        .set('authorization', unionAndCountyAdmin)
        .send({ shortName: 'ناروا' })
        .expect(404);
    });
  });

  /**
   * Pinned, not endorsed: behaviour that predates Q-80 and applies to every
   * non-operator, recorded as `docs/23` D-038 and left to the owner (`docs/24`
   * Q-67 for what is visible above one's own organization, Q-80 for
   * `externalCode`). These tests fail the moment it changes, so any change is
   * a decision, not an accident.
   */
  describe('pinned, pre-existing (docs/23 D-038): what a non-operator learns about organizations above or beside it', () => {
    it('GET /:id of its own organization names its parent and the full path above it (Q-67)', async () => {
      const own = await http()
        .get(`/v1/organizations/${union}`)
        .set('authorization', unionAdmin)
        .expect(200);
      expect(own.body.parentId).toBe(province);
      // The materialized path starts at the province, above the visible root —
      // while GET /:id/ancestors stops at the union itself.
      expect((own.body.path as string).split('.')).toHaveLength(2);
      const ancestors = await http()
        .get(`/v1/organizations/${union}/ancestors`)
        .set('authorization', unionAdmin)
        .expect(200);
      expect(ancestors.body).toEqual([]);
    });

    it('GET /:id/policies shows an inherited policy with its source above the visible root (Q-67)', async () => {
      const key = `governance.pin_${ulid().slice(-6).toLowerCase()}`;
      await http()
        .post(`/v1/organizations/${province}/policies`)
        .set('authorization', systemAdmin)
        .send({ key, value: 'province-wide', inheritable: true, description: 'منبع بالادست' })
        .expect(201);
      const policies = await http()
        .get(`/v1/organizations/${union}/policies`)
        .set('authorization', unionAdmin)
        .expect(200);
      const inherited = (policies.body as Record<string, unknown>[]).find((p) => p.key === key);
      // Provisional stance (Q-67): the key and value govern the union, so they
      // stay visible. The rest is the source's metadata — pinned here.
      expect(inherited).toMatchObject({
        key,
        value: 'province-wide',
        inheritedFrom: province,
        description: 'منبع بالادست',
        id: expect.any(String),
      });
    });

    it('externalCode is unique across the whole registry: an occupied code answers 409 (Q-80)', async () => {
      const code = `EXT-PIN-${ulid().slice(-8)}`;
      await http()
        .patch(`/v1/organizations/${county}`)
        .set('authorization', systemAdmin)
        .send({ externalCode: code })
        .expect(200);
      // The county is outside the union's subtree, yet its code is not free.
      await http()
        .post('/v1/organizations')
        .set('authorization', unionAdmin)
        .send({ name: 'واحد کد', type: 'COOPERATIVE', parentId: unionChild, externalCode: code })
        .expect(409);
      const free = await http()
        .post('/v1/organizations')
        .set('authorization', unionAdmin)
        .send({
          name: 'واحد کد آزاد',
          type: 'COOPERATIVE',
          parentId: unionChild,
          externalCode: `${code}-FREE`,
        })
        .expect(201);
      created.push(free.body.id as string);
    });
  });
});
