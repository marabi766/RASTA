import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  reasonsOf,
  actor,
  auditorActor,
  internalToken,
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
  awardApproved,
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

  // The people who evaluated the suite's tenders hold identities of the suite's own issuer, which a token of
  // the API's issuer cannot be compared with (UNKNOWN, fail closed): with AWARDER_NOT_EVALUATOR on, no award
  // passes through HTTP here. The rule has its own suites; this one proves the gate, so it is off for its length.
  const coiBefore = process.env.CONSTRUCTION_COI_RULES;

  beforeAll(async () => {
    process.env.CONSTRUCTION_COI_RULES = '';
    api = await startApi();
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  afterEach(() => {
    api.memberships.reset();
    api.evidence.failure = undefined;
  });

  afterAll(async () => {
    if (coiBefore === undefined) delete process.env.CONSTRUCTION_COI_RULES;
    else process.env.CONSTRUCTION_COI_RULES = coiBefore;
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
    expect(reasonsOf(res.body)).toEqual(['award:CONFLICT_OF_INTEREST']);
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

  it('fails closed with no policy (422 APPROVAL_POLICY_REQUIRED); with one, answers 202 and awards only once another person approved it', async () => {
    const { owner, tenderId, bids } = await evaluated();
    const award = () =>
      http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(orgAdmin(owner)))
        .send({ bidId: bids[0]!.bidId });

    const none = await award();
    expect(none.status).toBe(422);
    expect(none.body.message).toContain('APPROVAL_POLICY_REQUIRED');
    expect(reasonsOf(none.body)).toEqual(['award:APPROVAL_POLICY_REQUIRED']);
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });

    expect((await refusedRows(tenderId)).map((r) => r.refusalCode)).toEqual([
      'APPROVAL_POLICY_REQUIRED',
    ]);

    await activateAwardPolicy(w, owner);
    const requester = orgAdmin(owner);
    const ask = () =>
      http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(requester))
        .send({ bidId: bids[0]!.bidId });
    const asked = await ask();
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ workflowKey: 'tender.award', status: 'PENDING' });
    expect(await stateOf(tenderId)).toEqual({ tender: 'EVALUATED', awards: 0 });

    // The approver is shown the bid it decides on, never the price; the requester does not approve it.
    const stepId = asked.body.steps[0].approvalId as string;
    const approver = orgAdmin(owner);
    const seen = await http().get(`/v1/approvals/${stepId}`).set(as(approver));
    expect(seen.status).toBe(200);
    expect(seen.body.request.bid).toMatchObject({
      bidId: bids[0]!.bidId,
      standingVerdict: 'ELIGIBLE',
    });
    expect(JSON.stringify(seen.body)).not.toMatch(/amount|price/i);
    const decision = (token: string) =>
      http()
        .post(`/v1/approvals/${stepId}/decision`)
        .set(as(token))
        .send({ decision: 'GRANT', expectedVersion: seen.body.version });
    expect((await decision(requester)).status).toBe(403);
    expect((await decision(approver)).status).toBe(200);

    const awarded = await ask();
    expect(awarded.status).toBe(200);
    expect(awarded.body).toMatchObject({
      status: 'AWARDED',
      bidId: bids[0]!.bidId,
      alreadyAwarded: false,
    });
    expect(await stateOf(tenderId)).toEqual({ tender: 'AWARDED', awards: 1 });
    // The same award again answers itself and uses nothing.
    expect((await ask()).body).toMatchObject({ alreadyAwarded: true });
  });

  it('serves the award, with the winner’s price, to the owner’s person and to contract-service only, through the real guards', async () => {
    const { owner, tenderId, bids } = await evaluated();
    const path = `/v1/tenders/${tenderId}/award`;
    const get = (token?: string) => {
      const req = http().get(path);
      return token ? req.set(as(token)) : req;
    };
    const service = async (caller: string, org: string) =>
      http()
        .get(path)
        .set('x-internal-token', await internalToken(caller, { organizationId: org }));

    // Not awarded yet: nothing to read, and the refusal is the owner's to see.
    expect((await get(orgAdmin(owner))).status).toBe(404);
    expect((await service('contract-service', owner)).status).toBe(404);

    await asAdmin(owner, () => awardApproved(w, tenderId, { bidId: bids[0]!.bidId }));

    const read = await get(orgAdmin(owner));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      tenderId,
      status: 'AWARDED',
      bidId: bids[0]!.bidId,
      amountMinor: '1000',
      alreadyAwarded: true,
    });
    expect(typeof read.body.amountMinor).toBe('string');

    // contract-service, with a token signed for the owner's organization.
    const viaService = await service('contract-service', owner);
    expect(viaService.status).toBe(200);
    expect(viaService.body).toMatchObject({ bidId: bids[0]!.bidId, amountMinor: '1000' });

    // Nobody else: no token, no other service, a token for another organization, a token for none.
    expect((await get()).status).toBe(401);
    expect((await service('audit-service', owner)).status).toBe(403);
    expect((await service('fleet-service', owner)).status).toBe(403);
    expect((await service('contract-service', 'ORG-APITEST-award-elsewhere')).status).toBe(404);
    expect(
      (
        await http()
          .get(path)
          .set('x-internal-token', await internalToken('contract-service'))
      ).status,
    ).toBe(404);
    // A user does not get in by the service door, and a service token does not carry roles.
    expect((await get(actor(owner, ['SYSTEM_ADMIN']))).status).toBe(403);
    expect((await get(auditorActor(owner))).status).toBe(403);
    expect((await get(actor(owner, ['CONTRACTOR']))).status).toBe(403);
    expect((await get(actor(bids[0]!.bidder, ['CONTRACTOR']))).status).toBe(404);
    expect((await get(orgAdmin('ORG-APITEST-award-elsewhere'))).status).toBe(404);

    // A member of a bidding organization is refused before the award is shown.
    const conflicted = await get(
      multiMemberActor(owner, [bids[1]!.bidder], ['ORGANIZATION_ADMIN']),
    );
    expect(conflicted.status).toBe(403);
    expect(conflicted.body.message).toContain('CONFLICT_OF_INTEREST');
    expect(JSON.stringify(conflicted.body)).not.toContain('1000');

    // Reads of the price are in the owner's log, the service's under its own name.
    const rows = await runUnscoped('the suite reads the log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId, purpose: 'READ_AWARD' } }),
    );
    expect(
      rows
        .filter((r) => r.outcome === 'GRANTED')
        .map((r) => r.accessorUserId)
        .sort(),
    ).toEqual([expect.stringMatching(/^USR-APITEST-/), 'service:contract-service']);
    // And the price is on no event.
    const events = JSON.stringify(await outboxFor(api.prisma, owner), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(events).not.toMatch(/amountMinor/);
  });

  it('shows a contractor its own outcome of an award made through the core, and the owner the bids’ outcome', async () => {
    const { owner, tenderId, bids } = await evaluated();
    // The core, as the owner's person: the route cannot award until the approval round is wired.
    await asAdmin(owner, () => awardApproved(w, tenderId, { bidId: bids[0]!.bidId }));

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
