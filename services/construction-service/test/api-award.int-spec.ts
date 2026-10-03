import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  actor,
  auditorActor,
  multiMemberActor,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  activateAwardPolicy,
  asAdmin,
  cleanup,
  evaluatedTender,
  loadStanding,
  outboxFor,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Awarding through the real `AppModule` (ADR-067 § 3): closed without a token and to every role the
 * configuration did not grant, `404` for another organization, `403` to a member of a bidding
 * organization, strict bodies, the approval gate that stays closed until the round is wired (PR 11) —
 * so that no request awards anything yet — and what a contractor sees of an award made through the
 * domain core.
 */

describe('award API', () => {
  let api: ApiHarness;
  /** The domain, with one-person opening, to bring a tender to EVALUATED before the API is used. */
  let w: Wiring;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  const evaluated = (count = 2) => evaluatedTender(w, organizations, { count });

  const refusedRows = (tenderId: string) =>
    runUnscoped('the suite reads the log', () =>
      w.prisma.client.bidAccessLog.findMany({
        where: { tenderId, purpose: 'AWARD_TENDER', outcome: 'REFUSED' },
      }),
    );

  const stateOf = async (tenderId: string) => ({
    tender: (
      await runUnscoped('the suite reads the tender', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
      )
    ).status,
    awards: await runUnscoped('the suite counts the awards', () =>
      w.prisma.client.tenderAward.count({ where: { tenderId } }),
    ),
  });

  beforeAll(async () => {
    api = await startApi();
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  afterEach(() => {
    api.memberships.reset();
    api.evidence.failure = undefined;
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  it('is closed without a token, and refuses and audits every role the configuration did not grant on the owner’s own tender', async () => {
    const { owner: a, tenderId, bids } = await evaluated();
    const path = `/v1/tenders/${tenderId}/award`;
    const body = { bidId: bids[0]!.bidId };
    const call = (token?: string) => {
      const req = http().post(path);
      return (token ? req.set(as(token)) : req).send(body);
    };
    expect((await call()).status).toBe(401);
    expect(await refusedRows(tenderId)).toHaveLength(0);
    for (const token of [
      auditorActor(a),
      actor(a, ['CONTRACTOR']),
      actor(a, ['SYSTEM_ADMIN']),
      actor(a, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']),
      actor(a, ['CONTRACTOR', 'ORGANIZATION_ADMIN']),
      actor(a, ['AUDITOR', 'ORGANIZATION_ADMIN']),
      actor(a, ['FLEET_MANAGER']),
    ]) {
      expect((await call(token)).status).toBe(403);
    }
    // Each was stopped by the service (the route names no role at the guard) and left a REFUSED row
    // with its closed code and a BID_ACCESSED event before the 403.
    const rows = await refusedRows(tenderId);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.refusalCode))).toEqual(
      new Set(['FORBIDDEN', 'INSUFFICIENT_ROLE']),
    );
    expect(rows.every((r) => r.organizationId === a && r.accessorOrganizationId === a)).toBe(true);
    const events = (await outboxFor(api.prisma, a)).filter(
      (e) =>
        e.eventName === 'BID_ACCESSED' &&
        (e.payload as { payload: { purpose: string; outcome: string } }).payload.purpose ===
          'AWARD_TENDER',
    );
    expect(events).toHaveLength(7);

    // A tender that is not their organization's, or that does not exist: 404 for every role,
    // nothing logged anywhere.
    const stranger = 'ORG-APITEST-award-stranger';
    organizations.push(stranger);
    const before = (await refusedRows(tenderId)).length;
    const eventsBefore = (await outboxFor(api.prisma, a)).length;
    for (const token of [
      auditorActor(stranger),
      actor(stranger, ['FLEET_MANAGER']),
      actor(stranger, ['SYSTEM_ADMIN']),
      orgAdmin(stranger),
      actor(bids[0]!.bidder, ['CONTRACTOR']),
    ]) {
      const res = await http().post(path).set(as(token)).send(body);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    for (const token of [auditorActor(a), orgAdmin(a)]) {
      const res = await http().post('/v1/tenders/TND_missing/award').set(as(token)).send(body);
      expect(res.status).toBe(404);
    }
    expect((await refusedRows(tenderId)).length).toBe(before);
    expect((await outboxFor(api.prisma, a)).length).toBe(eventsBefore);
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });
  });

  it('refuses unknown fields, a missing or empty bid, and a blank or oversized justification with 400', async () => {
    const { owner, tenderId, bids } = await evaluated();
    const send = (payload: object) =>
      http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(orgAdmin(owner)))
        .send(payload);
    for (const bad of [
      {},
      { bidId: '' },
      { bidId: 7 },
      { bidId: bids[0]!.bidId, justification: '' },
      { bidId: bids[0]!.bidId, justification: '   ' },
      { bidId: bids[0]!.bidId, justification: 'x'.repeat(2001) },
      { bidId: bids[0]!.bidId, awardedBy: 'USR_X' },
      { bidId: bids[0]!.bidId, organizationId: 'ORG_X' },
      { bidId: bids[0]!.bidId, status: 'AWARDED' },
      { bidId: bids[0]!.bidId, amountMinor: '1' },
      { bidId: bids[0]!.bidId, expectedVersion: 3 },
    ]) {
      expect((await send(bad)).status).toBe(400);
    }
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });
  });

  it('answers 403 CONFLICT_OF_INTEREST to a member of a bidding organization, before the gate and before anything of the tender, and audits it', async () => {
    const { owner, tenderId, bids } = await evaluated();
    const res = await http()
      .post(`/v1/tenders/${tenderId}/award`)
      .set(as(multiMemberActor(owner, [bids[1]!.bidder], ['ORGANIZATION_ADMIN'])))
      .send({ bidId: bids[0]!.bidId });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('CONFLICT_OF_INTEREST');
    expect((await refusedRows(tenderId)).map((r) => r.refusalCode)).toEqual([
      'CONFLICT_OF_INTEREST',
    ]);
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });
  });

  it('answers 503 when identity-service cannot say who the caller is, and nothing is done', async () => {
    const { owner, tenderId, bids } = await evaluated();
    api.memberships.failure = new Error('connect ECONNREFUSED');
    const res = await http()
      .post(`/v1/tenders/${tenderId}/award`)
      .set(as(orgAdmin(owner)))
      .send({ bidId: bids[0]!.bidId });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });
  });

  it('fails closed on the approval gate: 422 APPROVAL_POLICY_REQUIRED with no policy, APPROVAL_REQUIRED with one — awarding nothing', async () => {
    const { owner, tenderId, bids } = await evaluated();
    const award = () =>
      http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(orgAdmin(owner)))
        .send({ bidId: bids[0]!.bidId });

    const none = await award();
    expect(none.status).toBe(422);
    expect(none.body.message).toContain('APPROVAL_POLICY_REQUIRED');
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });

    await activateAwardPolicy(w, owner);
    const inForce = await award();
    expect(inForce.status).toBe(422);
    expect(inForce.body.message).toContain('APPROVAL_REQUIRED');
    expect(inForce.body.message).not.toContain('APPROVAL_POLICY_REQUIRED');
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });
    expect((await refusedRows(tenderId)).map((r) => r.refusalCode).sort()).toEqual([
      'APPROVAL_POLICY_REQUIRED',
      'APPROVAL_REQUIRED',
    ]);
  });

  it('shows a contractor its own outcome of an award made through the core, and the owner the bids’ outcome', async () => {
    const { owner, tenderId, bids } = await evaluated();
    // The core, as the owner's person: the route cannot award until the approval round is wired.
    await asAdmin(owner, () => w.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }));

    const path = `/v1/tenders/${tenderId}/bids/mine/opened`;
    const winner = await http()
      .get(path)
      .set(as(actor(bids[0]!.bidder, ['CONTRACTOR'])));
    expect(winner.status).toBe(200);
    expect(winner.body).toMatchObject({ bidId: bids[0]!.bidId, status: 'AWARDED' });
    const loser = await http()
      .get(path)
      .set(as(actor(bids[1]!.bidder, ['CONTRACTOR'])));
    expect(loser.status).toBe(200);
    expect(loser.body).toMatchObject({ bidId: bids[1]!.bidId, status: 'NOT_AWARDED' });
    const seen = JSON.stringify(loser.body);
    expect(seen).not.toContain(bids[0]!.bidder);
    expect(seen).not.toContain(bids[0]!.bidId);
    expect(seen).not.toContain('"priceMinor":"1000"');

    const matrix = await http()
      .get(`/v1/tenders/${tenderId}/evaluation`)
      .set(as(orgAdmin(owner)));
    expect(matrix.status).toBe(200);
    const status = (id: string) =>
      matrix.body.bids.find((b: { bidId: string }) => b.bidId === id).bidStatus;
    expect(status(bids[0]!.bidId)).toBe('AWARDED');
    expect(status(bids[1]!.bidId)).toBe('NOT_AWARDED');
  });
});
