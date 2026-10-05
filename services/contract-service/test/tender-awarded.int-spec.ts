import { DLQ_REASONS } from '@rasta/contracts';
import { RastaError, UnprocessableEventError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  cleanup,
  newAward,
  newOrganizationId,
  tenderAwarded,
  wire,
  type AwardFixture,
  type Wiring,
} from './helpers';
import { TenderAwardedConsumer } from '../src/events/tender-awarded.consumer';
import { EventPublisher } from '../src/events/publisher';
import { ContractRepository } from '../src/contract/contract.repository';

/**
 * CON-003 PR 1 (ADR-068 § 3): the draft contract a `TENDER_AWARDED` calls for, against
 * PostgreSQL. The event carries no amount; the amount is read from the owner of the award,
 * and when that read cannot be made, or is refuted, there is no contract at all.
 */
describe('TENDER_AWARDED drafts a contract', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const employer = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const contractsOf = (organizationId: string) =>
    runUnscoped('the suite reads what the consumer wrote', () =>
      w.prisma.client.contract.findMany({ where: { organizationId } }),
    );
  const contractsOfTender = (tenderId: string) =>
    runUnscoped('the suite reads what the consumer wrote, whoever it wrote it for', () =>
      w.prisma.client.contract.findMany({ where: { tenderId } }),
    );
  const outboxOf = (organizationId: string) =>
    w.prisma.client.outboxMessage.findMany({ where: { organizationId } });

  /** The owner confirms the award as the event states it. */
  const served = (award: AwardFixture) => w.awards.serve(award);

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnprocessableEventError);
    return error as UnprocessableEventError;
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });

  beforeEach(() => {
    w.awards.asked.length = 0;
    w.awards.failWith = undefined;
    w.awards.onAsk = undefined;
  });

  it('drafts one DRAFT contract, its amount taken from the owner of the award', async () => {
    const o = employer();
    const award = newAward(o, { amountMinor: '7250000000' });
    served(award);

    const outcome = await w.consumer.handle(tenderAwarded(award));

    expect(outcome).toBeUndefined();
    const rows = await contractsOf(o);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      organizationId: o,
      tenderId: award.tenderId,
      projectId: award.projectId,
      winningBidId: award.winningBidId,
      contractorOrganizationId: award.winnerOrganizationId,
      amountMinor: 7_250_000_000n,
      status: 'DRAFT',
      version: 1,
      createdBy: 'service:contract-service',
    });
    expect(row?.id).toMatch(/^CTR_/);
    expect(w.awards.asked).toEqual([{ organizationId: o, tenderId: award.tenderId }]);
  });

  it('announces CONTRACT_DRAFTED in the same transaction, with no amount on it', async () => {
    const o = employer();
    const award = newAward(o);
    served(award);
    const event = tenderAwarded(award);

    await w.consumer.handle(event);

    const [row] = await contractsOf(o);
    const messages = await outboxOf(o);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toMatchObject({
      eventName: 'CONTRACT_DRAFTED',
      topic: 'rasta.contract.v1',
      partitionKey: row?.id,
      aggregateId: row?.id,
      organizationId: o,
    });
    // The outbox row holds the whole envelope (the relay publishes it as it is).
    const envelope = message?.payload as {
      payload: unknown;
      causationId?: string;
      producer: string;
      tenantId: string;
    };
    expect(envelope).toMatchObject({
      producer: 'contract-service',
      tenantId: o,
      causationId: event.eventId,
    });
    expect(envelope.payload).toEqual({
      contractId: row?.id,
      tenderId: award.tenderId,
      projectId: award.projectId,
      organizationId: o,
      contractorOrganizationId: award.winnerOrganizationId,
      winningBidId: award.winningBidId,
      draftedAt: row?.createdAt.toISOString(),
    });
    expect(
      JSON.stringify(message, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(award.amountMinor);
  });

  describe('is idempotent on the tender', () => {
    it('skips a redelivery without asking the owner again or writing again', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);

      await w.consumer.handle(tenderAwarded(award));
      const again = await w.consumer.handle(tenderAwarded(award));

      expect(again).toBe('SKIPPED');
      expect(await contractsOf(o)).toHaveLength(1);
      expect(await outboxOf(o)).toHaveLength(1);
      expect(w.awards.asked).toHaveLength(1);
    });

    it('skips the very same event delivered twice', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);
      const event = tenderAwarded(award);

      await w.consumer.handle(event);
      expect(await w.consumer.handle(event)).toBe('SKIPPED');
      expect(await contractsOf(o)).toHaveLength(1);
    });

    it('refuses a conflicting redelivery (another winner) and changes nothing', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);
      await w.consumer.handle(tenderAwarded(award));
      const [before] = await contractsOf(o);

      const rival = { ...award, winningBidId: `BID_${ulid()}`, winnerOrganizationId: employer() };
      const error = await refusal(w.consumer.handle(tenderAwarded(rival)));

      expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(error.message).toContain(before!.id);
      const after = await contractsOf(o);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(before);
      expect(await outboxOf(o)).toHaveLength(1);
    });

    // Every persisted award claim: a redelivery that contradicts any one is refused, nothing written.
    const CONTRADICTIONS: [string, Partial<AwardFixture>][] = [
      ['projectId', { projectId: `PRJ_${ulid()}` }],
      ['winningBidId', { winningBidId: `BID_${ulid()}` }],
      ['winnerOrganizationId', { winnerOrganizationId: `ORG_${ulid()}` }],
      ['matrixDigest', { matrixDigest: 'c'.repeat(64) }],
      ['awardedBy', { awardedBy: `USR_${ulid()}` }],
      ['awardedAt', { awardedAt: '2026-10-04T09:30:00.000Z' }],
    ];

    it.each(CONTRADICTIONS)(
      'refuses a redelivery that differs only in %s, before the owner is asked',
      async (field, change) => {
        const o = employer();
        const award = newAward(o);
        served(award);
        await w.consumer.handle(tenderAwarded(award));
        const [before] = await contractsOf(o);

        const error = await refusal(w.consumer.handle(tenderAwarded({ ...award, ...change })));

        expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
        expect(error.message).toContain(before!.id);
        expect(error.message).toContain(field);
        expect(w.awards.asked).toHaveLength(1);
        expect(await contractsOf(o)).toEqual([before]);
        expect(await outboxOf(o)).toHaveLength(1);
      },
    );

    it.each(CONTRADICTIONS)(
      'refuses the delivery that loses the race when it differs in %s: the in-transaction re-read judges it too',
      async (field, change) => {
        const o = employer();
        const award = newAward(o);
        const loser = { ...award, ...change };
        // The loser passed the probe (no contract yet) and its owner confirms ITS award; while
        // it waits for the owner, the first delivery commits.
        w.awards.onAsk = async () => {
          w.awards.onAsk = undefined;
          served(award);
          await w.consumer.handle(tenderAwarded(award));
          served(loser);
        };

        const error = await refusal(w.consumer.handle(tenderAwarded(loser)));

        expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
        expect(error.message).toContain(field);
        const rows = await contractsOf(o);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          matrixDigest: award.matrixDigest,
          projectId: award.projectId,
        });
        expect(await outboxOf(o)).toHaveLength(1);
      },
    );

    // The window the in-transaction re-read cannot close: the loser's re-read sees nothing and
    // its insert meets the winner at the unique index. The re-read is blinded to make the window
    // deterministic; the verdict must still come from the same comparison as every redelivery.
    it.each(CONTRADICTIONS)(
      'refuses the delivery that meets the unique index when it differs in %s',
      async (field, change) => {
        const o = employer();
        const award = newAward(o);
        const loser = { ...award, ...change };
        const reread = jest.spyOn(w.contracts, 'findByTender');
        w.awards.onAsk = async () => {
          w.awards.onAsk = undefined;
          served(award);
          await w.consumer.handle(tenderAwarded(award));
          served(loser);
          // The loser's next read is its in-transaction re-read: blind. The one after the
          // unique violation (the winner it is judged against) is the real one.
          reread.mockImplementationOnce(async () => null);
        };

        try {
          const error = await refusal(w.consumer.handle(tenderAwarded(loser)));

          expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
          expect(error.message).toContain(field);
        } finally {
          reread.mockRestore();
        }
        const rows = await contractsOf(o);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          matrixDigest: award.matrixDigest,
          projectId: award.projectId,
        });
        expect(await outboxOf(o)).toHaveLength(1);
      },
    );

    it('makes one contract when five deliveries race: the unique index decides', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => w.consumer.handle(tenderAwarded(award))),
      );

      expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'SKIPPED')).toHaveLength(4);
      expect(await contractsOf(o)).toHaveLength(1);
      expect(await outboxOf(o)).toHaveLength(1);
    });
  });

  describe('never makes a contract from an award it could not confirm', () => {
    it.each([
      ['unreachable', RastaError.upstreamUnavailable('construction-service')],
      ['too slow', RastaError.upstreamTimeout('construction-service', 5000)],
    ])('owner %s: the error surfaces for a retry, and nothing is written', async (_label, e) => {
      const o = employer();
      const award = newAward(o);
      served(award);
      w.awards.failWith = e;

      await expect(w.consumer.handle(tenderAwarded(award))).rejects.toBe(e);

      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });

    it('recovers when the owner comes back: the redelivery drafts the contract', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);
      const event = tenderAwarded(award);
      w.awards.failWith = RastaError.upstreamUnavailable('construction-service');
      await expect(w.consumer.handle(event)).rejects.toBeInstanceOf(RastaError);

      w.awards.failWith = undefined;
      expect(await w.consumer.handle(event)).toBeUndefined();
      expect(await contractsOf(o)).toHaveLength(1);
    });

    it('owner has no such award: SOURCE_UNCONFIRMED, nothing written', async () => {
      const o = employer();
      const award = newAward(o); // never served

      const error = await refusal(w.consumer.handle(tenderAwarded(award)));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });

    it('the event names another project than the owner records: SOURCE_UNCONFIRMED, nothing written', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);

      const error = await refusal(
        w.consumer.handle(tenderAwarded({ ...award, projectId: `PRJ_${ulid()}` })),
      );

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(error.message).toContain('project_mismatch');
      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });

    it('an owner answer without a projectId is not a confirmation: no contract (the real client treats it as unreadable and retries)', async () => {
      const o = employer();
      const award = newAward(o);
      w.awards.serve(award, { projectId: undefined as unknown as string });

      await refusal(w.consumer.handle(tenderAwarded(award)));

      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });

    it('keeps the owner’s project on the contract', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);
      await w.consumer.handle(tenderAwarded(award));
      expect((await contractsOf(o))[0]!.projectId).toBe(award.projectId);
    });

    it.each([
      ['another winning bid', { bidId: `BID_${ulid()}` }],
      ['another winning contractor', { bidderOrganizationId: `ORG_${ulid()}` }],
      ['another evaluation matrix', { matrixDigest: 'b'.repeat(64) }],
      ['another awarding person', { awardedBy: `USR_${ulid()}` }],
      ['another award time', { awardedAt: '2026-10-04T09:30:00.000Z' }],
      ['a tender that is not AWARDED', { status: 'EVALUATED' }],
      ['a zero amount', { amountMinor: '0' }],
      ['an amount beyond bigint', { amountMinor: '9223372036854775808' }],
    ])('owner states %s: SOURCE_UNCONFIRMED, nothing written', async (_label, change) => {
      const o = employer();
      const award = newAward(o);
      w.awards.serve(award, change);

      const error = await refusal(w.consumer.handle(tenderAwarded(award)));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });

    it('owner names the employer as the winner: no contract with oneself', async () => {
      const o = employer();
      const award = newAward(o, { winnerOrganizationId: o });
      served(award);

      const error = await refusal(w.consumer.handle(tenderAwarded(award)));
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(await contractsOf(o)).toHaveLength(0);
    });

    it('writes neither the contract nor the event when the outbox write fails', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);
      const broken = new EventPublisher(w.env);
      jest.spyOn(broken, 'enqueue').mockRejectedValueOnce(new Error('outbox unavailable'));
      const consumer = new TenderAwardedConsumer(
        () => {
          throw new Error('nothing subscribes');
        },
        w.prisma,
        new ContractRepository(w.prisma),
        broken,
        w.awards,
        { info: () => undefined, warn: () => undefined, debug: () => undefined },
      );

      await expect(consumer.handle(tenderAwarded(award))).rejects.toThrow('outbox unavailable');

      expect(await contractsOf(o)).toHaveLength(0);
      expect(await outboxOf(o)).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('refuses an envelope whose tenant is not the payload’s, before asking the owner', async () => {
      const o = employer();
      const other = employer();
      const award = newAward(o);
      served(award);

      const error = await refusal(w.consumer.handle(tenderAwarded(award, { tenantId: other })));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(w.awards.asked).toHaveLength(0);
      expect(await contractsOfTender(award.tenderId)).toHaveLength(0);
      expect(await contractsOf(other)).toHaveLength(0);
    });

    it('refuses an envelope with no tenant at all', async () => {
      const o = employer();
      const award = newAward(o);
      served(award);

      const error = await refusal(w.consumer.handle(tenderAwarded(award, { tenantId: undefined })));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(w.awards.asked).toHaveLength(0);
      expect(await contractsOfTender(award.tenderId)).toHaveLength(0);
    });

    it('asks the owner inside the event’s organization only: another organization’s award is not found', async () => {
      const a = employer();
      const b = employer();
      const awardOfB = newAward(b);
      served(awardOfB);
      // The event claims A for B's tender: the owner, asked within A, has nothing.
      const forged = { ...awardOfB, organizationId: a };

      const error = await refusal(w.consumer.handle(tenderAwarded(forged)));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(w.awards.asked).toEqual([{ organizationId: a, tenderId: awardOfB.tenderId }]);
      expect(await contractsOf(a)).toHaveLength(0);
      expect(await contractsOf(b)).toHaveLength(0);
    });

    it('writes the draft in the employer’s organization and in no other', async () => {
      const a = employer();
      const b = employer();
      const awardA = newAward(a);
      const awardB = newAward(b);
      served(awardA);
      served(awardB);

      await w.consumer.handle(tenderAwarded(awardA));
      await w.consumer.handle(tenderAwarded(awardB));

      expect((await contractsOf(a)).map((row) => row.tenderId)).toEqual([awardA.tenderId]);
      expect((await contractsOf(b)).map((row) => row.tenderId)).toEqual([awardB.tenderId]);
      expect((await outboxOf(a)).map((row) => row.organizationId)).toEqual([a]);
      expect((await outboxOf(b)).map((row) => row.organizationId)).toEqual([b]);
    });

    it('does not mistake another organization’s contract for a redelivery', async () => {
      const a = employer();
      const b = employer();
      const awardA = newAward(a);
      served(awardA);
      await w.consumer.handle(tenderAwarded(awardA));

      // A tender id is global; an event that names it for B must be judged within B.
      const forged = { ...awardA, organizationId: b };
      const error = await refusal(w.consumer.handle(tenderAwarded(forged)));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(await contractsOf(b)).toHaveLength(0);
      expect(await contractsOf(a)).toHaveLength(1);
    });
  });

  describe('what it ignores or refuses at the door', () => {
    it('skips an event that is not TENDER_AWARDED', async () => {
      const o = employer();
      const award = newAward(o);
      const other = { ...tenderAwarded(award), eventName: 'TENDER_CANCELLED' };

      expect(await w.consumer.handle(other)).toBe('SKIPPED');
      expect(w.awards.asked).toHaveLength(0);
    });

    it('refuses a payload that fails its schema as VALIDATION_FAILED', async () => {
      const o = employer();
      const award = newAward(o);
      const event = tenderAwarded(award);
      const broken = { ...event, payload: { ...(event.payload as object), tenderId: undefined } };

      const error = await refusal(w.consumer.handle(broken));

      expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(w.awards.asked).toHaveLength(0);
    });
  });
});
