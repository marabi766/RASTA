import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Ledger immutability and journal balance — enforced by PostgreSQL, proven
 * against PostgreSQL.
 *
 * These are the two invariants docs/10 § 10.12 lists first, and ADR-013 makes
 * merge gates:
 *
 *   > UPDATE و DELETE روی `ledger_entry` خطا می‌دهند
 *   > هر Journal: Σ debit = Σ credit بر حسب هر ارز
 *
 * The unit tests in `src/ledger/journal.spec.ts` cover the domain's own check.
 * **This suite covers what happens when the domain is bypassed entirely** —
 * which is the whole reason docs/05 § 5.4 puts the rule in a trigger rather
 * than in code: a correction script, a careless ORM call or a psql session can
 * all skip the service layer, and none of them can skip the database.
 *
 * Everything here writes raw SQL for that reason. A test that went through the
 * repository would be testing the repository.
 */
describe('ledger immutability (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);

    // Two real accounts to post against, created through the controlled path.
    await asActor({ organizationId: org.a }, async () => {
      await prisma.transaction(async (tx) => {
        const wallet = await wiring.ledger.resolveAccount(tx, 'WALLET', org.a, 'IRR', 'itest');
        const escrow = await wiring.ledger.resolveAccount(tx, 'ESCROW', org.a, 'IRR', 'itest');
        accountA = wallet.id;
        accountB = escrow.id;
      });
    });
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** Posts a balanced journal through raw SQL and returns its id. */
  async function postRawJournal(
    amountMinor: bigint,
  ): Promise<{ journalId: string; entryId: string }> {
    const journalId = `JRN_RAW_${Date.now()}_${Math.trunc(performance.now() * 1000)}`;
    const entryId = `${journalId}_E1`;

    await runUnscoped('the immutability suite writes raw rows on purpose', async () => {
      await prisma.client.$executeRawUnsafe(
        `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id, created_at)
         VALUES ($1, $2, 'FUNDS_HELD', 'raw', now(), 'itest', 'itest', now())`,
        journalId,
        org.a,
      );
      await prisma.client.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         VALUES ($1, $2, $3, $4, 'DEBIT', $5, 'IRR', now()),
                ($6, $2, $7, $4, 'CREDIT', $5, 'IRR', now())`,
        entryId,
        journalId,
        accountA,
        org.a,
        amountMinor,
        `${entryId}_2`,
        accountB,
      );
    });

    return { journalId, entryId };
  }

  describe('a posted entry cannot be changed', () => {
    it('refuses an UPDATE, even from raw SQL', async () => {
      const { entryId } = await postRawJournal(1_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(
            `UPDATE ledger_entry SET amount_minor = 1 WHERE id = $1`,
            entryId,
          ),
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses a DELETE, even from raw SQL', async () => {
      const { entryId } = await postRawJournal(2_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(`DELETE FROM ledger_entry WHERE id = $1`, entryId),
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses a mass UPDATE across the whole table', async () => {
      // The shape a "quick fix" actually takes. It fails on the first row.
      await postRawJournal(3_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(`UPDATE ledger_entry SET currency = 'USD'`),
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('names the correction that is allowed', async () => {
      // The message is the documentation an operator reads at the moment they
      // need it.
      const { entryId } = await postRawJournal(4_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(`DELETE FROM ledger_entry WHERE id = $1`, entryId),
        ),
      ).rejects.toThrow(/reversal journal/i);
    });
  });

  describe('a posted journal header cannot be changed either', () => {
    // Not mandated by docs/05 § 5.4, which covers only `ledger_entry`. A
    // mutable header over immutable lines is a gap: rewriting a description or
    // a posted_at changes what the entries mean without touching them.
    it('refuses an UPDATE', async () => {
      const { journalId } = await postRawJournal(5_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(
            `UPDATE journal SET description = 'tampered' WHERE id = $1`,
            journalId,
          ),
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses a DELETE', async () => {
      const { journalId } = await postRawJournal(6_000n);

      await expect(
        runUnscoped('the immutability suite attempts a forbidden write', () =>
          prisma.client.$executeRawUnsafe(`DELETE FROM journal WHERE id = $1`, journalId),
        ),
      ).rejects.toThrow(/append-only/i);
    });
  });

  describe('the database refuses an unbalanced journal at COMMIT', () => {
    it('refuses a single-legged journal', async () => {
      // Deferred to COMMIT, so this fails on the transaction rather than on
      // the INSERT — which is exactly what lets a three-legged journal be
      // written one row at a time.
      await expect(
        runUnscoped('the balance suite writes raw rows on purpose', () =>
          prisma.client.$transaction(async (tx) => {
            const journalId = `JRN_UNBAL_1_${Date.now()}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id, created_at)
               VALUES ($1, $2, 'FUNDS_HELD', 'one leg', now(), 'itest', 'itest', now())`,
              journalId,
              org.a,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
               VALUES ($1, $2, $3, $4, 'DEBIT', 100, 'IRR', now())`,
              `${journalId}_E1`,
              journalId,
              accountA,
              org.a,
            );
          }),
        ),
      ).rejects.toThrow(/needs at least two/i);
    });

    it('refuses a journal that is out by one minor unit', async () => {
      // One rial. The amount that makes a rounding defect invisible in review
      // and unreconcilable in production.
      await expect(
        runUnscoped('the balance suite writes raw rows on purpose', () =>
          prisma.client.$transaction(async (tx) => {
            const journalId = `JRN_UNBAL_2_${Date.now()}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id, created_at)
               VALUES ($1, $2, 'FUNDS_HELD', 'off by one', now(), 'itest', 'itest', now())`,
              journalId,
              org.a,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
               VALUES ($1, $2, $3, $4, 'DEBIT', 1000, 'IRR', now()),
                      ($5, $2, $6, $4, 'CREDIT', 999, 'IRR', now())`,
              `${journalId}_E1`,
              journalId,
              accountA,
              org.a,
              `${journalId}_E2`,
              accountB,
            );
          }),
        ),
      ).rejects.toThrow(/does not balance/i);
    });

    it('accepts a balanced journal written one row at a time', async () => {
      // The property the deferral buys: three legs, three statements, checked
      // once at the end.
      await expect(postRawJournal(7_000n)).resolves.toBeDefined();
    });
  });

  describe('the amount and currency constraints', () => {
    it('refuses a zero-amount entry', async () => {
      await expect(
        runUnscoped('the constraint suite writes raw rows on purpose', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
             VALUES ('LGE_ZERO', 'JRN_NONE', $1, $2, 'DEBIT', 0, 'IRR', now())`,
            accountA,
            org.a,
          ),
        ),
      ).rejects.toThrow();
    });

    it('refuses an entry whose currency differs from its account', async () => {
      // A rial entry on a foreign-currency account would make the balance
      // meaningless, and the composite foreign key is what makes it
      // impossible rather than merely unlikely.
      const { journalId } = await postRawJournal(8_000n);

      await expect(
        runUnscoped('the constraint suite writes raw rows on purpose', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
             VALUES ('LGE_USD', $1, $2, $3, 'DEBIT', 100, 'USD', now())`,
            journalId,
            accountA,
            org.a,
          ),
        ),
      ).rejects.toThrow(/fk_ledger_entry_account_identity|foreign key/i);
    });

    it('refuses an entry filed under the wrong organization', async () => {
      // The silent leak this prevents: an entry with the wrong tenant would
      // appear in another organization's statement, which reads
      // `ledger_entry.organization_id`.
      const { journalId } = await postRawJournal(9_000n);

      await expect(
        runUnscoped('the constraint suite writes raw rows on purpose', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
             VALUES ('LGE_WRONGORG', $1, $2, $3, 'DEBIT', 100, 'IRR', now())`,
            journalId,
            accountA,
            org.b,
          ),
        ),
      ).rejects.toThrow(/fk_ledger_entry_account_identity|foreign key/i);
    });
  });

  describe('a journal may be reversed at most once', () => {
    it('refuses a second reversal, by unique constraint', async () => {
      // Two concurrent reversal requests both pass an application "has this
      // been reversed?" check. The unique index on `reverses_id` is what makes
      // exactly one of them succeed.
      const { journalId } = await postRawJournal(10_000n);

      const insertReversal = (suffix: string) =>
        runUnscoped('the reversal suite writes raw rows on purpose', () =>
          prisma.client.$transaction(async (tx) => {
            const reversalId = `JRN_REV_${suffix}_${Date.now()}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, reverses_id, reversal_reason, correlation_id, created_at)
               VALUES ($1, $2, 'REVERSAL', 'rev', now(), 'itest', $3, 'itest reversal', 'itest', now())`,
              reversalId,
              org.a,
              journalId,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
               VALUES ($1, $2, $3, $4, 'CREDIT', 10000, 'IRR', now()),
                      ($5, $2, $6, $4, 'DEBIT', 10000, 'IRR', now())`,
              `${reversalId}_E1`,
              reversalId,
              accountA,
              org.a,
              `${reversalId}_E2`,
              accountB,
            );
          }),
        );

      // The first succeeds; the second hits `journal_reverses_id_key`.
      await expect(insertReversal('one')).resolves.toBeUndefined();
      await expect(insertReversal('two')).rejects.toThrow();
    });

    it('refuses a REVERSAL that names nothing to reverse', async () => {
      // A REVERSAL with no target would be an ordinary journal wearing the
      // wrong label, which makes "has this been reversed" unanswerable.
      await expect(
        runUnscoped('the reversal suite writes raw rows on purpose', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id, created_at)
             VALUES ('JRN_BAD_REV', $1, 'REVERSAL', 'no target', now(), 'itest', 'itest', now())`,
            org.a,
          ),
        ),
      ).rejects.toThrow(/ck_journal_reversal_shape|check constraint/i);
    });

    it('refuses a journal that claims to reverse itself', async () => {
      await expect(
        runUnscoped('the reversal suite writes raw rows on purpose', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, reverses_id, reversal_reason, correlation_id, created_at)
             VALUES ('JRN_SELF', $1, 'REVERSAL', 'self', now(), 'itest', 'JRN_SELF', 'why', 'itest', now())`,
            org.a,
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
