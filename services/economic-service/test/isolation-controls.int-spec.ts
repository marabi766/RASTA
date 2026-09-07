import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, fundWallet, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Negative controls for the economic integration suite itself.
 *
 * Every other file here asserts something about the service. This one asserts
 * something about the *harness*: that a run mutates only what it created, and
 * that it puts the database's integrity controls back.
 *
 * It exists because the failures it catches are silent and are attributed to
 * the wrong code. A suite that publishes another run's outbox rows produces a
 * "the event never arrived on the topic" timeout in a different file. A suite
 * that deletes another run's journals produces an unbalanced-ledger assertion
 * in a different service. A suite that leaves `trg_ledger_entry_immutable`
 * disabled produces a green `ledger-immutability.int-spec.ts` proving the
 * ledger cannot be rewritten, in a database where it can. In each case the
 * suite that reports the failure is not the suite that caused it, and nothing
 * points from one to the other.
 *
 * A control is only evidence if it can fail, so the positive control at the
 * bottom is not optional: cleanup that deleted nothing at all would satisfy
 * every "foreign rows survived" assertion in this file perfectly.
 */
describe('the economic suite mutates only what it owns', () => {
  let prisma: PrismaService;
  let wiring: Wiring;

  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** A tenant no `cleanup` call in this file is ever given. */
  const foreignTenant = () => `ORG-FOREIGN-CONTROL-${ulid().slice(-10)}`;

  /**
   * One row in each table the old cleanup reached past its own tenants into.
   *
   * Deliberately not a synthetic minimum: the rules carry a `created_by` of
   * `USR-ITEST-…`, which is the exact string the two dropped disjuncts matched
   * on, and the journal is written with no entries, which is the exact shape
   * the two unbounded `DELETE FROM journal` statements removed.
   */
  async function seedTenant(organizationId: string) {
    // A wallet, its two ledger accounts, a balanced journal and its entries —
    // through the real posting path, so the rows have the shape production
    // writes rather than one this file invented.
    const { walletId } = await fundWallet(wiring, organizationId, 25_000n);

    const emptyJournalId = `JRN_CONTROL_${ulid()}`;
    await runUnscoped('the control seeds an entry-less journal on purpose', () =>
      prisma.client.$executeRawUnsafe(
        `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id, created_at)
         VALUES ($1, $2, 'FUNDS_HELD', 'isolation control', now(), 'itest', 'itest', now())`,
        emptyJournalId,
        organizationId,
      ),
    );

    const author = `USR-ITEST-CONTROL-${ulid().slice(-8)}`;
    const commissionRule = await asActor({ organizationId, userId: author }, () =>
      wiring.commissions.createRule({
        organizationId,
        transactionType: 'LOGISTICS',
        rateBasisPoints: 150,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
    const rewardRule = await asActor({ organizationId, userId: author }, () =>
      wiring.rewards.createRule({
        organizationId,
        triggerEvent: 'USAGE_RECORDED',
        points: 3,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

    const outboxId = `OBX_${ulid()}`;
    await runUnscoped('the control seeds an unpublished outbox row', () =>
      prisma.client.outboxMessage.create({
        data: {
          id: outboxId,
          aggregateType: 'Wallet',
          aggregateId: walletId,
          eventName: 'WALLET_OPENED',
          eventVersion: 1,
          topic: 'rasta.economic.v1',
          partitionKey: walletId,
          payload: { walletId },
          headers: {},
          organizationId,
          correlationId: `control-${outboxId}`,
        },
      }),
    );

    return {
      organizationId,
      walletId,
      emptyJournalId,
      commissionRuleId: commissionRule.id,
      rewardRuleId: rewardRule.id,
      outboxId,
      author,
    };
  }

  /** What of a seeded tenant is still in the database. */
  async function census(organizationId: string, seeded: { emptyJournalId: string }) {
    return runUnscoped('the control counts the rows it seeded', async () => {
      const client = prisma.client;
      return {
        wallets: await client.wallet.count({ where: { organizationId } }),
        accounts: await client.ledgerAccount.count({ where: { organizationId } }),
        journals: await client.journal.count({ where: { organizationId } }),
        entryLessJournal: await client.journal.count({ where: { id: seeded.emptyJournalId } }),
        entries: await client.ledgerEntry.count({ where: { organizationId } }),
        commissionRules: await client.commissionRule.count({ where: { organizationId } }),
        rewardRules: await client.rewardRule.count({ where: { organizationId } }),
      };
    });
  }

  /**
   * The state of the three immutability triggers and the wallet CHECK.
   *
   * `tgenabled = 'O'` is "fires in origin sessions", which is how the
   * migration installs all three; `'D'` is disabled. `convalidated` is false
   * for a constraint added `NOT VALID` — enforced for new rows, never checked
   * against existing ones, which is the state a half-restored constraint
   * leaves behind and the state a reconciliation assertion in a later suite
   * would then trip over.
   */
  async function integrityControls() {
    return runUnscoped('the control reads the catalogue', async () => {
      const triggers = await prisma.client.$queryRawUnsafe<{ tgname: string; tgenabled: string }[]>(
        `SELECT tgname, tgenabled::text AS tgenabled
           FROM pg_trigger
          WHERE tgname IN ('trg_ledger_entry_immutable', 'trg_journal_immutable', 'trg_journal_balanced')
          ORDER BY tgname`,
      );
      const constraints = await prisma.client.$queryRawUnsafe<
        { conname: string; convalidated: boolean }[]
      >(
        `SELECT conname, convalidated
           FROM pg_constraint
          WHERE conname = 'ck_wallet_balances'`,
      );
      return { triggers, constraints };
    });
  }

  it('removes the rows it is given and leaves another organization’s alone', async () => {
    // Both directions in one case, on purpose.
    //
    // A cleanup that deleted nothing at all would satisfy every "the foreign
    // rows survived" assertion perfectly, so the positive half is not optional.
    // And the negative half is only evidence if the destructive path actually
    // ran: `cleanup` resolves the journals it owns first and skips the whole
    // trigger-disabled transaction when there are none, so a foreign journal
    // seeded against an empty suite would survive a delete that never
    // executed. Seeding both tenants is what makes the two halves the same
    // run of the same code.
    const foreign = foreignTenant();
    const mine = `${org.a}-CONTROL`;

    const theirs = await seedTenant(foreign);
    const ours = await seedTenant(mine);

    try {
      const before = await census(foreign, theirs);
      expect(before.wallets).toBe(1);
      expect(before.entryLessJournal).toBe(1);
      expect(before.commissionRules).toBe(1);
      expect(before.rewardRules).toBe(1);
      expect(before.entries).toBeGreaterThan(0);
      expect((await census(mine, ours)).wallets).toBe(1);

      // The suite's own tenants, and only those — exactly what every
      // `afterAll` in this directory passes. The foreign tenant is never
      // named, and shares no prefix with any of them.
      await cleanup(prisma, [org.a, org.b, org.c]);

      // Positive: what it was given is gone, so the scoping did not turn the
      // function off.
      const ourAfter = await census(mine, ours);
      expect(ourAfter).toEqual({
        wallets: 0,
        accounts: 0,
        journals: 0,
        entryLessJournal: 0,
        entries: 0,
        commissionRules: 0,
        rewardRules: 0,
      });

      // Negative: what it was not given is untouched, down to the counts.
      const after = await census(foreign, theirs);
      expect(after).toEqual(before);

      // The row the outbox publish used to reach: still there, and still
      // unpublished. A published row is one the relay can never claim again,
      // so this assertion is about an event that would otherwise be lost
      // rather than merely a row that would be changed.
      const outbox = await runUnscoped('the control reads its outbox row', () =>
        prisma.client.outboxMessage.findUnique({ where: { id: theirs.outboxId } }),
      );
      expect(outbox).not.toBeNull();
      expect(outbox?.publishedAt).toBeNull();

      // And the governance rules, which the two `created_by` disjuncts used to
      // delete across every tenant. The author here matches `USR-ITEST-%`
      // exactly, so this fails if either disjunct comes back.
      const rules = await runUnscoped('the control reads its rules by author', () =>
        prisma.client.commissionRule.count({ where: { createdBy: theirs.author } }),
      );
      expect(rules).toBe(1);
    } finally {
      await cleanup(prisma, [foreign]);
    }
  });

  it('leaves the ledger integrity controls installed and valid', async () => {
    // Asserted before and after, because the two failures are different: a
    // disabled trigger found *before* cleanup is one an earlier run leaked,
    // and one found after is one this run leaked.
    const before = await integrityControls();
    expect(before.triggers).toHaveLength(3);
    for (const trigger of before.triggers) expect(trigger.tgenabled).toBe('O');
    expect(before.constraints).toHaveLength(1);
    expect(before.constraints[0]?.convalidated).toBe(true);

    // Seeded so the cleanup below has journals to delete. Without them it
    // takes the early exit and never opens the transaction that disables the
    // triggers — and a control that asserts the triggers survive a statement
    // that did not run has proved nothing.
    const mine = `${org.b}-CONTROL`;
    await seedTenant(mine);

    await cleanup(prisma, [mine]);

    const after = await integrityControls();
    expect(after).toEqual(before);
  });
});
