import request from 'supertest';
import { runUnscoped, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import {
  approvedProject,
  asBidder,
  bidContent,
  cleanup,
  context,
  loadStanding,
  ownerDatabaseUrl,
  qualify,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * #188, part B: one person holding two user ids does not pass construction's separation of
 * duties, through the real `AppModule` and the real `AuthGuard`.
 *
 * `userId` is `rasta_uid ?? sub`. So one person — one token subject — can arrive as two user
 * ids: two platform ids (U1, U2) for one subject, or the subject itself on a token without
 * `rasta_uid`. Every check is driven with such a pair, on each side of:
 *
 *   A1  bid-opening four eyes        the proposer vs the approver (Q-91)
 *   B1  approval-policy four eyes    the author and the submitter vs the approver (Q-70 (7))
 *   C1  EVALUATOR_NOT_TENDER_AUTHOR  the tender's creator and publisher vs the evaluator
 *
 * and with a row written before the identity was recorded (UNKNOWN: refused, fail closed), a
 * row from another issuer (UNKNOWN too), and a genuinely different person (the positive
 * control). Each write is checked to have kept the token's issuer and subject.
 */

const OLD_ISSUER = 'http://old-issuer.invalid/realms/rasta';

describe('stable actor identity (#188) through the API', () => {
  let api: ApiHarness;
  let w: Wiring;
  let owner: PrismaClient;
  const organizations: string[] = [];
  const previousCoiRules = process.env.CONSTRUCTION_COI_RULES;

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const org = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };
  const issuer = (): string => process.env.OIDC_ISSUER_URL!;

  /** One person: one token subject. Each token minted for them is another way in. */
  const person = () => {
    const sub = `sub-${ulid()}`;
    const token = (
      organizationId: string,
      roles: string[],
      options: { platformUserId?: boolean; iss?: string } = {},
    ): string =>
      bearer({
        sub,
        // A platform id of its own on every token: U1, U2 … for one subject.
        ...(options.platformUserId === false
          ? {}
          : { rastaUserId: `USR-APITEST-${ulid().slice(-8)}` }),
        ...(options.iss ? { iss: options.iss } : {}),
        organizationId,
        organizationIds: [organizationId],
        roles,
      });
    return { sub, token };
  };

  /** Runs the domain as the person behind `sub`, as the guard would have left the context. */
  const asPerson = <T>(organizationId: string, sub: string, fn: () => T): T =>
    runWithContext(
      context({
        organizationId,
        organizationIds: [organizationId],
        userId: `USR-APITEST-${ulid().slice(-8)}`,
        issuer: issuer(),
        subject: sub,
        platformUserId: true,
        roles: ['ORGANIZATION_ADMIN'],
      }),
      fn,
    );

  /** Raw SQL as the database owner: how a row written before this change looks. */
  const sql = (statement: string) => owner.$executeRawUnsafe(statement);
  const tenderRow = (tenderId: string) =>
    runUnscoped('the suite reads the row it checks', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );

  /** A tender written and published by `authorSub`, with two bids, past its deadline and CLOSED. */
  const closed = async (label: string, authorSub = `sub-${ulid()}`) => {
    const ownerOrg = org(`${label}-owner`);
    const project = await approvedProject(w, ownerOrg);
    const tender = await asPerson(ownerOrg, authorSub, () =>
      w.tenders.create(project.id, {
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres of the main road',
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        bidOpeningAt: new Date(Date.now() - 3_600_000).toISOString(),
        bidClosingAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      }),
    );
    const set = await asPerson(ownerOrg, authorSub, () =>
      w.criteria.setCriteria(tender.id, {
        expectedVersion: tender.version,
        criteria: [
          {
            code: 'PRICE',
            label: 'Price',
            weightBp: 6000,
            scoringMethod: 'MANUAL_SCORE',
            maxScore: 100,
          },
          {
            code: 'LICENCE',
            label: 'Licence',
            weightBp: 4000,
            scoringMethod: 'PASS_FAIL',
            maxScore: 1,
          },
        ],
      }),
    );
    await asPerson(ownerOrg, authorSub, () =>
      w.publication.publishApproved(tender.id, { expectedVersion: set.version }),
    );
    const bidIds: string[] = [];
    for (const [i, price] of ['1250000000', '1300000000'].entries()) {
      const bidder = org(`${label}-bidder${i}`);
      await qualify(w, bidder);
      const view = await asBidder(bidder, () =>
        w.bids.submit(tender.id, { content: bidContent(price) }),
      );
      bidIds.push(view.bidId);
    }
    await runUnscoped('the suite lets the deadline pass', () =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tender.id}'`,
      ),
    );
    await w.tenderClose.close({ organizationId: ownerOrg, tenderId: tender.id });
    return { owner: ownerOrg, tenderId: tender.id, bidIds };
  };

  /** The same tender, opened (one-person opening in the domain wiring): EVALUATING. */
  const evaluating = async (label: string, authorSub: string) => {
    const tender = await closed(label, authorSub);
    await asPerson(tender.owner, `sub-${ulid()}`, () => w.tenderOpen.open(tender.tenderId));
    return tender;
  };

  beforeAll(async () => {
    // C1 is a configurable rule (Q-90), off by default: on for this application.
    process.env.CONSTRUCTION_COI_RULES = 'EVALUATOR_NOT_TENDER_AUTHOR';
    api = await startApi();
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterEach(() => {
    api.memberships.reset();
    api.evidence.failure = undefined;
    api.evidence.served.clear();
  });

  afterAll(async () => {
    if (previousCoiRules === undefined) delete process.env.CONSTRUCTION_COI_RULES;
    else process.env.CONSTRUCTION_COI_RULES = previousCoiRules;
    await owner.$disconnect();
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  // -- A1: bid-opening four eyes ---------------------------------------------------------

  describe('A1: the approver of an opening is not its proposer', () => {
    const propose = (tenderId: string, token: string) =>
      http().post(`/v1/tenders/${tenderId}/open-bids/proposal`).set(as(token));
    const open = (tenderId: string, token: string) =>
      http().post(`/v1/tenders/${tenderId}/open-bids`).set(as(token));
    const withdraw = (tenderId: string, token: string) =>
      http().post(`/v1/tenders/${tenderId}/open-bids/proposal/withdraw`).set(as(token));

    it('refuses one person approving under a second platform id (U1 vs U2): 422 SECOND_PERSON_REQUIRED', async () => {
      const { owner: o, tenderId } = await closed('a1-u1u2');
      const alice = person();
      expect((await propose(tenderId, alice.token(o, ['ORGANIZATION_ADMIN']))).status).toBe(200);

      // The proposal keeps who it was, not only the user id.
      const row = await tenderRow(tenderId);
      expect(row.openingProposedByIssuer).toBe(issuer());
      expect(row.openingProposedBySubject).toBe(alice.sub);

      const self = await open(tenderId, alice.token(o, ['ORGANIZATION_ADMIN']));
      expect(self.status).toBe(422);
      expect(self.body.message).toContain('SECOND_PERSON_REQUIRED');

      // The positive control: a second person opens.
      const bob = person();
      const opened = await open(tenderId, bob.token(o, ['ORGANIZATION_ADMIN']));
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({ tenderId, alreadyOpened: false });
    });

    it('refuses a token without rasta_uid on every opening route: 403, before anything is done', async () => {
      const { owner: o, tenderId } = await closed('a1-nouid');
      const alice = person();
      const withoutUid = alice.token(o, ['ORGANIZATION_ADMIN'], { platformUserId: false });

      const proposed = await propose(tenderId, withoutUid);
      expect(proposed.status).toBe(403);
      expect(proposed.body.code).toBe('FORBIDDEN');
      expect(proposed.body.message).not.toContain(alice.sub);
      expect((await tenderRow(tenderId)).openingProposedBy).toBeNull();

      // Proposed with the platform id; the same subject without it neither approves nor withdraws.
      expect((await propose(tenderId, alice.token(o, ['ORGANIZATION_ADMIN']))).status).toBe(200);
      expect((await open(tenderId, withoutUid)).status).toBe(403);
      expect((await withdraw(tenderId, withoutUid)).status).toBe(403);
      expect((await tenderRow(tenderId)).openedAt).toBeNull();
    });

    it('refuses a proposal that names no identity (older than the record): 422 ACTOR_IDENTITY_UNKNOWN; withdrawn and proposed again, it opens', async () => {
      const { owner: o, tenderId } = await closed('a1-old');
      const alice = person();
      const aliceToken = alice.token(o, ['ORGANIZATION_ADMIN']);
      expect((await propose(tenderId, aliceToken)).status).toBe(200);
      await sql(
        `UPDATE "tender" SET "opening_proposed_by_issuer" = NULL, "opening_proposed_by_subject" = NULL
          WHERE "id" = '${tenderId}'`,
      );

      const bob = person();
      const unknown = await open(tenderId, bob.token(o, ['ORGANIZATION_ADMIN']));
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect((await tenderRow(tenderId)).openedAt).toBeNull();
      // The refusal is audited like every other one on this route.
      const refused = await runUnscoped('the suite reads the log', () =>
        w.prisma.client.bidAccessLog.findMany({
          where: { tenderId, outcome: 'REFUSED', refusalCode: 'ACTOR_IDENTITY_UNKNOWN' },
        }),
      );
      expect(refused).toHaveLength(1);

      // The documented remedy: the proposer withdraws (an exact user-id match) and proposes again.
      expect((await withdraw(tenderId, aliceToken)).status).toBe(200);
      const cleared = await tenderRow(tenderId);
      expect(cleared.openingProposedByIssuer).toBeNull();
      expect(cleared.openingProposedBySubject).toBeNull();
      expect((await propose(tenderId, aliceToken)).status).toBe(200);
      expect((await open(tenderId, bob.token(o, ['ORGANIZATION_ADMIN']))).status).toBe(200);
    });

    it('refuses a proposal recorded under another issuer: 422 ACTOR_IDENTITY_UNKNOWN', async () => {
      const { owner: o, tenderId } = await closed('a1-issuer');
      expect((await propose(tenderId, person().token(o, ['ORGANIZATION_ADMIN']))).status).toBe(200);
      await sql(
        `UPDATE "tender" SET "opening_proposed_by_issuer" = '${OLD_ISSUER}' WHERE "id" = '${tenderId}'`,
      );
      const other = await open(tenderId, person().token(o, ['ORGANIZATION_ADMIN']));
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    });
  });

  // -- B1: approval-policy four eyes -------------------------------------------------------

  describe('B1: the approver of a policy is neither its author nor its submitter', () => {
    const PLATFORM = 'ORG-APITEST-PLATFORM';
    const policyBody = (organizationId: string) => ({
      organizationId,
      workflowKey: 'project.execution',
      label: 'Council approval',
      rationale: 'Resolution recorded by the council',
      steps: [
        {
          approvalType: 'Council approval',
          authorityOrganizationId: organizationId,
          authorityRole: 'ORGANIZATION_ADMIN',
          authorityLabel: 'Village council',
        },
      ],
    });
    /** A union-written policy, created by `author` and submitted by `submitter`: PENDING. */
    const pending = async (
      label: string,
      author: ReturnType<typeof person>,
      submitter = author,
    ): Promise<string> => {
      const governed = org(`${label}-org`);
      const union = org(`${label}-union`);
      api.hierarchy.adopt(union, governed);
      const created = await http()
        .post('/v1/approval-policies')
        .set(as(author.token(union, ['UNION_ADMIN'])))
        .send(policyBody(governed))
        .expect(201);
      await http()
        .post(`/v1/approval-policies/${created.body.id}/submit`)
        .set(as(submitter.token(union, ['UNION_ADMIN'])))
        .send({ expectedVersion: 1 })
        .expect(200);
      return created.body.id as string;
    };
    const approve = (policyId: string, token: string) =>
      http()
        .post(`/v1/approval-policies/${policyId}/approve`)
        .set(as(token))
        .send({ expectedVersion: 2 });
    const policyRow = (policyId: string) =>
      runUnscoped('the suite reads the row it checks', () =>
        w.prisma.client.approvalPolicy.findFirstOrThrow({ where: { id: policyId } }),
      );

    it('refuses the author approving under a second platform id (U1 vs U2): 403', async () => {
      const carol = person();
      const policyId = await pending('b1-author', carol, person());
      const row = await policyRow(policyId);
      expect(row.createdByIssuer).toBe(issuer());
      expect(row.createdBySubject).toBe(carol.sub);
      expect(row.submittedByIssuer).toBe(issuer());

      const self = await approve(policyId, carol.token(PLATFORM, ['SYSTEM_ADMIN']));
      expect(self.status).toBe(403);
      expect(self.body.message).toMatch(/written by a union is approved by a different person/);
      expect((await policyRow(policyId)).status).toBe('PENDING_PLATFORM_APPROVAL');
    });

    it('refuses the submitter approving under a second platform id (U1 vs U2): 403', async () => {
      const dave = person();
      const policyId = await pending('b1-submitter', person(), dave);
      expect((await policyRow(policyId)).submittedBySubject).toBe(dave.sub);
      const self = await approve(policyId, dave.token(PLATFORM, ['SYSTEM_ADMIN']));
      expect(self.status).toBe(403);
    });

    it('refuses a token without rasta_uid on create, submit and approve: 403', async () => {
      const erin = person();
      const governed = org('b1-nouid-org');
      const union = org('b1-nouid-union');
      api.hierarchy.adopt(union, governed);
      const created = await http()
        .post('/v1/approval-policies')
        .set(as(erin.token(union, ['UNION_ADMIN'], { platformUserId: false })))
        .send(policyBody(governed));
      expect(created.status).toBe(403);

      const policyId = await pending('b1-nouid', erin);
      const submitAgain = await http()
        .post(`/v1/approval-policies/${policyId}/submit`)
        .set(as(erin.token(union, ['UNION_ADMIN'], { platformUserId: false })))
        .send({ expectedVersion: 2 });
      expect(submitAgain.status).toBe(403);
      const self = await approve(
        policyId,
        erin.token(PLATFORM, ['SYSTEM_ADMIN'], { platformUserId: false }),
      );
      expect(self.status).toBe(403);
      expect(self.body.message).not.toContain(erin.sub);
      expect((await policyRow(policyId)).status).toBe('PENDING_PLATFORM_APPROVAL');
    });

    it('refuses a policy whose author has no recorded identity: 422 ACTOR_IDENTITY_UNKNOWN; another issuer likewise', async () => {
      const old = await pending('b1-old', person());
      await sql(
        `UPDATE "approval_policy" SET "created_by_issuer" = NULL, "created_by_subject" = NULL
          WHERE "id" = '${old}'`,
      );
      const unknown = await approve(old, person().token(PLATFORM, ['SYSTEM_ADMIN']));
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');

      const moved = await pending('b1-issuer', person());
      await sql(
        `UPDATE "approval_policy" SET "submitted_by_issuer" = '${OLD_ISSUER}' WHERE "id" = '${moved}'`,
      );
      const other = await approve(moved, person().token(PLATFORM, ['SYSTEM_ADMIN']));
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect((await policyRow(moved)).status).toBe('PENDING_PLATFORM_APPROVAL');
    });

    it('lets a different person approve (the positive control)', async () => {
      const policyId = await pending('b1-ok', person());
      const approved = await approve(policyId, person().token(PLATFORM, ['SYSTEM_ADMIN']));
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('ACTIVE');
    });
  });

  // -- C1: EVALUATOR_NOT_TENDER_AUTHOR ------------------------------------------------------

  describe('C1: the evaluator is neither the creator nor the publisher of the tender', () => {
    const qualifyBid = (tenderId: string, bidId: string, token: string) =>
      http()
        .post(`/v1/tenders/${tenderId}/bids/${bidId}/qualification`)
        .set(as(token))
        .send({ decision: 'QUALIFIED' });

    it('refuses the author evaluating under a second platform id (U1 vs U2): 403 EVALUATOR_IS_TENDER_AUTHOR', async () => {
      const frank = person();
      const { owner: o, tenderId, bidIds } = await evaluating('c1-u1u2', frank.sub);
      const row = await tenderRow(tenderId);
      expect([row.createdByIssuer, row.createdBySubject]).toEqual([issuer(), frank.sub]);
      expect([row.publishedByIssuer, row.publishedBySubject]).toEqual([issuer(), frank.sub]);

      const self = await qualifyBid(tenderId, bidIds[0]!, frank.token(o, ['ORGANIZATION_ADMIN']));
      expect(self.status).toBe(403);
      expect(self.body.message).toContain('EVALUATOR_IS_TENDER_AUTHOR');
    });

    it('refuses a token without rasta_uid on every evaluation write: 403', async () => {
      const grace = person();
      const { owner: o, tenderId, bidIds } = await evaluating('c1-nouid', `sub-${ulid()}`);
      const token = grace.token(o, ['ORGANIZATION_ADMIN'], { platformUserId: false });
      const bidId = bidIds[0]!;
      const writes: [string, object][] = [
        [`/v1/tenders/${tenderId}/bids/${bidId}/qualification`, { decision: 'QUALIFIED' }],
        [`/v1/tenders/${tenderId}/bids/${bidId}/recusal`, { reasonCode: 'OTHER' }],
        [
          `/v1/tenders/${tenderId}/bids/${bidId}/scores`,
          { scores: [{ criterionCode: 'PRICE', scoreScaled: 100 }] },
        ],
        [`/v1/tenders/${tenderId}/evaluate`, {}],
      ];
      for (const [path, body] of writes) {
        expect((await http().post(path).set(as(token)).send(body)).status).toBe(403);
      }
    });

    it('refuses an evaluator of a tender whose author has no recorded identity: 422 ACTOR_IDENTITY_UNKNOWN', async () => {
      const { owner: o, tenderId, bidIds } = await evaluating('c1-old', `sub-${ulid()}`);
      await sql(
        `UPDATE "tender" SET "created_by_issuer" = NULL, "created_by_subject" = NULL
          WHERE "id" = '${tenderId}'`,
      );
      const unknown = await qualifyBid(
        tenderId,
        bidIds[0]!,
        person().token(o, ['ORGANIZATION_ADMIN']),
      );
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    });

    it('lets a different person evaluate, and keeps every evaluator identity an award will compare', async () => {
      const { owner: o, tenderId, bidIds } = await evaluating('c1-ok', `sub-${ulid()}`);
      const [first, second] = [bidIds[0]!, bidIds[1]!];
      const heidi = person();
      const ivan = person();
      const heidiToken = heidi.token(o, ['ORGANIZATION_ADMIN']);

      for (const bidId of [first, second]) {
        expect((await qualifyBid(tenderId, bidId, heidiToken)).status).toBe(200);
      }
      // Another evaluator stands down from the first bid before scoring it.
      expect(
        (
          await http()
            .post(`/v1/tenders/${tenderId}/bids/${first}/recusal`)
            .set(as(ivan.token(o, ['ORGANIZATION_ADMIN'])))
            .send({ reasonCode: 'OTHER' })
        ).status,
      ).toBe(200);
      for (const bidId of [first, second]) {
        const scored = await http()
          .post(`/v1/tenders/${tenderId}/bids/${bidId}/scores`)
          .set(as(heidiToken))
          .send({
            scores: [
              { criterionCode: 'PRICE', scoreScaled: 8_000 },
              { criterionCode: 'LICENCE', scoreScaled: 100 },
            ],
          });
        expect(scored.status).toBe(200);
      }
      const evaluated = await http()
        .post(`/v1/tenders/${tenderId}/evaluate`)
        .set(as(heidiToken))
        .send({});
      expect(evaluated.status).toBe(200);

      const rows = await runUnscoped('the suite reads the rows it checks', async () => ({
        tender: await w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
        decisions: await w.prisma.client.bidQualification.findMany({ where: { tenderId } }),
        evaluations: await w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
        recusals: await w.prisma.client.bidEvaluationRecusal.findMany({ where: { tenderId } }),
      }));
      expect([rows.tender.evaluatedByIssuer, rows.tender.evaluatedBySubject]).toEqual([
        issuer(),
        heidi.sub,
      ]);
      expect(rows.decisions).toHaveLength(2);
      for (const decision of rows.decisions) {
        expect([decision.decidedByIssuer, decision.decidedBySubject]).toEqual([
          issuer(),
          heidi.sub,
        ]);
      }
      expect(rows.evaluations).toHaveLength(2);
      for (const evaluation of rows.evaluations) {
        expect([evaluation.evaluatorIssuer, evaluation.evaluatorSubject]).toEqual([
          issuer(),
          heidi.sub,
        ]);
      }
      expect(rows.recusals.map((r) => [r.evaluatorIssuer, r.evaluatorSubject])).toEqual([
        [issuer(), ivan.sub],
      ]);
    });
  });

  // -- E1, E2: one person is one evaluator of a bid ----------------------------------------

  describe('E1, E2: one person is one evaluator of a bid, whatever user id they arrive with', () => {
    const post = (path: string, token: string, body: object) =>
      http().post(path).set(as(token)).send(body);
    const scores = {
      scores: [
        { criterionCode: 'PRICE', scoreScaled: 7_000 },
        { criterionCode: 'LICENCE', scoreScaled: 100 },
      ],
    };

    it('E1: U1 stands down, U2 of the same person neither decides nor scores: 403 RECUSED', async () => {
      const { owner: o, tenderId, bidIds } = await evaluating('e1', `sub-${ulid()}`);
      const bid = `/v1/tenders/${tenderId}/bids/${bidIds[0]!}`;
      const judy = person();
      expect(
        (
          await post(`${bid}/recusal`, judy.token(o, ['ORGANIZATION_ADMIN']), {
            reasonCode: 'OTHER',
          })
        ).status,
      ).toBe(200);

      const decided = await post(`${bid}/qualification`, judy.token(o, ['ORGANIZATION_ADMIN']), {
        decision: 'QUALIFIED',
      });
      expect(decided.status).toBe(403);
      expect(decided.body.message).toContain('RECUSED');

      expect(
        (
          await post(`${bid}/qualification`, person().token(o, ['ORGANIZATION_ADMIN']), {
            decision: 'QUALIFIED',
          })
        ).status,
      ).toBe(200);
      const scored = await post(`${bid}/scores`, judy.token(o, ['ORGANIZATION_ADMIN']), scores);
      expect(scored.status).toBe(403);
      expect(scored.body.message).toContain('RECUSED');
    });

    it('E2: U1 and U2 of one person both claim a bid: the second is refused, 403 SAME_PERSON_AS_EVALUATOR', async () => {
      const { owner: o, tenderId, bidIds } = await evaluating('e2', `sub-${ulid()}`);
      const bid = `/v1/tenders/${tenderId}/bids/${bidIds[0]!}`;
      const kim = person();
      expect(
        (
          await post(`${bid}/qualification`, kim.token(o, ['ORGANIZATION_ADMIN']), {
            decision: 'QUALIFIED',
          })
        ).status,
      ).toBe(200);
      expect(
        (await post(`${bid}/scores`, kim.token(o, ['ORGANIZATION_ADMIN']), scores)).status,
      ).toBe(200);
      const second = await post(`${bid}/scores`, kim.token(o, ['ORGANIZATION_ADMIN']), scores);
      expect(second.status).toBe(403);
      expect(second.body.message).toContain('SAME_PERSON_AS_EVALUATOR');
      const recused = await post(`${bid}/recusal`, kim.token(o, ['ORGANIZATION_ADMIN']), {
        reasonCode: 'OTHER',
      });
      expect(recused.status).toBe(403);
      expect(recused.body.message).toContain('SAME_PERSON_AS_EVALUATOR');

      const claims = await runUnscoped('the suite reads the claims', () =>
        w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
      );
      expect(claims).toHaveLength(1);
    });
  });

  // -- the database's half of it -----------------------------------------------------------

  describe('the identity pairs the database keeps', () => {
    it('refuses half a pair, a blank one, and an identity beside no actor', async () => {
      const { tenderId } = await closed('db-checks');
      const refused = async (statement: string, constraint: string) => {
        await expect(sql(statement)).rejects.toThrow(constraint);
      };
      await refused(
        `UPDATE "tender" SET "created_by_issuer" = NULL WHERE "id" = '${tenderId}'`,
        'ck_tender_created_by_identity',
      );
      await refused(
        `UPDATE "tender" SET "created_by_subject" = ' ' WHERE "id" = '${tenderId}'`,
        'ck_tender_created_by_identity',
      );
      await refused(
        `UPDATE "tender" SET "opening_proposed_by_issuer" = 'x', "opening_proposed_by_subject" = 'y'
          WHERE "id" = '${tenderId}'`,
        'ck_tender_opening_proposed_by_identity',
      );
      await refused(
        `UPDATE "tender" SET "evaluated_by_issuer" = 'x', "evaluated_by_subject" = 'y'
          WHERE "id" = '${tenderId}'`,
        'ck_tender_evaluated_by_identity',
      );
      // Both NULL is the older row's shape: accepted.
      await sql(
        `UPDATE "tender" SET "created_by_issuer" = NULL, "created_by_subject" = NULL
          WHERE "id" = '${tenderId}'`,
      );
    });
  });
});
