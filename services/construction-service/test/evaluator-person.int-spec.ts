import { RastaError, runUnscoped, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import {
  TEST_ISSUER,
  cleanup,
  context,
  evaluatingTender,
  loadStanding,
  ownerDatabaseUrl,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * One person is one evaluator of a bid, whatever user id they arrive with (#188, E1 and E2).
 *
 * `userId` is `rasta_uid ?? sub`, so one person can hold two user ids (U1, U2) for one token
 * subject. Before this, a person who stood down from a bid under U1 could decide on it or
 * score it under U2 (E1), and one person under U1 and U2 counted as two evaluators — enough for a
 * minimum of two on their own, their score twice in the mean (E2). The service compares the
 * caller with everyone on record for the bid (`compareActors`), and the database says the same:
 * the guards match the stored issuer and subject, and a partial unique index allows one
 * evaluation and one recusal per person and bid.
 */

/** A unique violation on (…, evaluator_issuer, evaluator_subject): one person twice. */
const UNIQUE_PERSON = /23505[\s\S]*evaluator_issuer, evaluator_subject/;

const SCORES = {
  scores: [
    { criterionCode: 'PRICE', scoreScaled: 7_000 },
    { criterionCode: 'LICENCE', scoreScaled: 100 },
  ],
};

describe('one person, one evaluator (#188 E1, E2)', () => {
  let w: Wiring;
  let owner: PrismaClient;
  const organizations: string[] = [];

  /** One person: one subject, any number of user ids. */
  const person = () => {
    const subject = `sub-${ulid()}`;
    const as =
      (organizationId: string, userId = `USR_${ulid()}`) =>
      <T>(fn: () => T): T =>
        runWithContext(
          context({
            organizationId,
            organizationIds: [organizationId],
            userId,
            subject,
            roles: ['ORGANIZATION_ADMIN'],
          }),
          fn,
        );
    return { subject, as };
  };

  const refusal = async (call: Promise<unknown>): Promise<RastaError> => {
    try {
      await call;
    } catch (error) {
      if (error instanceof RastaError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  /** A raw statement as the runtime role, past the service: what the database alone refuses. */
  const raw = (statement: string) =>
    runUnscoped('the suite writes past the service to prove the database refuses it', () =>
      w.prisma.client.$executeRawUnsafe(statement),
    );

  beforeAll(async () => {
    w = wire(
      testEnv({
        CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false',
        CONSTRUCTION_EVALUATION_MIN_EVALUATORS: '2',
        CONSTRUCTION_EVALUATION_MAX_EVALUATORS: '2',
      }),
    );
    await loadStanding(w);
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterAll(async () => {
    await owner.$disconnect();
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('E2: one person under two user ids does not satisfy a minimum of two evaluators', async () => {
    const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
    const pat = person();
    const asU1 = pat.as(o);
    const asU2 = pat.as(o);
    for (const { bidId } of bids) {
      await asU1(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
      await asU1(() => w.evaluation.score(tenderId, bidId, SCORES));
    }
    const second = await refusal(asU2(() => w.evaluation.score(tenderId, bids[0]!.bidId, SCORES)));
    expect(second.code).toBe('FORBIDDEN');
    expect(second.message).toContain('SAME_PERSON_AS_EVALUATOR');

    const early = await refusal(asU1(() => w.evaluation.evaluate(tenderId)));
    expect(early.message).toContain('EVALUATION_INCOMPLETE');

    // A second person completes the minimum.
    const quinn = person().as(o);
    for (const { bidId } of bids) await quinn(() => w.evaluation.score(tenderId, bidId, SCORES));
    expect(await asU1(() => w.evaluation.getMatrix(tenderId))).toMatchObject({
      ready: true,
      readinessBlockedBy: null,
    });
    expect((await asU1(() => w.evaluation.evaluate(tenderId))).alreadyEvaluated).toBe(false);
    const evaluations = await runUnscoped('the suite reads the claims', () =>
      w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
    );
    expect(evaluations).toHaveLength(4);
    expect(new Set(evaluations.map((e) => e.evaluatorSubject)).size).toBe(2);
  });

  it('E2: a person who evaluates a bid does not stand down from it under another id', async () => {
    const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
    const bidId = bids[0]!.bidId;
    const pat = person();
    await pat.as(o)(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
    await pat.as(o)(() => w.evaluation.score(tenderId, bidId, SCORES));
    const refused = await refusal(
      pat.as(o)(() => w.evaluation.recuse(tenderId, bidId, { reasonCode: 'OTHER' })),
    );
    expect(refused.message).toContain('SAME_PERSON_AS_EVALUATOR');
  });

  it('E1: a person who stood down under U1 neither decides, scores nor stands down again under U2', async () => {
    const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
    const bidId = bids[0]!.bidId;
    const pat = person();
    await pat.as(o)(() =>
      w.evaluation.recuse(tenderId, bidId, { reasonCode: 'CONFLICT_OF_INTEREST' }),
    );
    const asU2 = pat.as(o);

    const decided = await refusal(
      asU2(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' })),
    );
    expect(decided.message).toContain('RECUSED');
    await person().as(o)(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
    const scored = await refusal(asU2(() => w.evaluation.score(tenderId, bidId, SCORES)));
    expect(scored.message).toContain('RECUSED');
    const again = await refusal(
      asU2(() => w.evaluation.recuse(tenderId, bidId, { reasonCode: 'OTHER' })),
    );
    expect(again.message).toContain('RECUSED');

    // The refusals are audited, with their closed code.
    const rows = await runUnscoped('the suite reads the log', () =>
      w.prisma.client.bidAccessLog.findMany({
        where: { tenderId, outcome: 'REFUSED', refusalCode: 'RECUSED' },
      }),
    );
    expect(rows).toHaveLength(3);
  });

  it('refuses a caller who cannot be told from an evaluator on record without an identity: 422 ACTOR_IDENTITY_UNKNOWN', async () => {
    const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
    const [first, second] = [bids[0]!.bidId, bids[1]!.bidId];
    const decider = person().as(o);
    for (const bidId of [first, second]) {
      await decider(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
    }
    // Rows as they were written before the identity was recorded (the owner's connection).
    await owner.$executeRawUnsafe(
      `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "created_at")
       VALUES ('EVL_${ulid()}', '${o}', '${tenderId}', '${first}', 'USR_${ulid()}', now())`,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "bid_evaluation_recusal" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "reason_code", "recused_at")
       VALUES ('REC_${ulid()}', '${o}', '${tenderId}', '${second}', 'USR_${ulid()}', 'OTHER', now())`,
    );
    const caller = person().as(o);
    const claim = await refusal(caller(() => w.evaluation.score(tenderId, first, SCORES)));
    expect(claim.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    const scoreAfterRecusal = await refusal(
      caller(() => w.evaluation.score(tenderId, second, SCORES)),
    );
    expect(scoreAfterRecusal.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    const claims = await runUnscoped('the suite reads the claims', () =>
      w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
    );
    expect(claims).toHaveLength(1);
  });

  describe('completion counts people, not user ids (rows written before the record)', () => {
    /**
     * An evaluation of `bidId`, complete (both criteria scored), as it was written before the
     * stable identity was recorded — or, with `subject`, by a token of that subject. The owner's
     * connection, past the service; the guard triggers still apply.
     */
    const legacyEvaluation = async (
      o: string,
      tenderId: string,
      bidId: string,
      userId: string,
      subject: string | null = null,
    ): Promise<void> => {
      const evaluationId = `EVL_${ulid()}`;
      const pair = subject === null ? 'NULL, NULL' : `'${TEST_ISSUER}', '${subject}'`;
      await owner.$executeRawUnsafe(
        `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id",
                                       "evaluator_issuer", "evaluator_subject", "created_at")
         VALUES ('${evaluationId}', '${o}', '${tenderId}', '${bidId}', '${userId}', ${pair}, now())`,
      );
      for (const [criterion, score] of [
        ['PRICE', 7_000],
        ['LICENCE', 100],
      ] as const) {
        await owner.$executeRawUnsafe(
          `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
                                               "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
           VALUES ('SCR_${ulid()}', '${o}', '${tenderId}', '${bidId}', '${evaluationId}',
                   '${userId}', '${criterion}', 1, ${score}, now())`,
        );
      }
    };
    /** A qualified one-bid tender, its owner, and the refusals its completion logged. */
    const oneQualifiedBid = async () => {
      const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations, 1);
      const bidId = bids[0]!.bidId;
      await person().as(o)(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
      return { o, tenderId, bidId };
    };
    const completionRefusals = (tenderId: string) =>
      runUnscoped('the suite reads the log', () =>
        w.prisma.client.bidAccessLog.findMany({
          where: { tenderId, purpose: 'EVALUATE_BIDS', outcome: 'REFUSED' },
        }),
      );
    const statusOf = async (tenderId: string) =>
      (
        await runUnscoped('the suite reads the tender', () =>
          w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
        )
      ).status;

    it('refuses one person scoring under U1 and U2 before the record (UNKNOWN): the minimum of two is not met by them', async () => {
      const { o, tenderId, bidId } = await oneQualifiedBid();
      await legacyEvaluation(o, tenderId, bidId, `USR_${ulid()}`);
      await legacyEvaluation(o, tenderId, bidId, `USR_${ulid()}`);
      // Two complete evaluations by user id — but the matrix says what `evaluate` would answer.
      const matrix = await person().as(o)(() => w.evaluation.getMatrix(tenderId));
      expect(matrix).toMatchObject({
        blockers: [],
        ready: false,
        readinessBlockedBy: 'ACTOR_IDENTITY_UNKNOWN',
      });
      expect(matrix.bids[0]!.evaluatorCount).toBe(2);

      const refused = await refusal(person().as(o)(() => w.evaluation.evaluate(tenderId)));
      expect(refused.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(await statusOf(tenderId)).toBe('EVALUATING');
      expect((await completionRefusals(tenderId)).map((row) => row.refusalCode)).toEqual([
        'ACTOR_IDENTITY_UNKNOWN',
      ]);
    });

    it('refuses one person who scored under U1 and stood down under U2 before the record (UNKNOWN)', async () => {
      const { o, tenderId, bidId } = await oneQualifiedBid();
      await legacyEvaluation(o, tenderId, bidId, `USR_${ulid()}`);
      // A second evaluator, recorded, completes the minimum of two. (Through the service it would
      // be refused already: the command compares a new claim with the legacy one.)
      await legacyEvaluation(o, tenderId, bidId, `USR_${ulid()}`, `sub-${ulid()}`);
      await owner.$executeRawUnsafe(
        `INSERT INTO "bid_evaluation_recusal" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id",
                                               "reason_code", "recused_at")
         VALUES ('REC_${ulid()}', '${o}', '${tenderId}', '${bidId}', 'USR_${ulid()}', 'CONFLICT_OF_INTEREST', now())`,
      );
      expect(await person().as(o)(() => w.evaluation.getMatrix(tenderId))).toMatchObject({
        ready: false,
        readinessBlockedBy: 'ACTOR_IDENTITY_UNKNOWN',
      });
      const refused = await refusal(person().as(o)(() => w.evaluation.evaluate(tenderId)));
      expect(refused.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(await statusOf(tenderId)).toBe('EVALUATING');
    });

    it('refuses one person provably counted twice (SAME): a legacy row under their subject, a recorded one under a platform id', async () => {
      const { o, tenderId, bidId } = await oneQualifiedBid();
      const subject = `sub-${ulid()}`;
      // Written from a token without rasta_uid: the user id is the subject.
      await legacyEvaluation(o, tenderId, bidId, subject);
      await legacyEvaluation(o, tenderId, bidId, `USR_${ulid()}`, subject);
      expect(await person().as(o)(() => w.evaluation.getMatrix(tenderId))).toMatchObject({
        ready: false,
        readinessBlockedBy: 'SAME_PERSON_AS_EVALUATOR',
      });
      const refused = await refusal(person().as(o)(() => w.evaluation.evaluate(tenderId)));
      expect(refused.code).toBe('FORBIDDEN');
      expect(refused.message).toContain('SAME_PERSON_AS_EVALUATOR');
      expect((await completionRefusals(tenderId)).map((row) => row.refusalCode)).toEqual([
        'SAME_PERSON_AS_EVALUATOR',
      ]);
    });
  });

  describe('the database, past the service', () => {
    const evaluation = (
      o: string,
      tenderId: string,
      bidId: string,
      userId: string,
      subject: string,
    ) =>
      `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id",
                                     "evaluator_issuer", "evaluator_subject", "created_at")
       VALUES ('EVL_${ulid()}', '${o}', '${tenderId}', '${bidId}', '${userId}',
               '${TEST_ISSUER}', '${subject}', now())`;
    const recusal = (o: string, tenderId: string, bidId: string, userId: string, subject: string) =>
      `INSERT INTO "bid_evaluation_recusal" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id",
                                             "evaluator_issuer", "evaluator_subject", "reason_code", "recused_at")
       VALUES ('REC_${ulid()}', '${o}', '${tenderId}', '${bidId}', '${userId}',
               '${TEST_ISSUER}', '${subject}', 'OTHER', now())`;

    it('holds one evaluation and one recusal per person and bid, and a recused person to it under any id', async () => {
      const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
      const [first, second] = [bids[0]!.bidId, bids[1]!.bidId];
      const decider = person().as(o);
      for (const bidId of [first, second]) {
        await decider(() => w.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }));
      }
      const subject = `sub-${ulid()}`;

      await raw(evaluation(o, tenderId, first, `USR_${ulid()}`, subject));
      await expect(raw(evaluation(o, tenderId, first, `USR_${ulid()}`, subject))).rejects.toThrow(
        // ux_bid_evaluation_person: PostgreSQL names the key, not the index.
        UNIQUE_PERSON,
      );
      // Standing down under another id than the evaluation's: the scores would stay in the matrix.
      await expect(raw(recusal(o, tenderId, first, `USR_${ulid()}`, subject))).rejects.toThrow(
        'ck_recusal_person',
      );

      // Stood down from the second bid under one id: no claim under another.
      await raw(recusal(o, tenderId, second, `USR_${ulid()}`, subject));
      await expect(raw(recusal(o, tenderId, second, `USR_${ulid()}`, subject))).rejects.toThrow(
        // ux_bid_recusal_person
        UNIQUE_PERSON,
      );
      await expect(raw(evaluation(o, tenderId, second, `USR_${ulid()}`, subject))).rejects.toThrow(
        'ck_evaluation_recused',
      );
    });

    it('refuses a decision or a score by a person who stood down, matched on the identity', async () => {
      const { owner: o, tenderId, bids } = await evaluatingTender(w, organizations);
      const [first, second] = [bids[0]!.bidId, bids[1]!.bidId];
      const subject = `sub-${ulid()}`;

      // A decision on the first bid by a person who stood down from it under another id.
      await raw(recusal(o, tenderId, first, `USR_${ulid()}`, subject));
      await expect(
        raw(
          `INSERT INTO "bid_qualification" ("id", "organization_id", "tender_id", "bid_id", "decision",
                                            "decided_at", "decided_by", "decided_by_issuer", "decided_by_subject")
           VALUES ('QLF_${ulid()}', '${o}', '${tenderId}', '${first}', 'QUALIFIED', now(),
                   'USR_${ulid()}', '${TEST_ISSUER}', '${subject}')`,
        ),
      ).rejects.toThrow('ck_qualification_recused');

      // A score of the second bid on an evaluation claimed before the same person stood down.
      await person().as(o)(() => w.evaluation.qualify(tenderId, second, { decision: 'QUALIFIED' }));
      const claimant = `USR_${ulid()}`;
      const evaluationId = `EVL_${ulid()}`;
      await raw(
        `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id",
                                       "evaluator_issuer", "evaluator_subject", "created_at")
         VALUES ('${evaluationId}', '${o}', '${tenderId}', '${second}', '${claimant}',
                 '${TEST_ISSUER}', '${subject}', now())`,
      );
      // The owner writes the recusal past `ck_recusal_person`, as only a forgotten path could.
      await owner.$transaction([
        owner.$executeRawUnsafe(
          `ALTER TABLE "bid_evaluation_recusal" DISABLE TRIGGER "tg_bid_recusal_guard"`,
        ),
        owner.$executeRawUnsafe(recusal(o, tenderId, second, `USR_${ulid()}`, subject)),
        owner.$executeRawUnsafe(
          `ALTER TABLE "bid_evaluation_recusal" ENABLE TRIGGER "tg_bid_recusal_guard"`,
        ),
      ]);
      await expect(
        raw(
          `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
                                               "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
           VALUES ('SCR_${ulid()}', '${o}', '${tenderId}', '${second}', '${evaluationId}',
                   '${claimant}', 'PRICE', 1, 5000, now())`,
        ),
      ).rejects.toThrow('ck_score_recused');
    });
  });
});
