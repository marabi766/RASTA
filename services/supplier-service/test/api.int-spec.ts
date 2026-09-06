import request from 'supertest';
import {
  apiTenant,
  auditorActor,
  internalToken,
  platformAdmin,
  procurementUser,
  startApi,
  supplierActor,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * Every public endpoint, over HTTP, through the real application.
 *
 * `docs/14` § 14.5 makes this mandatory and it did not exist: ten routes, the
 * controller, every view mapper and the composition root were at zero coverage,
 * and the error paths — which status a refusal carries, and therefore what an
 * attacker learns from it — were asserted nowhere.
 *
 * The four things each endpoint is checked for:
 *
 *   **authorization**  which role reaches it, and which refusal the others get.
 *                      A `403` and a `404` say different things to somebody
 *                      probing identifiers, and which one is returned is part
 *                      of the contract rather than an implementation detail.
 *   **tenant isolation** what a caller from another organization sees. The
 *                      directory is deliberately cross-tenant; every other read
 *                      is not, and the difference is enforced per endpoint.
 *   **pagination**     that a cursor page is a page and its cursor works.
 *   **projection**     that the public object is not the private one. The
 *                      directory must carry no evidence identifier, no decision
 *                      note, no actor and no suspension reason — `views.ts`
 *                      decides that, and this is where it is proven over the
 *                      wire rather than in a unit test of the mapper.
 *
 * The self-judgement rule has its own file, `d2-self-judgement.int-spec.ts`,
 * because it is a security defect with its own history.
 */
describe('supplier HTTP API', () => {
  let api: ApiHarness;

  const supplierOrg = apiTenant('API-SUP');
  const otherSupplierOrg = apiTenant('API-SUP2');
  const buyerOrg = apiTenant('API-BUYER');
  const platformOrg = apiTenant('API-PLATFORM');
  const organizations = [supplierOrg, otherSupplierOrg, buyerOrg, platformOrg];

  let supplierId: string;
  let otherSupplierId: string;
  let approvedQualificationId: string;
  let openQualificationId: string;

  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi();
    await cleanup(api.prisma, organizations);

    // --- one supplier, approved for WORKSHOP_SERVICE -------------------------
    const registered = await http()
      .post('/v1/suppliers')
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({
        displayName: 'کارگاه مرکزی',
        capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
      })
      .expect(201);
    supplierId = registered.body.id;

    const submitted = await http()
      .post(`/v1/suppliers/${supplierId}/qualifications`)
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({
        capability: 'WORKSHOP_SERVICE',
        statement: 'ما بیل مکانیکی تعمیر می‌کنیم',
        evidence: [{ documentId: 'DOC-API-0001', label: 'پروانه کسب' }],
      })
      .expect(201);
    approvedQualificationId = submitted.body.id;

    await http()
      .post(`/v1/suppliers/${supplierId}/qualifications/${approvedQualificationId}/approve`)
      .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
      .send({ note: 'مدارک بررسی شد' })
      .expect(200);

    // --- a second supplier with an undecided submission ----------------------
    const other = await http()
      .post('/v1/suppliers')
      .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
      .send({ displayName: 'پیمانکار جنوب', capabilities: ['CONTRACTING'] })
      .expect(201);
    otherSupplierId = other.body.id;

    const open = await http()
      .post(`/v1/suppliers/${otherSupplierId}/qualifications`)
      .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
      .send({ capability: 'CONTRACTING', statement: 'راه روستایی', evidence: [] })
      .expect(201);
    openQualificationId = open.body.id;
  }, 180_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  // -------------------------------------------------------------------------
  // Closed by default
  // -------------------------------------------------------------------------

  describe('every route is closed by default', () => {
    const routes: [string, string][] = [
      ['post', '/v1/suppliers'],
      ['get', '/v1/suppliers'],
      ['get', '/v1/suppliers/qualified?capability=WORKSHOP_SERVICE'],
      ['get', '/v1/suppliers/qualifications'],
      ['get', '/v1/suppliers/SUP_X'],
      ['post', '/v1/suppliers/SUP_X/qualifications'],
      ['post', '/v1/suppliers/SUP_X/qualifications/QLF_X/approve'],
      ['post', '/v1/suppliers/SUP_X/qualifications/QLF_X/reject'],
      ['post', '/v1/suppliers/SUP_X/suspend'],
      ['post', '/v1/suppliers/SUP_X/reinstate'],
    ];

    it('answers 401 without a token on all ten endpoints', async () => {
      expect(routes).toHaveLength(10);
      for (const [method, path] of routes) {
        const response = await (http() as never as Record<string, (p: string) => never>)[method](
          path,
        );
        expect({ path, status: (response as { status: number }).status }).toEqual({
          path,
          status: 401,
        });
      }
    });

    it('refuses a service token on every endpoint — none carries @AllowService', async () => {
      // ADR-020: a valid internal token proves which service is calling and by
      // itself grants access to nothing. No supplier endpoint is opened to one,
      // so the guard refuses before `access.ts` is even reached.
      //
      // Sent in `x-internal-token`, which is the header the guard routes an
      // internal token by. The same token in `Authorization: Bearer` is not a
      // service call at all — it is a malformed user token, and answered 401.
      const token = await internalToken('marketplace-service');
      for (const [method, path] of routes) {
        const response = await (http() as never as Record<string, (p: string) => never>)[method](
          path,
        ).set('x-internal-token', token);
        expect({ path, status: (response as { status: number }).status }).toEqual({
          path,
          status: 403,
        });
      }
    });

    it('refuses the oversight role everywhere — aggregate access only', async () => {
      // docs/09 § 9.3 states it as a product constraint. A supplier directory
      // is row-level data about named organizations, which is its opposite.
      for (const path of [
        '/v1/suppliers',
        '/v1/suppliers/qualified?capability=WORKSHOP_SERVICE',
        `/v1/suppliers/${supplierId}`,
      ]) {
        await http()
          .get(path)
          .set('authorization', `Bearer ${auditorActor(buyerOrg)}`)
          .expect(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 1. POST /v1/suppliers
  // -------------------------------------------------------------------------

  describe('POST /v1/suppliers — register', () => {
    it('takes the organization from the token, never from the body', async () => {
      const org = apiTenant('API-BODY');
      organizations.push(org);

      // A body-supplied tenant is refused outright rather than ignored. The DTO
      // is `.strict()`, so an unknown key is a 400 — the stronger answer: a
      // caller who thought they were choosing an organization is told they
      // cannot, instead of silently getting a different one.
      await http()
        .post('/v1/suppliers')
        .set('authorization', `Bearer ${supplierActor(org)}`)
        .send({
          displayName: 'تأمین‌کننده آزمایشی',
          capabilities: ['GOODS_SUPPLY'],
          organizationId: platformOrg,
        })
        .expect(400);

      const response = await http()
        .post('/v1/suppliers')
        .set('authorization', `Bearer ${supplierActor(org)}`)
        .send({ displayName: 'تأمین‌کننده آزمایشی', capabilities: ['GOODS_SUPPLY'] })
        .expect(201);

      // The organization is the token's, and a new profile is qualified for
      // nothing: registration grants no standing.
      expect(response.body.organizationId).toBe(org);
      expect(response.body.qualifiedFor).toEqual([]);
    });

    it('refuses a second profile for one organization with 409', async () => {
      await http()
        .post('/v1/suppliers')
        .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
        .send({ displayName: 'یک پروفایل دیگر', capabilities: ['GOODS_SUPPLY'] })
        .expect(409);
    });

    it('refuses a platform operator — they would be creating what they judge', async () => {
      await http()
        .post('/v1/suppliers')
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ displayName: 'ساخته‌شده توسط اپراتور', capabilities: ['GOODS_SUPPLY'] })
        .expect(403);
    });

    it('rejects an invalid body with 400 rather than a 500', async () => {
      for (const body of [
        {},
        { displayName: '   ', capabilities: ['GOODS_SUPPLY'] },
        { displayName: 'ok', capabilities: [] },
        { displayName: 'ok', capabilities: ['NOT_A_CAPABILITY'] },
        { displayName: 'ok', capabilities: ['GOODS_SUPPLY'], unexpected: true },
      ]) {
        const response = await http()
          .post('/v1/suppliers')
          .set('authorization', `Bearer ${supplierActor(apiTenant('API-BAD'))}`)
          .send(body);
        expect(response.status).toBe(400);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. GET /v1/suppliers — the public directory
  // -------------------------------------------------------------------------

  describe('GET /v1/suppliers — directory', () => {
    it('is cross-tenant: a buyer sees suppliers it does not own', async () => {
      const response = await http()
        .get('/v1/suppliers')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      const ids = response.body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(supplierId);
      expect(ids).toContain(otherSupplierId);
    });

    it('carries the catalogue-safe projection and nothing private', async () => {
      const response = await http()
        .get('/v1/suppliers')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      const raw = JSON.stringify(response.body);
      // The evidence identifier, the decision note and the actor exist on this
      // supplier's private record. None may appear here.
      expect(raw).not.toContain('DOC-API-0001');
      expect(raw).not.toContain('پروانه کسب');
      expect(raw).not.toContain('مدارک بررسی شد');
      expect(raw).not.toContain('USR-APITEST');

      const mine = response.body.items.find((item: { id: string }) => item.id === supplierId);
      expect(Object.keys(mine).sort()).toEqual(
        ['capabilities', 'displayName', 'id', 'organizationId', 'qualifiedFor', 'registeredAt', 'status'].sort(),
      );
      // Claimed two, approved for one. The distinction is the point of the
      // directory: claiming is not qualification.
      expect(mine.capabilities.sort()).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE']);
      expect(mine.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
    });

    it('filters by claimed capability and by current qualification', async () => {
      const claimed = await http()
        .get('/v1/suppliers?capability=GOODS_SUPPLY')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);
      expect(claimed.body.items.map((i: { id: string }) => i.id)).toContain(supplierId);

      const qualified = await http()
        .get('/v1/suppliers?qualifiedFor=GOODS_SUPPLY')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);
      // Claimed but never approved for it.
      expect(qualified.body.items.map((i: { id: string }) => i.id)).not.toContain(supplierId);
    });

    it('refuses the contradictory filter with 400 rather than an empty page', async () => {
      // `qualifiedFor` already implies ACTIVE. Answering an empty page would
      // leave the caller to guess whether nobody matched or the query was wrong.
      await http()
        .get('/v1/suppliers?qualifiedFor=WORKSHOP_SERVICE&status=SUSPENDED')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(400);
    });

    it('paginates with a cursor that continues where the page stopped', async () => {
      const first = await http()
        .get('/v1/suppliers?limit=1')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      expect(first.body.items).toHaveLength(1);
      expect(typeof first.body.nextCursor).toBe('string');

      const second = await http()
        .get(`/v1/suppliers?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    });

    it('treats an unknown cursor as an opaque key rather than failing', async () => {
      // `cursorPaginationSchema` accepts any string up to 512 characters
      // (`@rasta/contracts`), and a cursor is an opaque continuation key rather
      // than a parsed structure. So an unknown one names a position nothing
      // follows, and the honest answer is a well-formed page rather than a 400
      // about a value the caller was never meant to construct by hand.
      // Platform-wide behaviour, asserted here so a change to it is visible.
      const response = await http()
        .get('/v1/suppliers?cursor=not-a-cursor')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      expect(Array.isArray(response.body.items)).toBe(true);

      // A cursor longer than the contract allows is still refused.
      await http()
        .get(`/v1/suppliers?cursor=${'x'.repeat(600)}`)
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 3. GET /v1/suppliers/qualified
  // -------------------------------------------------------------------------

  describe('GET /v1/suppliers/qualified', () => {
    it('returns suppliers with a current approval for the capability', async () => {
      const response = await http()
        .get('/v1/suppliers/qualified?capability=WORKSHOP_SERVICE')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);

      expect(response.body.items.map((i: { id: string }) => i.id)).toContain(supplierId);
      expect(JSON.stringify(response.body)).not.toContain('DOC-API-0001');
    });

    it('requires the capability — "everyone qualified" is a different question', async () => {
      await http()
        .get('/v1/suppliers/qualified')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(400);
    });

    it('excludes a suspended supplier, and restores it on reinstatement', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/suspend`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ reason: 'بازبینی مدارک' })
        .expect(200);

      const suspended = await http()
        .get('/v1/suppliers/qualified?capability=WORKSHOP_SERVICE')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);
      expect(suspended.body.items.map((i: { id: string }) => i.id)).not.toContain(supplierId);

      await http()
        .post(`/v1/suppliers/${supplierId}/reinstate`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ reason: 'مدارک تکمیل شد' })
        .expect(200);

      const restored = await http()
        .get('/v1/suppliers/qualified?capability=WORKSHOP_SERVICE')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(200);
      // Restored without a new decision: suspension withholds, it does not revoke.
      expect(restored.body.items.map((i: { id: string }) => i.id)).toContain(supplierId);
    });
  });

  // -------------------------------------------------------------------------
  // 4. GET /v1/suppliers/qualifications — the review queue
  // -------------------------------------------------------------------------

  describe('GET /v1/suppliers/qualifications — review queue', () => {
    it('is platform-only', async () => {
      await http()
        .get('/v1/suppliers/qualifications')
        .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
        .expect(403);
      await http()
        .get('/v1/suppliers/qualifications')
        .set('authorization', `Bearer ${procurementUser(buyerOrg)}`)
        .expect(403);
    });

    it('returns open submissions across tenants, with their evidence', async () => {
      const response = await http()
        .get('/v1/suppliers/qualifications')
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .expect(200);

      const ids = response.body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(openQualificationId);
      // Decided ones are not in the default queue.
      expect(ids).not.toContain(approvedQualificationId);
    });

    it('filters by state, so a reviewer can find what they already decided', async () => {
      const response = await http()
        .get('/v1/suppliers/qualifications?state=APPROVED')
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .expect(200);
      expect(response.body.items.map((i: { id: string }) => i.id)).toContain(
        approvedQualificationId,
      );
    });

    it('rejects an unknown state with 400', async () => {
      await http()
        .get('/v1/suppliers/qualifications?state=PENDING')
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 5. GET /v1/suppliers/:id — the private record
  // -------------------------------------------------------------------------

  describe('GET /v1/suppliers/:id', () => {
    it('gives the owning organization its full record', async () => {
      const response = await http()
        .get(`/v1/suppliers/${supplierId}`)
        .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
        .expect(200);

      expect(response.body.id).toBe(supplierId);
      // The private object carries what the directory does not.
      expect(JSON.stringify(response.body)).toContain('DOC-API-0001');
    });

    it('gives a platform operator the same record, for review', async () => {
      await http()
        .get(`/v1/suppliers/${supplierId}`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .expect(200);
    });

    it('answers 404 to another tenant, never 403', async () => {
      // A 403 confirms the profile exists and that somebody else owns it. The
      // directory is where a stranger legitimately learns a supplier exists,
      // and it returns a different, catalogue-safe object.
      const foreign = await http()
        .get(`/v1/suppliers/${supplierId}`)
        .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
        .expect(404);

      const missing = await http()
        .get('/v1/suppliers/SUP_DOES_NOT_EXIST')
        .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
        .expect(404);

      // Indistinguishable, so the attempt is not an existence oracle.
      expect(foreign.body.code).toBe(missing.body.code);
      expect(foreign.body.message).toBe(missing.body.message);
      expect(JSON.stringify(foreign.body)).not.toContain('DOC-API-0001');
    });
  });

  // -------------------------------------------------------------------------
  // 6. POST /v1/suppliers/:id/qualifications
  // -------------------------------------------------------------------------

  describe('POST /v1/suppliers/:id/qualifications — submit', () => {
    it('refuses a platform operator submitting on a supplier behalf', async () => {
      // Otherwise `submittedBy` would be the person who then approves it, and
      // the self-judgement check would have nothing left to catch.
      await http()
        .post(`/v1/suppliers/${supplierId}/qualifications`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ capability: 'GOODS_SUPPLY', evidence: [] })
        .expect(403);
    });

    it('answers 404 when another tenant submits against this supplier', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/qualifications`)
        .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
        .send({ capability: 'GOODS_SUPPLY', evidence: [] })
        .expect(404);
    });

    it('rejects a blank evidence identifier with 400', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/qualifications`)
        .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
        .send({ capability: 'GOODS_SUPPLY', evidence: [{ documentId: '   ' }] })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 7 & 8. approve / reject
  // -------------------------------------------------------------------------

  describe('POST approve and reject', () => {
    it('refuses a supplier-side role', async () => {
      await http()
        .post(`/v1/suppliers/${otherSupplierId}/qualifications/${openQualificationId}/approve`)
        .set('authorization', `Bearer ${supplierActor(otherSupplierOrg)}`)
        .send({ note: 'خودم تأیید می‌کنم' })
        .expect(403);
    });

    it('answers 404 for a qualification that belongs to another supplier', async () => {
      // The id exists; it is simply not this supplier's. Answering 403 would
      // confirm the pairing.
      await http()
        .post(`/v1/suppliers/${supplierId}/qualifications/${openQualificationId}/approve`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ note: 'مال این تأمین‌کننده نیست' })
        .expect(404);
    });

    it('refuses deciding an already decided submission', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/qualifications/${approvedQualificationId}/reject`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        // 422, not 409: a state-machine refusal is not a uniqueness conflict.
        // Registering a second profile for one organization is the 409.
        .send({ reason: 'نظرم عوض شد' })
        .expect(422);
    });

    it('lets a SYSTEM_ADMIN with no active tenant decide', async () => {
      const response = await http()
        .post(`/v1/suppliers/${otherSupplierId}/qualifications/${openQualificationId}/reject`)
        .set('authorization', `Bearer ${systemAdminWithoutTenant()}`)
        .send({ reason: 'شواهد کافی نیست' })
        .expect(200);

      // The decision endpoint returns the qualification it decided, not the
      // supplier it belongs to.
      expect(response.body.id).toBe(openQualificationId);
      expect(response.body.state).toBe('REJECTED');
    });
  });

  // -------------------------------------------------------------------------
  // 9 & 10. suspend / reinstate
  // -------------------------------------------------------------------------

  describe('POST suspend and reinstate', () => {
    it('refuses a supplier suspending itself', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/suspend`)
        .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
        .send({ reason: 'خودم' })
        .expect(403);
    });

    it('requires a reason — a suspension nobody can explain is not auditable', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/suspend`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({})
        .expect(400);
    });

    it('refuses reinstating a supplier that is not suspended', async () => {
      await http()
        .post(`/v1/suppliers/${supplierId}/reinstate`)
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ reason: 'تعلیقی در کار نیست' })
        .expect(422);
    });

    it('answers 404 for a supplier that does not exist', async () => {
      await http()
        .post('/v1/suppliers/SUP_NOT_REAL/suspend')
        .set('authorization', `Bearer ${platformAdmin(platformOrg)}`)
        .send({ reason: 'وجود ندارد' })
        .expect(404);
    });
  });
});
