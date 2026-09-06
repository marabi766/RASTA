import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  apiTenant,
  multiMemberActor,
  platformAdmin,
  startApi,
  supplierActor,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import { cleanup } from './helpers';

/**
 * D-2 — a platform operator must not decide their own organization's case,
 * whichever tenant they happen to have selected.
 *
 * ## The bypass
 *
 * `assertNotDecidingOwnCase` compared the supplier's organization against
 * `context.organizationId` — the **selected** tenant, one value. But a person
 * may belong to several organizations, and which one a request acts for is
 * chosen per request by the `X-Organization-Id` header. Everything the guard
 * knew about the *other* memberships was discarded the moment the context was
 * built.
 *
 * So the rule was defeated by choosing a different hat:
 *
 *   1. Ferdows Workshop registers a supplier profile and submits for
 *      qualification.
 *   2. An operator holds `UNION_ADMIN` and belongs to **both** the union and
 *      Ferdows Workshop — an ordinary arrangement, not an attack setup.
 *   3. They send `X-Organization-Id: <the union>`.
 *   4. `resolveOrganization` accepts it, because the union is in their
 *      memberships. `context.organizationId` is now the union.
 *   5. `assertNotDecidingOwnCase` compares the union against Ferdows, sees no
 *      match, and approves their own submission.
 *
 * Every role check passes. Every tenant check passes. The one control that
 * exists to stop self-judgement is looking at a field the caller chooses.
 *
 * ## What the fix changes
 *
 * The complete authenticated membership set now travels from token claims into
 * `RequestContext` as `organizationIds`, frozen with the rest of the context,
 * and the check asks whether the supplier's organization appears **anywhere**
 * in it — not whether it happens to be the tenant selected for this request.
 *
 * Selecting a tenant still does what it did: it decides which organization's
 * rows a scoped query returns. It no longer decides who the caller is.
 *
 * ## What is deliberately preserved
 *
 * A `SYSTEM_ADMIN` with no active tenant and no memberships still decides
 * freely — that is the justified platform-operator case, and the tests below
 * pin it so a later tightening cannot quietly remove it. A caller who belongs
 * to no organization is not thereby suspect; a caller who belongs to the
 * supplier's is.
 */
describe('D-2 — self-judgement cannot be reached by selecting another tenant', () => {
  let api: ApiHarness;
  let prisma: PrismaService;

  const unionOrg = apiTenant('D2-UNION');
  const strangerOrg = apiTenant('D2-STRANGER');
  // One supplier organization per case. `supplier.organization_id` is unique —
  // one profile per organization is the directory's whole point — so cases that
  // shared one would collide on the second registration rather than test
  // anything.
  const organizations = [unionOrg, strangerOrg];

  beforeAll(async () => {
    api = await startApi();
    prisma = api.prisma;
    await cleanup(prisma, organizations);
  });

  afterAll(async () => {
    await cleanup(prisma, organizations);
    await api.close();
  });

  /** Registers a profile for a fresh organization and submits it for qualification. */
  async function registerAndSubmit(): Promise<{
    supplierId: string;
    qualificationId: string;
    supplierOrg: string;
  }> {
    const supplierOrg = apiTenant('D2-SUPPLIER');
    organizations.push(supplierOrg);

    const registered = await request(api.app.getHttpServer())
      .post('/v1/suppliers')
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({ displayName: 'کارگاه فردوس', capabilities: ['WORKSHOP_SERVICE'] })
      .expect(201);

    const submitted = await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${registered.body.id}/qualifications`)
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({ capability: 'WORKSHOP_SERVICE', statement: 'we service loaders', evidence: [] })
      .expect(201);

    return { supplierId: registered.body.id, qualificationId: submitted.body.id, supplierOrg };
  }

  const stateOf = async (qualificationId: string): Promise<string> => {
    const row = await runUnscoped('the D-2 suite reads the decided row directly', () =>
      prisma.client.qualification.findUniqueOrThrow({ where: { id: qualificationId } }),
    );
    return row.state;
  };

  // -------------------------------------------------------------------------
  // The bypass itself
  // -------------------------------------------------------------------------

  it('refuses an approval by an operator who also belongs to the supplier', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    // The union is the selected tenant; the supplier's organization is a
    // membership the caller did not select. Before the fix this returned 200.
    const token = multiMemberActor(unionOrg, [supplierOrg], ['UNION_ADMIN']);

    const response = await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
      .set('authorization', `Bearer ${token}`)
      .set('x-organization-id', unionOrg)
      .send({ note: 'approving my own workshop' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    // And nothing was decided: the refusal is not merely a status code.
    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });

  it('refuses a rejection by the same caller, so the bypass is not decision-shaped', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();
    const token = multiMemberActor(unionOrg, [supplierOrg], ['UNION_ADMIN']);

    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/reject`)
      .set('authorization', `Bearer ${token}`)
      .set('x-organization-id', unionOrg)
      .send({ reason: 'rejecting a rival to protect my own workshop' })
      .expect(403);

    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });

  it('refuses suspension and reinstatement by the same caller', async () => {
    const { supplierId, supplierOrg } = await registerAndSubmit();
    const token = multiMemberActor(unionOrg, [supplierOrg], ['UNION_ADMIN']);

    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/suspend`)
      .set('authorization', `Bearer ${token}`)
      .set('x-organization-id', unionOrg)
      .send({ reason: 'suspending a competitor' })
      .expect(403);

    // Suspend legitimately, then prove the compromised caller cannot lift it.
    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/suspend`)
      .set('authorization', `Bearer ${platformAdmin(unionOrg)}`)
      .send({ reason: 'a real suspension by an unconflicted operator' })
      .expect(200);

    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/reinstate`)
      .set('authorization', `Bearer ${token}`)
      .set('x-organization-id', unionOrg)
      .send({ reason: 'lifting my own suspension' })
      .expect(403);

    const supplier = await runUnscoped('the D-2 suite reads the supplier directly', () =>
      prisma.client.supplier.findUniqueOrThrow({ where: { id: supplierId } }),
    );
    expect(supplier.status).toBe('SUSPENDED');
  });

  it('refuses however the caller orders or selects their memberships', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    // The supplier organization as the *active* claim, the union selected by
    // header; and the reverse. Neither ordering nor selection may matter.
    const cases = [
      multiMemberActor(supplierOrg, [unionOrg], ['UNION_ADMIN']),
      multiMemberActor(unionOrg, [strangerOrg, supplierOrg], ['UNION_ADMIN']),
      multiMemberActor(unionOrg, [supplierOrg, strangerOrg], ['SYSTEM_ADMIN']),
    ];

    for (const token of cases) {
      await request(api.app.getHttpServer())
        .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
        .set('authorization', `Bearer ${token}`)
        .set('x-organization-id', unionOrg)
        .send({ note: 'still my own case' })
        .expect(403);
    }

    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });

  it('SYSTEM_ADMIN is not exempt when the membership is theirs', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
      .set('authorization', `Bearer ${multiMemberActor(unionOrg, [supplierOrg], ['SYSTEM_ADMIN'])}`)
      .set('x-organization-id', unionOrg)
      .send({ note: 'no role makes self-judgement acceptable' })
      .expect(403);

    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });

  // -------------------------------------------------------------------------
  // What must keep working
  // -------------------------------------------------------------------------

  it('still lets an unconflicted operator decide', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
      .set('authorization', `Bearer ${multiMemberActor(unionOrg, [strangerOrg], ['UNION_ADMIN'])}`)
      .set('x-organization-id', unionOrg)
      .send({ note: 'belongs to neither the supplier nor anything related to it' })
      .expect(200);

    expect(await stateOf(qualificationId)).toBe('APPROVED');
  });

  it('still lets a SYSTEM_ADMIN with no active tenant decide', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    // The justified platform case: no active organization, no memberships.
    // Belonging to nothing is not suspicious — belonging to the supplier is.
    await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/reject`)
      .set('authorization', `Bearer ${systemAdminWithoutTenant()}`)
      .send({ reason: 'decided by the platform, which belongs to no supplier' })
      .expect(200);

    expect(await stateOf(qualificationId)).toBe('REJECTED');
  });

  it('still refuses a supplier-side role outright, for its own reason', async () => {
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    // Not the self-judgement rule — the role check, which is the refusal that
    // actually applies to them. Reaching the *right* refusal matters: a caller
    // told "you may not decide your own case" would learn the wrong thing.
    const response = await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
      .set('authorization', `Bearer ${supplierActor(supplierOrg)}`)
      .send({ note: 'deciding for myself' });

    expect(response.status).toBe(403);
    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });

  it('refuses a tenant the caller does not belong to at all', async () => {
    // The pre-existing tenant guard, pinned here so the D-2 change cannot be
    // read as having replaced it. Selecting an organization you are not a
    // member of is still a TENANT_MISMATCH, before any supplier rule runs.
    const { supplierId, qualificationId, supplierOrg } = await registerAndSubmit();

    const response = await request(api.app.getHttpServer())
      .post(`/v1/suppliers/${supplierId}/qualifications/${qualificationId}/approve`)
      .set('authorization', `Bearer ${multiMemberActor(unionOrg, [], ['UNION_ADMIN'])}`)
      .set('x-organization-id', strangerOrg)
      .send({ note: 'a tenant I have no claim to' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TENANT_MISMATCH');
    expect(await stateOf(qualificationId)).toBe('SUBMITTED');
  });
});
