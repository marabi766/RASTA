import { ulid } from 'ulid';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { runUnscoped, UnprocessableEventError, type EventConsumer } from '@rasta/nest-common';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { RewardTriggerConsumer } from '../src/consumers/reward-trigger.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
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

    await expect(
      settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload)),
    ).resolves.toBe('SKIPPED');

    // Skipped rather than dead-lettered: an in-house repair with no external
    // workshop is a valid thing for maintenance-service to publish, and a
    // dead-letter would make an ordinary event look like a defect and need a
    // human to clear it.
    expect(await findBySource(payload.requestId)).toBeNull();
  });

  it('skips an approval that cost nothing', async () => {
    const payload = approval({ totalCostMinor: '0' });

    await expect(
      settlementAuthority.handle(envelope(CONSUMED_EVENTS.MAINTENANCE_APPROVED, payload)),
    ).resolves.toBe('SKIPPED');
    expect(await findBySource(payload.requestId)).toBeNull();
  });

  it('skips an in-house repair, where payer and payee are one organization', async () => {
    const payload = approval({ workshopOrganizationId: org.a });

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

  const processedBy = (consumerName: string, eventId: string) =>
    runUnscoped('the suite reads the processed-event ledger', () =>
      prisma.client.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName } },
      }),
    );

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

  it('asks no owner when no rule could pay', async () => {
    // No rule exists yet. Nothing can be granted whatever the record says, so
    // the busiest event on the platform costs no round trip.
    const payload = usage();
    await expect(
      rewardTrigger.handle(envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor())),
    ).resolves.toBeUndefined();
    expect(sources.calls.some((call) => call.id === payload.usageRecordId)).toBe(false);
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

  it('records the event as processed even when the reward rule throws', async () => {
    // A reward is not why `rasta.fleet.v1` exists. A misconfigured rule must
    // not stall a partition that fleet-service's other consumers depend on, so
    // the failure is logged, counted and moved past.
    const payload = usage();
    sources.recorded(payload, { recordedBy: 'USR-THROWS' });
    const failing = envelope(CONSUMED_EVENTS.USAGE_RECORDED, payload, userActor('USR-THROWS'));

    const spy = jest
      .spyOn(wiring.rewards, 'grantFor')
      .mockRejectedValueOnce(new Error('a rule blew up'));

    // The handler resolves rather than rejecting: the event is consumed.
    await expect(rewardTrigger.handle(failing)).resolves.toBeUndefined();
    spy.mockRestore();

    const processed = await runUnscoped('the suite reads the processed-event ledger', () =>
      prisma.client.processedEvent.findUnique({
        where: {
          eventId_consumerName: {
            eventId: failing.eventId,
            consumerName: RewardTriggerConsumer.CONSUMER_NAME,
          },
        },
      }),
    );
    expect(processed).not.toBeNull();
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
});
