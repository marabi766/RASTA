import { ulid } from 'ulid';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  RastaError,
  runUnscoped,
  UnprocessableEventError,
  type EventConsumer,
} from '@rasta/nest-common';
import { RewardGrantError } from '../src/reward/reward.service';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

type Transaction = Parameters<Parameters<PrismaService['transaction']>[0]>[0];
import { FakeSourceFacts } from './source-facts.fake';

/**
 * What the two consumers do with every kind of event they can receive.
 *
 * `event-flow.int-spec.ts` proves the path — a real broker, a real
 * subscription, an event that travels. This file proves the **decisions**: the
 * approval with no workshop, the repair that cost nothing, the in-house job,
 * the replay under a new event id, the trigger with no user to reward, and the
 * reward rule that throws. Each of those is a branch that decides whether an
 * obligation exists or a point is granted, and none of them is reachable by
 * publishing one well-formed event.
 *
 * The handlers are invoked directly rather than through Kafka, so every branch
 * is deterministic and the suite runs without a broker. Everything below the
 * handler — the transaction, `processed_event`, the constraints — is real.
 *
 * The owners of the facts (maintenance-service, fleet-service) are a registry
 * that answers as their internal reads do (`source-facts.fake.ts`). ADR-061 § 4's
 * Compliance cases are here: an approval the owner does not confirm (missing,
 * another amount, another organization) records no obligation, and a reward
 * event with a forged actor credits nobody the owner did not record.
 */
describe('economic consumers', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let settlementAuthority: SettlementAuthorityConsumer;
  let rewardTrigger: RewardTriggerConsumer;

  const org = tenants();
  const sources = new FakeSourceFacts();

  /**
   * A consumer that never touches a broker.
   *
   * The class takes a factory so its subscription can be supplied from
   * outside — which is what makes this possible without a `jest.mock` of
   * kafkajs.
   */
  const noBroker = (): EventConsumer =>
    ({
      start: async () => undefined,
      stop: async () => undefined,
    }) as unknown as EventConsumer;

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    settlementAuthority = new SettlementAuthorityConsumer(
      noBroker,
      prisma,
      wiring.transactions,
      sources,
    );
    rewardTrigger = new RewardTriggerConsumer(noBroker, prisma, wiring.rewards, sources);
  });

  // The operator records the cutover after draining the old consumers; no
  // migration does (PR #110 round 3 #1). This suite stands in for the
  // operator: an instant before any fact it writes, after the 2020 fact the
  // round 2 #3 case needs refused. Kept if an earlier run recorded one; it
  // can never be moved back anyway.
  beforeAll(async () => {
    await runUnscoped('the suite records the platform-wide cutover as an operator would', () =>
      recordCutoverIfMissing(prisma.client, new Date('2021-01-01T00:00:00.000Z')),
    );
  });

  afterEach(() => {
    sources.unavailable = false;
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /**
   * An envelope shaped the way maintenance-service and fleet-service publish
   * one — built by hand from their contracts rather than imported, because
   * importing across `services/*` is forbidden (AGENTS.md A-02) and a change
   * on the producer's side must surface as a failing test rather than as a
   * compile error that never happens.
   */
  function envelope(
    eventName: string,
    payload: Record<string, unknown>,
    overrides: Partial<EventEnvelope> = {},
  ): EventEnvelope {
    return {
      eventId: ulid(),
      eventName,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'maintenance-service',
      producerVersion: '0.1.0',
      aggregateType: 'MaintenanceRequest',
      aggregateId: String(payload.requestId ?? payload.usageRecordId ?? 'unknown'),
      tenantId: String(payload.organizationId ?? org.a),
      correlationId: `consumer-itest-${ulid()}`,
      payload,
      ...overrides,
    } as EventEnvelope;
  }

  function approval(overrides: Record<string, unknown> = {}) {
    return {
      requestId: `MNT_${ulid()}`,
      assetId: `AST_${ulid()}`,
      organizationId: org.a,
      approvedBy: 'USR-CONSUMER-ITEST',
      approvedAt: new Date().toISOString(),
      workshopOrganizationId: org.b,
      totalCostMinor: '450000',
      currency: 'IRR',
      ...overrides,
    };
  }

  const processedBy = (consumerName: string, eventId: string) =>
    runUnscoped('the suite reads the processed-event ledger', () =>
      prisma.client.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName } },
      }),
    );

  const findBySource = (requestId: string) =>
    runUnscoped('the consumer suite reads across tenants to verify what was written', () =>
      prisma.client.transaction.findFirst({
        where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: requestId },
      }),
    );

  // -------------------------------------------------------------------------
  // Settlement authority
  // -------------------------------------------------------------------------

  it('ignores an event it does not consume', async () => {
    // Not an error and not a dead-letter: the topic carries every maintenance
    // event, and most of them are somebody else's.
    await expect(
      settlementAuthority.handle(envelope('MAINTENANCE_STARTED', approval())),
    ).resolves.toBe('SKIPPED');
  });

  it('records a settleable obligation, and moves no money', async () => {
    const payload = approval();
    sources.approved(payload);

    const outcome = await settlementAuthority.handle(
      envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload),
    );
    expect(outcome).toBeUndefined();

    const recorded = await findBySource(payload.requestId);
    expect(recorded).not.toBeNull();
    // Straight to PENDING_SETTLEMENT: the authorising fact is the approval
    // itself (ADR-032). And no escrow — the work is done and the amount is
    // owed whether or not the payer's wallet has anything in it.
    expect(recorded?.status).toBe('PENDING_SETTLEMENT');
    expect(recorded?.grossAmountMinor).toBe(450_000n);
    expect(recorded?.counterpartyOrganizationId).toBe(org.b);

    const holds = await runUnscoped('the suite checks that no escrow was taken', () =>
      prisma.client.walletHold.count({ where: { reference: recorded!.id } }),
    );
    expect(holds).toBe(0);
  });

  it('skips an approval with no workshop — there is nobody to pay', async () => {
    const payload = approval({ workshopOrganizationId: null });
    sources.approved(payload);
    const event = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload);

    await expect(settlementAuthority.handle(event)).resolves.toBe('SKIPPED');

    // Skipped rather than dead-lettered: an in-house repair with no external
    // workshop is a valid thing for maintenance-service to publish, and a
    // dead-letter would make an ordinary event look like a defect and need a
    // human to clear it. Decided after the owner confirmed it (PR #110 review
    // #2), and marked processed so a redelivery does not ask again.
    expect(await findBySource(payload.requestId)).toBeNull();
    expect(sources.calls.at(-1)).toMatchObject({ id: payload.requestId });
    expect(
      await processedBy(SettlementAuthorityConsumer.CONSUMER_NAME, event.eventId),
    ).not.toBeNull();
  });

  it('skips an approval that cost nothing', async () => {
    const payload = approval({ totalCostMinor: '0' });
    sources.approved(payload);

    await expect(
      settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload)),
    ).resolves.toBe('SKIPPED');
    expect(await findBySource(payload.requestId)).toBeNull();
  });

  it('skips an in-house repair, where payer and payee are one organization', async () => {
    const payload = approval({ workshopOrganizationId: org.a });
    sources.approved(payload);

    await expect(
      settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload)),
    ).resolves.toBe('SKIPPED');
    // `ck_transaction_distinct_parties` would refuse the row anyway; it is
    // recognised here so it reads as a decision rather than as a constraint
    // violation in a log.
    expect(await findBySource(payload.requestId)).toBeNull();
  });

  it('has no second effect on a replay of the same event', async () => {
    const payload = approval();
    sources.approved(payload);
    const first = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload);

    await settlementAuthority.handle(first);
    const created = await findBySource(payload.requestId);

    // The same event id again — the `processed_event` row and the obligation
    // committed together, so the ledger of what has been handled is exact.
    await expect(settlementAuthority.handle(first)).resolves.toBe('SKIPPED');

    // And the same approval re-emitted under a **new** event id, which passes
    // the processed-event check. One repair must produce one obligation, so
    // `(sourceType, sourceReference)` catches it.
    await settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload));

    const all = await runUnscoped('the suite counts obligations across tenants', () =>
      prisma.client.transaction.findMany({
        where: { sourceType: 'MAINTENANCE_REQUEST', sourceReference: payload.requestId },
      }),
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(created!.id);
  });

  it('refuses a malformed approval rather than recording a guess', async () => {
    // `.passthrough()` tolerates fields this service does not read; it does
    // not tolerate a missing amount. A financial obligation with no figure is
    // not something to infer.
    await expect(
      settlementAuthority.handle(
        envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, {
          requestId: `MNT_${ulid()}`,
          assetId: 'AST_1',
          organizationId: org.a,
          approvedBy: 'USR',
          approvedAt: new Date().toISOString(),
          currency: 'IRR',
        }),
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Settlement authority: the owner confirms, or nothing is recorded (ADR-061 § 4)
  // -------------------------------------------------------------------------

  /** Handles the event and expects the owner's refusal, dead-lettered at once. */
  async function expectRefused(
    consumer: { handle(envelope: EventEnvelope): Promise<unknown> },
    event: EventEnvelope,
    mismatch: string,
  ): Promise<void> {
    const failure = await consumer.handle(event).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnprocessableEventError);
    expect((failure as UnprocessableEventError).reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    expect((failure as UnprocessableEventError).message).toContain(mismatch);
  }

  it('records nothing for an approval maintenance-service has no record of', async () => {
    // The forged event: well-formed, on the right topic, naming a request the
    // owner never approved. Before ADR-061 this became an obligation.
    const payload = approval();
    const event = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload);

    await expectRefused(settlementAuthority, event, 'not_found');

    expect(await findBySource(payload.requestId)).toBeNull();
    // Not marked processed: a replay after a fix at the owner must be free to
    // succeed.
    expect(await processedBy(SettlementAuthorityConsumer.CONSUMER_NAME, event.eventId)).toBeNull();
  });

  it('records nothing when the owner approved a different amount', async () => {
    const payload = approval({ totalCostMinor: '450000' });
    sources.approved({ ...payload, totalCostMinor: '45000' });

    await expectRefused(
      settlementAuthority,
      envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload),
      'amount_mismatch',
    );
    expect(await findBySource(payload.requestId)).toBeNull();
  });

  it('records nothing when the approval belongs to another organization', async () => {
    // The request is real, and approved, but in org C. An event naming org A
    // as the payer is asked about inside org A (the tenant is signed into the
    // token) and the owner finds nothing there.
    const payload = approval();
    sources.approved({ ...payload, organizationId: org.c });

    await expectRefused(
      settlementAuthority,
      envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload),
      'not_found',
    );
    expect(await findBySource(payload.requestId)).toBeNull();
    expect(sources.calls.at(-1)).toEqual({
      owner: 'maintenance',
      organizationId: org.a,
      id: payload.requestId,
    });
  });

  it('records nothing for work the owner has not approved, or approved to someone else', async () => {
    const notYet = approval();
    sources.approved(notYet, { status: 'COMPLETED', approvedAt: null, approvedBy: null });
    await expectRefused(
      settlementAuthority,
      envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, notYet),
      'status_mismatch',
    );

    // A payee the owner never named: the most direct theft this closes.
    const redirected = approval({ workshopOrganizationId: org.c });
    sources.approved({ ...redirected, workshopOrganizationId: org.b });
    await expectRefused(
      settlementAuthority,
      envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, redirected),
      'workshop_mismatch',
    );

    expect(await findBySource(notYet.requestId)).toBeNull();
    expect(await findBySource(redirected.requestId)).toBeNull();
  });

  it('records nothing, and retries, while maintenance-service cannot be asked', async () => {
    // Fail closed. The error is the retryable kind, not a refusal: once the
    // owner is back, the retry or a DLQ replay records the obligation.
    const payload = approval();
    sources.approved(payload);
    sources.unavailable = true;
    const event = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload);

    const failure = await settlementAuthority.handle(event).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(UnprocessableEventError);
    expect(failure).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(await findBySource(payload.requestId)).toBeNull();
    expect(await processedBy(SettlementAuthorityConsumer.CONSUMER_NAME, event.eventId)).toBeNull();

    sources.unavailable = false;
    await expect(settlementAuthority.handle(event)).resolves.toBeUndefined();
    expect(await findBySource(payload.requestId)).not.toBeNull();
  });

  // PR #110 review #2: a skip is decided from the owner's record, after it
  // confirmed the approval, never from what the event claims.
  it.each<[string, Record<string, unknown>, string]>([
    ['claims no workshop', { workshopOrganizationId: null }, 'workshop_mismatch'],
    ['claims it cost nothing', { totalCostMinor: '0' }, 'amount_mismatch'],
    ["claims the payer's own workshop", { workshopOrganizationId: 'SELF' }, 'workshop_mismatch'],
  ])(
    'dead-letters an approval that %s when the owner recorded a real payable',
    async (_case, claimed, mismatch) => {
      const real = approval();
      sources.approved(real);
      const claim = {
        ...real,
        ...claimed,
        ...(claimed.workshopOrganizationId === 'SELF' ? { workshopOrganizationId: org.a } : {}),
      };
      const event = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, claim);

      // Before, each of these returned SKIPPED unasked and the real
      // obligation to org B was silently never recorded.
      await expectRefused(settlementAuthority, event, mismatch);
      expect(sources.calls.at(-1)).toMatchObject({ id: real.requestId });
      expect(await findBySource(real.requestId)).toBeNull();
      expect(
        await processedBy(SettlementAuthorityConsumer.CONSUMER_NAME, event.eventId),
      ).toBeNull();

      // The honest event still records it.
      await expect(
        settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, real)),
      ).resolves.toBeUndefined();
      expect((await findBySource(real.requestId))?.counterpartyOrganizationId).toBe(org.b);
    },
  );

  // PR #110 review #3: the envelope's tenant is the payload's, or nothing is asked.
  it("refuses an approval whose envelope is another tenant's, before asking anyone", async () => {
    // A real approval in org C, published under an envelope for org A.
    const payload = approval({ organizationId: org.c });
    sources.approved(payload);
    const event = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload, { tenantId: org.a });

    await expectRefused(settlementAuthority, event, 'tenant_mismatch');
    expect(sources.calls.some((call) => call.id === payload.requestId)).toBe(false);
    expect(await findBySource(payload.requestId)).toBeNull();

    // And one with no tenant at all.
    const untenanted = envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, approval(), {
      tenantId: undefined,
    });
    await expectRefused(settlementAuthority, untenanted, 'tenant_mismatch');
  });

  // -------------------------------------------------------------------------
  // Reward triggers
  // -------------------------------------------------------------------------

  function usage(overrides: Record<string, unknown> = {}) {
    return {
      usageRecordId: `USG_${ulid()}`,
      assetId: `AST_${ulid()}`,
      organizationId: org.a,
      hours: '7.5',
      ...overrides,
    };
  }

  const userActor = (id = 'USR-REWARD-SUBJECT') =>
    ({ actor: { type: 'USER' as const, id } }) as Partial<EventEnvelope>;

  async function createRule(points = 5, extra: Record<string, unknown> = {}) {
    return asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId: org.a,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        points,
        status: 'ACTIVE',
        ...extra,
        // JUSTIFIED-ANY: the DTO is a Zod inference with several optional
        // shapes; spelling it out here would restate the schema rather than
        // test anything.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
  }

  it('ignores an event that triggers no reward', async () => {
    await expect(rewardTrigger.handle(envelope('ASSET_CREATED', usage()))).resolves.toBe('SKIPPED');
  });

  it('asks the owner even when no rule could pay', async () => {
    // No rule exists yet. Nothing can be granted, but the evaluation is
    // recorded permanently, so it may only be recorded for a confirmed fact
    // (PR #110 round 2 #4).
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'USR-NO-RULE' });
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor())),
    ).resolves.toBeUndefined();
    expect(sources.calls.some((call) => call.id === payload.usageRecordId)).toBe(true);
  });

  it('grants points once per source fact, however many times the event arrives', async () => {
    await createRule(5);
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'USR-REWARD-SUBJECT' });
    const first = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    await expect(rewardTrigger.handle(first)).resolves.toBeUndefined();
    // The same event: stopped by `processed_event`.
    await expect(rewardTrigger.handle(first)).resolves.toBe('SKIPPED');
    // A new event id for the same usage record: stopped by
    // `(ruleId, sourceReference)`. Keying on the event id instead would let a
    // re-emitted event earn again, which is the fraud vector docs/10 § 10.9
    // names.
    await rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor()));

    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.findMany({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.points).toBe(5);
    // Points-only, so no journal: a zero-value ledger entry would break the
    // balanced-journal trigger and say nothing (ADR-033).
    expect(rewards[0]!.journalId).toBeNull();
    expect(rewards[0]!.monetised).toBe(false);
    expect(rewards[0]!.userId).toBe('USR-REWARD-SUBJECT');
  });

  // ADR-061 § 4: the subject and the organization are the owner's.

  it('credits the user the owner recorded, never the actor the event names', async () => {
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'USR-REAL-RECORDER' });

    await expect(
      rewardTrigger.handle(
        envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor('USR-FORGED-ACTOR')),
      ),
    ).resolves.toBeUndefined();

    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.findMany({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards.map((reward) => reward.userId)).toEqual(['USR-REAL-RECORDER']);
    const forged = await runUnscoped('the suite looks for the forged subject everywhere', () =>
      prisma.client.reward.count({ where: { userId: 'USR-FORGED-ACTOR' } }),
    );
    expect(forged).toBe(0);
  });

  it('grants nothing for a usage record the owner does not have in that organization', async () => {
    // A forged event: a user actor, org A's rule in force, and a record that
    // is real but belongs to org C, or does not exist at all.
    const elsewhere = usage();
    sources.recorded({ ...elsewhere, organizationId: org.c });
    const invented = usage();

    for (const payload of [elsewhere, invented]) {
      await expectRefused(
        rewardTrigger,
        envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor('USR-FORGED-ACTOR')),
        'not_found',
      );
      const rewards = await runUnscoped('the suite counts grants across tenants', () =>
        prisma.client.reward.count({ where: { sourceReference: payload.usageRecordId } }),
      );
      expect(rewards).toBe(0);
    }
  });

  it('grants nothing when the owner recorded no user — there is no subject to reward', async () => {
    // A usage record imported by a batch job has nobody to credit. Points for
    // "the system" would be a fabricated subject, and a user actor on the
    // event does not change what the owner recorded.
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'SYSTEM' });

    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor())),
    ).resolves.toBe('SKIPPED');
    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.count({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards).toBe(0);
  });

  it('grants nothing, and retries, while fleet-service cannot be asked', async () => {
    const payload = usage();
    sources.recorded(payload);
    sources.unavailable = true;
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    await expect(rewardTrigger.handle(event)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();
    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.count({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards).toBe(0);
  });

  // Global audit L7-13: a failed grant is redelivered, never finalised.

  /** A monetised rule: every point also credits the organization's wallet. */
  const monetisedRuleIn = (organizationId: string, points: number) =>
    asActor({ organizationId, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        points,
        creditPerPointMinor: '1000',
        status: 'ACTIVE',
        validFrom: new Date(Date.now() - 86_400_000).toISOString(),
        // JUSTIFIED-ANY: as above — the DTO is a Zod inference.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

  it('leaves a transiently failed grant unprocessed, and a redelivery pays it exactly once', async () => {
    const tenant = `${org.a}-GRANTFAIL`;
    await monetisedRuleIn(tenant, 5);
    const payload = usage({ organizationId: tenant });
    sources.recorded(payload, { recordedBy: 'USR-TRANSIENT' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    // A database blip inside the grant's own transaction, after the claim
    // committed: the wallet credit fails once.
    const blip = jest
      .spyOn(wiring.wallets, 'credit')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    // Rethrown, not swallowed: the framework retries it, and it is not a
    // verdict, so it is not dead-lettered at once either.
    const failure = await rewardTrigger.handle(event).then(
      () => null,
      (error: unknown) => error,
    );
    blip.mockRestore();
    expect(failure).toBeInstanceOf(RewardGrantError);
    expect(failure).not.toBeInstanceOf(UnprocessableEventError);
    expect((failure as RewardGrantError).permanent).toBe(false);

    // Nothing paid, nothing finalised; the claim is held by this event.
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(0);
    const [claim] = await evaluationFor(payload.usageRecordId);
    expect(claim).toMatchObject({ origin: 'EVENT', eventId: event.eventId, outcome: 'EVALUATED' });

    // The redelivery pays, once, with the money the rule promised.
    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    const paid = await rewardsFor(payload.usageRecordId);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.monetised).toBe(true);
    expect(paid[0]!.creditAmountMinor).toBe(5000n);
    expect(paid[0]!.journalId).not.toBeNull();
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).not.toBeNull();

    // A third delivery, or the same fact under a new event id, pays nothing.
    await expect(rewardTrigger.handle(event)).resolves.toBe('SKIPPED');
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor())),
    ).resolves.toBe('SKIPPED');
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(1);
  });

  it('dead-letters a grant a rule refuses, keeps the other rules, and a replay finishes it', async () => {
    const tenant = `${org.a}-GRANTREFUSED`;
    const rules = [await monetisedRuleIn(tenant, 2), await monetisedRuleIn(tenant, 3)];
    const payload = usage({ organizationId: tenant });
    sources.recorded(payload, { recordedBy: 'USR-REFUSED' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    // A verdict, not a blip: whichever rule is granted first is refused.
    const refusal = jest
      .spyOn(wiring.wallets, 'credit')
      .mockRejectedValueOnce(RastaError.businessRule('A credit must be positive'));

    const failure = await rewardTrigger.handle(event).then(
      () => null,
      (error: unknown) => error,
    );
    refusal.mockRestore();
    expect(failure).toBeInstanceOf(UnprocessableEventError);
    expect((failure as UnprocessableEventError).reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);

    // The other rule committed; the event is not finalised.
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(1);
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();

    // The dead letter replayed once the rule is fixed: the missing grant is
    // paid, the one already paid is not paid again.
    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    const paid = await rewardsFor(payload.usageRecordId);
    expect(paid.map((reward) => reward.ruleId).sort()).toEqual(rules.map((rule) => rule.id).sort());
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).not.toBeNull();
  });

  it('reads a completed repair as a reward trigger too, keyed on the request', async () => {
    await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId: org.a,
        triggerEvent: 'MAINTENANCE_COMPLETED',
        rewardType: 'POINTS',
        points: 3,
        status: 'ACTIVE',
        // JUSTIFIED-ANY: as above — the DTO is a Zod inference.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

    const payload = {
      requestId: `MNT_${ulid()}`,
      assetId: `AST_${ulid()}`,
      organizationId: org.a,
      type: 'PREVENTIVE',
      completedAt: new Date().toISOString(),
    };
    sources.completed(payload, { completedBy: 'USR-MAINT' });

    // A repair the owner still has in progress is not a completion, whatever
    // the event says.
    const unfinished = { ...payload, requestId: `MNT_${ulid()}` };
    sources.completed(unfinished, { status: 'IN_PROGRESS', completedAt: null, completedBy: null });
    await expectRefused(
      rewardTrigger,
      envelope(CONSUMED_EVENTS.MAINTENANCE_COMPLETED, unfinished, userActor('USR-MAINT')),
      'status_mismatch',
    );

    await expect(
      rewardTrigger.handle(
        envelope(CONSUMED_EVENTS.MAINTENANCE_COMPLETED, payload, userActor('USR-MAINT')),
      ),
    ).resolves.toBeUndefined();

    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.findMany({ where: { sourceReference: payload.requestId } }),
    );
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.points).toBe(3);
    expect(rewards[0]!.userId).toBe('USR-MAINT');
  });

  // PR #110 review #3, the reward side.
  it("refuses a reward trigger whose envelope is another tenant's, before asking anyone", async () => {
    const payload = usage({ organizationId: org.c });
    sources.recorded(payload, { recordedBy: 'USR-REWARD-SUBJECT' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, {
      ...userActor(),
      tenantId: org.a,
    });

    await expectRefused(rewardTrigger, event, 'tenant_mismatch');
    expect(sources.calls.some((call) => call.id === payload.usageRecordId)).toBe(false);
    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.count({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards).toBe(0);
  });

  // PR #110 review #1: one evaluation per source fact, whatever event id.
  it('grants nothing to a fact re-emitted under a new event id after a backdated rule', async () => {
    // Org B, which has no rule yet.
    const inB = () => usage({ organizationId: org.b });
    const fact = inB();
    sources.recorded(fact, { recordedBy: 'USR-REWARD-B' });

    // Consumed while nothing could pay: the owner confirms it, and the fact
    // is recorded as evaluated.
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, fact, userActor())),
    ).resolves.toBeUndefined();

    // A rule activated later, valid from a day before the fact.
    const ruleFor = (points: number) =>
      asActor({ organizationId: org.b, roles: ['SYSTEM_ADMIN'] }, () =>
        wiring.rewards.createRule({
          organizationId: org.b,
          triggerEvent: 'USAGE_RECORDED',
          rewardType: 'POINTS',
          points,
          status: 'ACTIVE',
          validFrom: new Date(Date.now() - 86_400_000).toISOString(),
          // JUSTIFIED-ANY: as above — the DTO is a Zod inference.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      );
    await ruleFor(4);

    // The same fact under a new event id: passes processed_event and the
    // owner would confirm it, but it has been evaluated already.
    const replay = envelope(CONSUMED_EVENTS.USAGE_RECORDED, fact, userActor());
    await expect(rewardTrigger.handle(replay)).resolves.toBe('SKIPPED');
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, replay.eventId)).not.toBeNull();

    const countFor = (sourceReference: string) =>
      runUnscoped('the suite counts grants across tenants', () =>
        prisma.client.reward.count({ where: { sourceReference } }),
      );
    expect(await countFor(fact.usageRecordId)).toBe(0);

    // A new fact is paid by that rule once; a second rule activated after
    // does not pay it again when it is re-emitted.
    const later = inB();
    sources.recorded(later, { recordedBy: 'USR-REWARD-B' });
    await rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, later, userActor()));
    expect(await countFor(later.usageRecordId)).toBe(1);

    await ruleFor(9);
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, later, userActor())),
    ).resolves.toBe('SKIPPED');
    expect(await countFor(later.usageRecordId)).toBe(1);
  });

  it('lets the event that claimed a fact finish it after a crash, and no other', async () => {
    // The claim committed, then the process died before processed_event did.
    // The same event, redelivered, still holds the claim and completes.
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'USR-CRASH' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    // A process that dies after the claim commits leaves the claim and no
    // processed_event. A grant that throws now leaves exactly that state
    // (global audit L7-13), so the throw stands in for the crash.
    const spy = jest
      .spyOn(wiring.rewards, 'grantFor')
      .mockRejectedValueOnce(new Error('process died between the claim and the grant'));
    await expect(rewardTrigger.handle(event)).rejects.toThrow('process died');
    spy.mockRestore();
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();

    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    const rewards = await runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.findMany({ where: { sourceReference: payload.usageRecordId } }),
    );
    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((reward) => reward.userId === 'USR-CRASH')).toBe(true);

    // Any other event id for the same fact is refused.
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor())),
    ).resolves.toBe('SKIPPED');
  });
  // -------------------------------------------------------------------------
  // PR #110 round 2
  // -------------------------------------------------------------------------

  const ruleIn = (organizationId: string, points: number, validFrom?: Date) =>
    asActor({ organizationId, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.rewards.createRule({
        organizationId,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        points,
        status: 'ACTIVE',
        validFrom: (validFrom ?? new Date(Date.now() - 86_400_000)).toISOString(),
        // JUSTIFIED-ANY: as above — the DTO is a Zod inference.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

  const evaluationFor = (sourceReference: string) =>
    runUnscoped('the suite reads evaluations across tenants', () =>
      prisma.client.rewardSourceEvaluation.findMany({ where: { sourceReference } }),
    );

  const rewardsFor = (sourceReference: string) =>
    runUnscoped('the suite counts grants across tenants', () =>
      prisma.client.reward.findMany({ where: { sourceReference } }),
    );

  it('never resumes a backfilled evaluation, whatever event id arrives (round 2 #1)', async () => {
    // A fact paid before the evaluation table existed: the migration records
    // it with origin BACKFILL and no event id at all.
    const payload = usage({ organizationId: org.c });
    sources.recorded(payload, { recordedBy: 'USR-BACKFILLED' });
    await runUnscoped('the suite stands in for the migration backfill', () =>
      prisma.client.rewardSourceEvaluation.create({
        data: {
          organizationId: org.c,
          triggerEvent: 'USAGE_RECORDED',
          sourceReference: payload.usageRecordId,
          origin: 'BACKFILL',
          eventId: null,
          outcome: 'EVALUATED',
        },
      }),
    );
    // A rerun of the suite must exercise the path, not stop at processed_event.
    await runUnscoped('the suite resets its fixed event id', () =>
      prisma.client.processedEvent.deleteMany({ where: { eventId: 'BACKFILL' } }),
    );
    await ruleIn(org.c, 3);

    // The old sentinel is a valid envelope event id, and no longer means anything.
    for (const eventId of ['BACKFILL', ulid()]) {
      const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, {
        ...userActor(),
        eventId,
      });
      await expect(rewardTrigger.handle(event)).resolves.toBe('SKIPPED');
    }
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(0);
    expect(sources.calls.some((call) => call.id === payload.usageRecordId)).toBe(false);

    // And the database refuses a backfill row that names an event, or an
    // event row that names none.
    await expect(
      runUnscoped('the suite writes past the consumer to test the constraint', () =>
        prisma.client.rewardSourceEvaluation.create({
          data: {
            organizationId: org.c,
            triggerEvent: 'USAGE_RECORDED',
            sourceReference: `USG_${ulid()}`,
            origin: 'BACKFILL',
            eventId: 'BACKFILL',
            outcome: 'EVALUATED',
          },
        }),
      ),
    ).rejects.toThrow(/ck_reward_source_evaluation_event_id/);
    await expect(
      runUnscoped('the suite writes past the consumer to test the constraint', () =>
        prisma.client.rewardSourceEvaluation.create({
          data: {
            organizationId: org.c,
            triggerEvent: 'USAGE_RECORDED',
            sourceReference: `USG_${ulid()}`,
            origin: 'EVENT',
            eventId: null,
            outcome: 'EVALUATED',
          },
        }),
      ),
    ).rejects.toThrow(/ck_reward_source_evaluation_event_id/);
  });

  it('resumes after a crash with the rules the first evaluation saw, not a rule added since (round 2 #2)', async () => {
    const tenant = `${org.c}-CRASH`;
    const first = await ruleIn(tenant, 2);
    const payload = usage({ organizationId: tenant });
    sources.recorded(payload, { recordedBy: 'USR-CRASH-WINDOW' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    // The claim commits, then the process dies before any grant or
    // processed_event: the state a thrown grant leaves, as in the crash case
    // above.
    const spy = jest
      .spyOn(wiring.rewards, 'grantFor')
      .mockRejectedValueOnce(new Error('process died between the claim and the grant'));
    await expect(rewardTrigger.handle(event)).rejects.toThrow('process died');
    spy.mockRestore();

    const [claimed] = await evaluationFor(payload.usageRecordId);
    expect(claimed).toMatchObject({
      origin: 'EVENT',
      eventId: event.eventId,
      outcome: 'EVALUATED',
    });
    expect(claimed!.ruleIds).toEqual([first.id]);

    // During the crash window an administrator activates a backdated rule.
    await ruleIn(tenant, 50);

    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    const paid = await rewardsFor(payload.usageRecordId);
    expect(paid.map((reward) => reward.ruleId)).toEqual([first.id]);
    expect(paid[0]!.points).toBe(2);
  });

  it('refuses a never-evaluated fact from before the cutover (round 2 #3)', async () => {
    const payload = usage({ organizationId: org.c });
    // Recorded long before the migration ran: it may have been consumed with
    // no rule back then, and left nothing but an event id behind.
    sources.recorded(payload, {
      recordedBy: 'USR-HISTORY',
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    await ruleIn(org.c, 7, new Date('2019-01-01T00:00:00.000Z'));
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    const failure = await rewardTrigger.handle(event).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnprocessableEventError);
    expect((failure as UnprocessableEventError).reason).toBe(DLQ_REASONS.BACKFILL_REQUIRED);

    expect(await evaluationFor(payload.usageRecordId)).toHaveLength(0);
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(0);
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();
  });

  it('writes no evaluation row from an event the owner does not confirm, rule or none (round 2 #4)', async () => {
    const tenant = `${org.c}-NORULE`;

    // No rule in this tenant. An invented record: the owner is asked anyway,
    // refutes it, and nothing is recorded that could suppress a genuine event.
    const invented = usage({ organizationId: tenant });
    await expectRefused(
      rewardTrigger,
      envelope(CONSUMED_EVENTS.USAGE_RECORDED, invented, userActor('USR-FORGED-ACTOR')),
      'not_found',
    );
    expect(sources.calls.some((call) => call.id === invented.usageRecordId)).toBe(true);
    expect(await evaluationFor(invented.usageRecordId)).toHaveLength(0);

    // A real record, confirmed, with no rule: NO_RULE, and processed.
    const real = usage({ organizationId: tenant });
    sources.recorded(real, { recordedBy: 'USR-REAL' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, real, userActor());
    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    const [row] = await evaluationFor(real.usageRecordId);
    expect(row).toMatchObject({ origin: 'EVENT', eventId: event.eventId, outcome: 'NO_RULE' });
    expect(row!.ruleIds).toEqual([]);
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // PR #110 round 3
  // -------------------------------------------------------------------------

  const cutover = async () =>
    (
      await runUnscoped('the suite reads the platform-wide cutover', () =>
        prisma.client.rewardEvaluationCutover.findUniqueOrThrow({ where: { singleton: true } }),
      )
    ).cutoverAt;

  it("decides a concurrent delivery of the same event with the holder's rules, not its own (round 3 #3)", async () => {
    const tenant = `${org.c}-RACE`;
    const first = await ruleIn(tenant, 3);
    const payload = usage({ organizationId: tenant });
    sources.recorded(payload, { recordedBy: 'USR-RACE' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    // Two deliveries of one event, interleaved at the worst point. Delivery A
    // found no evaluation, looked up [first], and its claim commits while
    // delivery B is between its own lookup and its insert. Between the two
    // lookups an administrator activates a backdated rule, so B's lookup sees
    // both. B is the handle() below; A is what the stub writes just before
    // B's lookup returns.
    const lookup = wiring.rewards.applicableRuleIds.bind(wiring.rewards);
    const spy = jest
      .spyOn(wiring.rewards, 'applicableRuleIds')
      .mockImplementationOnce(async (...args) => {
        await runUnscoped("the suite stands in for delivery A's committed claim", () =>
          prisma.client.rewardSourceEvaluation.create({
            data: {
              organizationId: tenant,
              triggerEvent: 'USAGE_RECORDED',
              sourceReference: payload.usageRecordId,
              origin: 'EVENT',
              eventId: event.eventId,
              outcome: 'EVALUATED',
              ruleIds: [first.id],
            },
          }),
        );
        await ruleIn(tenant, 40);
        const seen = await lookup(...args);
        expect(seen).toHaveLength(2);
        return seen;
      });
    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    // B lost the insert to A and decided with A's snapshot: only `first`.
    const [held] = await evaluationFor(payload.usageRecordId);
    expect(held!.ruleIds).toEqual([first.id]);
    const paid = await rewardsFor(payload.usageRecordId);
    expect(paid.map((reward) => reward.ruleId)).toEqual([first.id]);
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).not.toBeNull();
  });

  it('never lets the cutover move backward or disappear, only forward (round 3 #2)', async () => {
    const current = await cutover();
    // Each attempt runs in a transaction that is rolled back even if the
    // trigger failed to refuse it, so a broken trigger fails this case
    // without taking the shared cutover from the rest of the suite.
    const rollback = new Error('the suite rolls the attempt back');
    const attempt = (change: (tx: Transaction) => Promise<unknown>) =>
      prisma.transaction(async (tx) => {
        await runUnscoped('the suite edits the cutover as an operator would', () => change(tx));
        throw rollback;
      });

    // Lowering it would reopen every tenant's history at once.
    await expect(
      attempt((tx) =>
        tx.rewardEvaluationCutover.update({
          where: { singleton: true },
          data: { cutoverAt: new Date(current.getTime() - 1) },
        }),
      ),
    ).rejects.toThrow(/may only move forward/);
    await expect(
      attempt((tx) => tx.rewardEvaluationCutover.delete({ where: { singleton: true } })),
    ).rejects.toThrow(/may only move forward/);
    await expect(
      // ISOLATION-ALLOW-UNBOUNDED: asserts TRUNCATE is refused, which only a
      // TRUNCATE can test; the transaction is rolled back whatever happens.
      attempt((tx) => tx.$executeRawUnsafe('TRUNCATE "reward_evaluation_cutover"')),
    ).rejects.toThrow(/may only move forward/);

    // Forward is allowed (it only refuses more), and rolled back here so the
    // rest of the suite keeps its cutover.
    await expect(
      attempt(async (tx) => {
        const moved = await tx.rewardEvaluationCutover.update({
          where: { singleton: true },
          data: { cutoverAt: new Date(current.getTime() + 60_000) },
        });
        expect(moved.cutoverAt.getTime()).toBe(current.getTime() + 60_000);
      }),
    ).rejects.toBe(rollback);
    expect(await cutover()).toEqual(current);
  });

  it('records a missing cutover once, as the development seed does, and never moves it', async () => {
    // The suite's beforeAll made the first call, on CI's empty database the one
    // that recorded it. A second call, as a second `pnpm db:seed` makes, finds
    // it and leaves it exactly as it is.
    const before = await cutover();
    const again = await runUnscoped('the suite runs the seed step again', () =>
      recordCutoverIfMissing(prisma.client, new Date()),
    );
    expect(again).toEqual({ cutoverAt: before, recorded: false });
    expect(await cutover()).toEqual(before);
  });

  it('evaluates nothing until the operator records the cutover (round 3 #1)', async () => {
    // The migration applied and the new binary started before the operator
    // recorded the cutover: a delivery is retried, never evaluated. The shared
    // row cannot be deleted (round 3 #2), so this consumer is shown the table
    // as the migration leaves it: empty.
    const beforeCutover = new Proxy(prisma.client, {
      get: (target, property, receiver) =>
        property === 'rewardEvaluationCutover'
          ? { findUnique: async () => null }
          : Reflect.get(target, property, receiver),
    });
    const undeployed = new RewardTriggerConsumer(
      noBroker,
      Object.assign(Object.create(prisma) as PrismaService, { client: beforeCutover }),
      wiring.rewards,
      sources,
    );
    const tenant = `${org.c}-FENCE`;
    await ruleIn(tenant, 5);
    const payload = usage({ organizationId: tenant });
    sources.recorded(payload, { recordedBy: 'USR-FENCE' });
    const event = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor());

    await expect(undeployed.handle(event)).rejects.toThrow(/reward_evaluation_cutover has no row/);
    expect(await evaluationFor(payload.usageRecordId)).toHaveLength(0);
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(0);
    expect(await processedBy(RewardTriggerConsumer.CONSUMER_NAME, event.eventId)).toBeNull();

    // Once it is recorded, the same delivery is evaluated normally.
    await expect(rewardTrigger.handle(event)).resolves.toBeUndefined();
    expect(await rewardsFor(payload.usageRecordId)).toHaveLength(1);
  });
});
