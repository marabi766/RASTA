import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import type { PrismaService } from '../src/prisma/prisma.service';
import { cleanupRun, newMigratorPrisma } from './helpers';
import {
  auditor,
  bearer,
  internalToken,
  organizationAdmin,
  startApi,
  systemAdmin,
  unionAdmin,
  unlistedRole,
  type ApiHarness,
} from './api-helpers';
import { at, orgId, projectOrganization, queryWindow, seedAuditEvent } from './fixtures';

/**
 * The ten authorization cases of `ADR-053-implementation-plan.md` § 6.4, over
 * the real router, the real guards and a real PostgreSQL.
 *
 * ## Why `AUDITOR` is the sharpest case in the file
 *
 * Despite the name, the province oversight role has **no** access to
 * audit-service. `docs/04` § 4.15 and `docs/09:169` scope it to aggregate
 * analytics only — no row-level tenant data — and an audit record is row-level
 * tenant data by definition. ADR-053 § 10 calls this "the row that surprises a
 * reader", which is exactly why the platform enforces it in three independent
 * places and why all three are asserted here.
 *
 * ## Two cases are reconciled with the plan rather than copied from it
 *
 * **Case 3, `POST /v1/audit-events/export` → `403`.** There is no export route
 * in AUD-002 — export is asynchronous, `SYSTEM_ADMIN`-only and audited in its
 * own right (ADR-053 § 10) — so the router answers `404`. That is *stronger*
 * than the `403` the plan wrote down, because a route that does not exist
 * cannot be reached by any role at all, and the assertion below says so
 * explicitly rather than pretending a guard refused something.
 *
 * **Case 6, `assertNotAuditor()` surviving a bypassed guard.** Proved without
 * mocking a guard away: a token carrying `SYSTEM_ADMIN` *and* `AUDITOR`
 * satisfies `RolesGuard` for real — `SYSTEM_ADMIN` is its super-role — and is
 * still refused, by the third layer, through the whole HTTP stack. A stubbed
 * guard would prove less: it would prove the stub was installed.
 *
 * **Case 4, the gateway prefix.** Asserted in
 * `services/api-gateway/src/config/routes.spec.ts`, where the route table
 * lives. Reading another service's source from here would be the cross-service
 * coupling AGENTS.md A-02 exists to prevent.
 *
 * **Case 7, "an `AUDITOR` may read their own notifications".** That belongs to
 * notification-service and is asserted there. What is in scope here is the half
 * that concerns this service: an `AUDITOR` is a user like anyone else and still
 * reaches this service's public health probes — the refusal is about audit
 * records, not about the person.
 */
describe('audit read authorization (real PostgreSQL, real guards)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let server: Server;

  const UNION = orgId('AUTHZ-UNION');
  const CHILD = orgId('AUTHZ-CHILD');
  let recordId: string;

  const window = queryWindow();

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();

    api = await startApi();
    server = api.app.getHttpServer() as Server;

    await projectOrganization(api.prisma, { organizationId: UNION, parentOrganizationId: null });
    await projectOrganization(api.prisma, {
      organizationId: CHILD,
      parentOrganizationId: UNION,
    });

    const seeded = await seedAuditEvent(api.prisma, {
      organizationId: UNION,
      occurredAt: at(10),
    });
    recordId = seeded.id;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 1-2. The oversight role reaches neither endpoint.
  // -------------------------------------------------------------------------

  it('refuses AUDITOR on the search endpoint', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${auditor(UNION)}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBeDefined();
  });

  it('refuses AUDITOR on the detail endpoint', async () => {
    const response = await request(server)
      .get(`/v1/audit-events/${recordId}`)
      .query(window)
      .set('Authorization', `Bearer ${auditor(UNION)}`);

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 3. The export route the plan names does not exist in AUD-002.
  // -------------------------------------------------------------------------

  it('has no export route for any role to reach', async () => {
    for (const token of [auditor(UNION), systemAdmin(), unionAdmin(UNION)]) {
      const response = await request(server)
        .post('/v1/audit-events/export')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      // 404, not 403: absence is a stronger guarantee than a refusal, and it is
      // the honest one to assert while export is unbuilt.
      expect(response.status).toBe(404);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Static: no @Roles in this service names AUDITOR.
  // -------------------------------------------------------------------------

  it('names AUDITOR in no @Roles decorator anywhere in this service', () => {
    const sources = typescriptSourcesUnder(join(__dirname, '..', 'src'));
    expect(sources.length).toBeGreaterThan(5);

    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/@Roles\(([^)]*)\)/g)].some((match) =>
        (match[1] ?? '').includes('AUDITOR'),
      );
    });

    expect(offenders).toEqual([]);
  });

  it('spreads the controller decorator from the two-role constant', () => {
    // The decorator and the constant cannot drift, because the decorator is the
    // constant. Asserted on the source so a future edit that inlines the roles
    // has to change this line too.
    const controller = readFileSync(
      join(__dirname, '..', 'src', 'audit', 'audit.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('@Roles(...AUDIT_READER_ROLES)');
    // Not "the file never says AUDITOR" — its docblock explains why the role is
    // absent, and deleting that explanation would make the code worse. What is
    // pinned is that no *decorator* names it, which the scan above asserts over
    // every source file in the service.
  });

  // -------------------------------------------------------------------------
  // 6. The third layer, with the guard genuinely satisfied.
  // -------------------------------------------------------------------------

  it('refuses AUDITOR even when the role guard has already allowed the request', async () => {
    // `SYSTEM_ADMIN` is `RolesGuard.SUPER_ROLE`, so this token passes the guard
    // for real. Only `assertNotAuditor()` stands between it and the evidence.
    const both = bearer({
      sub: 'sub-both',
      roles: ['SYSTEM_ADMIN', 'AUDITOR'],
      organizationId: UNION,
    });
    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${both}`);

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 7. The oversight role is still a person.
  // -------------------------------------------------------------------------

  it('still lets AUDITOR reach the public health probes', async () => {
    // The refusal is about audit records, not about the individual. A design
    // that locked the role out of the service entirely would be enforcing
    // something nobody decided.
    const response = await request(server)
      .get('/health/live')
      .set('Authorization', `Bearer ${auditor(UNION)}`);

    expect(response.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 8. ORGANIZATION_ADMIN — least privilege while ownership is ambiguous.
  // -------------------------------------------------------------------------

  it('refuses ORGANIZATION_ADMIN', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${organizationAdmin(UNION)}`);

    expect(response.status).toBe(403);
  });

  it('refuses a role no audit rule mentions', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${unlistedRole(UNION)}`);

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 9. A service token authenticates perfectly and is still refused.
  // -------------------------------------------------------------------------

  it('refuses a valid service token on both endpoints', async () => {
    const token = await internalToken();

    // `x-internal-token`, which is the transport the gateway actually uses
    // (`proxy.service.ts`) and the only one `AuthGuard` reads a service token
    // from. Presented in `Authorization` it would not be a service token at
    // all — it would be an unparseable user token, and this test would prove
    // the wrong refusal.
    const search = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('x-internal-token', token);
    const detail = await request(server)
      .get(`/v1/audit-events/${recordId}`)
      .query(window)
      .set('x-internal-token', token);

    // Refused by `AuthGuard`, because no route here carries `@AllowService`.
    // `assertNotServiceCaller()` is the second layer behind it.
    expect(search.status).toBe(403);
    expect(detail.status).toBe(403);
  });

  it('treats a gateway relay token as anonymous, not as a service', async () => {
    // A relay token says only "this hop came from the gateway" and grants no
    // service authority. Reading it as a service token is defect D-007.
    const response = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('x-internal-token', await internalToken('api-gateway', 'RELAY'));

    expect(response.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 10. There is no write API, structurally.
  // -------------------------------------------------------------------------

  it('has no POST route, for any role', async () => {
    // `docs/04` § 4.15: writing is from Kafka only. Proved by the router
    // answering 404 rather than by a promise in a document — this is the test
    // that fails the first time somebody adds a route "for a migration script".
    for (const token of [systemAdmin(), unionAdmin(UNION)]) {
      const response = await request(server)
        .post('/v1/audit-events')
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'anything' });

      expect(response.status).toBe(404);
    }
  });

  it('has no update or delete route on a record either', async () => {
    // The append-only guarantee lives in PostgreSQL privileges and triggers,
    // and there is no HTTP surface that could ask for either.
    const path = `/v1/audit-events/${recordId}`;
    const auth = `Bearer ${systemAdmin()}`;

    const put = await request(server).put(path).set('Authorization', auth).send({});
    const patch = await request(server).patch(path).set('Authorization', auth).send({});
    const remove = await request(server).delete(path).set('Authorization', auth);

    expect(put.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(remove.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Closed by default.
  // -------------------------------------------------------------------------

  it('refuses an unauthenticated caller on both endpoints', async () => {
    expect((await request(server).get('/v1/audit-events').query(window)).status).toBe(401);
    expect((await request(server).get(`/v1/audit-events/${recordId}`).query(window)).status).toBe(
      401,
    );
  });

  it('admits the two roles the matrix names', async () => {
    // The positive control. Without it every assertion above would still pass
    // if the endpoints were broken for everybody.
    const asSystem = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${systemAdmin()}`);
    const asUnion = await request(server)
      .get('/v1/audit-events')
      .query(window)
      .set('Authorization', `Bearer ${unionAdmin(UNION)}`);

    expect(asSystem.status).toBe(200);
    expect(asUnion.status).toBe(200);
    expect(Array.isArray(asUnion.body.items)).toBe(true);
  });

  it('lets a union administrator read a record beneath them, and refuses a stranger', async () => {
    const child = await seedAuditEvent(api.prisma, { organizationId: CHILD, occurredAt: at(20) });

    const allowed = await request(server)
      .get(`/v1/audit-events/${child.id}`)
      .query({ ...window, organizationId: CHILD })
      .set('Authorization', `Bearer ${unionAdmin(UNION)}`);
    const refused = await request(server)
      .get(`/v1/audit-events/${child.id}`)
      .query({ ...window, organizationId: CHILD })
      .set('Authorization', `Bearer ${unionAdmin(orgId('AUTHZ-STRANGER'))}`);

    expect(allowed.status).toBe(200);
    expect(allowed.body.organizationId).toBe(CHILD);
    // A stranger asking for an organization no projection places beneath them
    // is refused before any record is looked up.
    expect(refused.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Validation runs before anything is queried.
  // -------------------------------------------------------------------------

  it('refuses a query with no window, naming the fields', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body.details)).toContain('from');
  });

  it('refuses an over-wide window, naming the configured ceiling', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ from: '2026-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.details)).toContain('AUDIT_MAX_QUERY_WINDOW_DAYS');
    expect(JSON.stringify(response.body.details)).toContain('90 days');
  });

  it('refuses a reversed window', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ from: window.to, to: window.from })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
  });

  it('validates before authorizing, so a refused caller still gets the 400 first', async () => {
    // The order Nest guarantees is the other way round — guards run before
    // pipes — so this asserts what actually happens rather than what would be
    // convenient: a caller the matrix excludes is refused before the request is
    // even parsed, which is the cheaper and safer order.
    const response = await request(server)
      .get('/v1/audit-events')
      .set('Authorization', `Bearer ${auditor(UNION)}`);

    expect(response.status).toBe(403);
  });

  it('refuses an unknown query parameter rather than ignoring it', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organisationId: UNION })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
  });

  it('refuses a forged cursor as a validation failure, not a 500', async () => {
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, cursor: 'not-a-cursor' })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
  });
});

/** Every `.ts` file under a directory, excluding the generated Prisma client. */
function typescriptSourcesUnder(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) found.push(path);
    }
  };

  walk(root);
  return found;
}
