import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import { WALLET_ACCOUNT_COVERED_REFUSAL } from '../src/wallet/balances';
import {
  asActor,
  cleanup,
  databaseUrl,
  fundWallet,
  newPrisma,
  ownerDatabaseUrl,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * Lock, then read: only under READ COMMITTED, and wallet and escrow accounts locked in id order
 * and summed once per account at commit (FU-268, migration 20261109120000_guards_read_committed).
 * Everything is written by hand as the runtime role, around the service.
 */
jest.setTimeout(120_000);

type Raw = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;
type Level = 'RepeatableRead' | 'Serializable';

const REFUSED = new RegExp(WALLET_ACCOUNT_COVERED_REFUSAL);
const LEVELS: Level[] = ['RepeatableRead', 'Serializable'];

describe('lock-then-read guards hold under every isolation level (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let owner: PrismaClient;
  let runtime: PrismaClient;
  /** The other side of a race. */
  let other: PrismaClient;
  const org = tenants();
  let n = 0;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    other = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await prisma.onModuleDestroy();
    await Promise.all([owner.$disconnect(), runtime.$disconnect(), other.$disconnect()]);
  });

  /** A wallet of its own, funded through the service; its WALLET and expense account ids. */
  const funded = async (amount: bigint) => {
    const organizationId = `${org.a}-GUARDS-${(n += 1)}`;
    const { walletId } = await fundWallet(wiring, organizationId, amount);
    const account = (purpose: 'WALLET' | 'REWARD_EXPENSE') =>
      asActor({ organizationId }, () =>
        wiring.prisma.transaction((tx) =>
          wiring.ledger.resolveAccount(tx, purpose, organizationId, 'IRR', 'itest'),
        ),
      );
    return {
      organizationId,
      walletId,
      wallet: (await account('WALLET')).id,
      expense: (await account('REWARD_EXPENSE')).id,
    };
  };
  type Funded = Awaited<ReturnType<typeof funded>>;

  const journal = async (tx: Raw, organizationId: string) => {
    const journalId = `JRN_${ulid()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
       VALUES ($1, $2, 'REWARD_GRANT', 'hand-written by the suite', now(), 'itest', 'itest')`,
      journalId,
      organizationId,
    );
    return journalId;
  };

  /** One leg per statement, in the order given; returns the legs' ids. */
  const legs = async (
    tx: Raw,
    journalId: string,
    rows: readonly (readonly [account: string, direction: 'DEBIT' | 'CREDIT', amount: bigint])[],
  ) => {
    const ids: string[] = [];
    for (const [accountId, direction, amount] of rows) {
      const id = `LGE_${ulid()}`;
      ids.push(id);
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         SELECT $1, $2, a.id, a.organization_id, $4::"EntryDirection", $5, a.currency, now()
           FROM ledger_account a WHERE a.id = $3`,
        id,
        journalId,
        accountId,
        direction,
        amount,
      );
    }
    return ids;
  };

  /** A balanced journal by hand: the wallet debited, its own expense account credited. */
  const spend = async (tx: Raw, w: Funded, amount: bigint) =>
    legs(tx, await journal(tx, w.organizationId), [
      [w.wallet, 'DEBIT', amount],
      [w.expense, 'CREDIT', amount],
    ]);

  const sum = async (accountId: string) => {
    const [row] = await owner.$queryRawUnsafe<{ s: bigint }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS s
         FROM ledger_entry WHERE account_id = $1`,
      accountId,
    );
    return row!.s;
  };

  const later = async (tx: Raw, legId: string) => {
    const [row] = await tx.$queryRawUnsafe<{ later: boolean }[]>(
      'SELECT wallet_account_debited_later($1) AS later',
      legId,
    );
    return row!.later;
  };

  // ---------------------------------------------------------------------------------------------

  describe('the class: every guard that locks and then reads refuses all but READ COMMITTED', () => {
    const insertTransaction = (tx: Raw, id: string, organizationId: string) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id, transaction_type,
           gross_amount_minor, occurred_at, correlation_id, updated_at, created_by)
         VALUES ($1, $2, $3, 'LOGISTICS', 1000, now(), 'itest', now(), 'itest')`,
        id,
        organizationId,
        `${organizationId}-PAYEE`,
      );

    const insertOtherHold = (tx: Raw, w: Funded) =>
      tx.$executeRawUnsafe(
        `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, status, reference,
           reference_type, placed_at, placed_by)
         VALUES ($1, $2, $3, 1, 'IRR', 'ACTIVE', $4, 'OTHER', now(), 'itest')`,
        `HLD_${ulid()}`,
        w.organizationId,
        w.walletId,
        `RESTORE-${ulid()}`,
      );

    const scope = (fn: string) => (tx: Raw, w: Funded) =>
      tx.$queryRawUnsafe(
        `SELECT ${fn}($1, 'LOGISTICS'::"BusinessLine", 'LOGISTICS'::"TransactionType")::text AS r`,
        w.organizationId,
      );

    /** A scoped commission rule, written by hand: it starts tomorrow, in a scope of its own. */
    const insertRule = (tx: Raw, w: Funded) =>
      tx.$executeRawUnsafe(
        `INSERT INTO commission_rule (id, organization_id, business_line, transaction_type,
           rate_basis_points, valid_from, status, created_by, updated_by, updated_at)
         VALUES ($1, $2, 'LOGISTICS', 'LOGISTICS', 100, (now() AT TIME ZONE 'UTC') + interval '1 day',
           'ACTIVE', 'itest', 'itest', now())`,
        `CMR_${ulid()}`,
        w.organizationId,
      );

    // [guard, what it does, its refusal]. The two hold journal guards are proven the same way in
    // wallet-hold-funding.int-spec.ts, the wallet and escrow one in wallet-account-covered.int-spec.ts.
    const GUARDS: [string, (tx: Raw, w: Funded) => Promise<unknown>, RegExp][] = [
      [
        'trg_commission_rule_read_committed (a rule change)',
        insertRule,
        /A commission rule changes only under READ COMMITTED/,
      ],
      [
        'commission_pricing_scope_lock (a pricing)',
        scope('commission_pricing_scope_lock'),
        /A commission is priced only under READ COMMITTED/,
      ],
      [
        'trg_wallet_hold_reference_bound (a hold for anything else)',
        insertOtherHold,
        /A hold for anything else is written only under READ COMMITTED/,
      ],
      [
        'trg_transaction_id_unclaimed (a transaction)',
        (tx, w) => insertTransaction(tx, `TXN_${ulid()}`, w.organizationId),
        /A transaction is written only under READ COMMITTED/,
      ],
      [
        'trg_ledger_entry_wallet_covered (a wallet debit)',
        (tx, w) => spend(tx, w, 1n),
        /A wallet or escrow account is debited only under READ COMMITTED/,
      ],
    ];

    describe.each(GUARDS)('%s', (_guard, write, refusal) => {
      it('control: under READ COMMITTED it is written', async () => {
        const w = await funded(1000n);
        await expect(runtime.$transaction((tx) => write(tx, w))).resolves.not.toThrow();
      });

      it.each(LEVELS)(
        'under %s, which reads from before the wait, it is refused',
        async (level) => {
          const w = await funded(1000n);
          await expect(
            runtime.$transaction((tx) => write(tx, w), { isolationLevel: level }),
          ).rejects.toThrow(refusal);
        },
      );
    });

    // `commission_rule_scope_change` caches the instant a change is decided at in a setting any
    // session may write, and then takes no lock: the rule write is gated all the same (FU-268
    // self-review).
    it.each(LEVELS)(
      'under %s, a rule change whose instant the session set beforehand is refused all the same',
      async (isolationLevel) => {
        const w = await funded(1000n);
        await expect(
          runtime.$transaction(
            async (tx) => {
              await tx.$queryRawUnsafe(
                `SELECT set_config('rasta.commission_rule_scope_' || to_hex(commission_rule_scope_key(
                   $1, 'LOGISTICS'::"BusinessLine", 'LOGISTICS'::"TransactionType")),
                   '2026-01-01T00:00:00.000', true) AS r`,
                w.organizationId,
              );
              await insertRule(tx, w);
            },
            { isolationLevel },
          ),
        ).rejects.toThrow(/A commission rule changes only under READ COMMITTED/);
      },
    );

    it('a NULL key takes no lock, so the gate refuses it', async () => {
      await expect(
        runtime.$queryRawUnsafe(
          `SELECT read_committed_xact_lock(NULL::bigint, 'never', 'itest_guard')::text AS r`,
        ),
      ).rejects.toThrow(/itest_guard: no key, so no lock/);
    });

    it('no function of the schema takes an advisory lock but the gate', async () => {
      const rows = await owner.$queryRawUnsafe<{ proname: string }[]>(
        `SELECT p.proname FROM pg_proc p
          WHERE p.pronamespace = current_schema()::regnamespace
            AND p.prosrc ~* 'pg_(try_)?advisory_'
            AND p.proname NOT IN ('read_committed_xact_lock', 'read_committed_xact_lock_shared')
            -- The verifier's one reviewed exemption, bound to that exact body (ADVISORY_LOCK_REVIEWED).
            AND NOT (p.proname = 'commission_rule_scope_change'
                     AND md5(p.prosrc) = '00575ce77214199041c83f4c5d64e9ec')
          ORDER BY 1`,
      );
      expect(rows.map((row) => row.proname)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('(F1) two transactions debiting two accounts in opposite orders both commit', () => {
    it('no deadlock at commit: both lock in id order', async () => {
      const [w1, w2] = [await funded(1000n), await funded(1000n)];
      let arrived = 0;
      let go!: () => void;
      const barrier = new Promise<void>((resolve) => (go = resolve));
      const debit = (client: PrismaClient, order: readonly Funded[]) =>
        client.$transaction(
          async (tx) => {
            for (const w of order) await spend(tx, w, 100n);
            if ((arrived += 1) === 2) go();
            await barrier;
          },
          { timeout: 60_000 },
        );
      const outcomes = await Promise.allSettled([debit(runtime, [w1, w2]), debit(other, [w2, w1])]);
      expect(
        outcomes.map((o) => (o.status === 'rejected' ? (o.reason as Error).message : 'ok')),
      ).toEqual(['ok', 'ok']);
      expect([await sum(w1.wallet), await sum(w2.wallet)]).toEqual([800n, 800n]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('(F2) an account is summed once per transaction, by its last debit leg', () => {
    it('legs in separate statements and journals: only the last one sums', async () => {
      const w = await funded(1000n);
      await runtime.$transaction(async (tx) => {
        const [first] = await spend(tx, w, 100n);
        const [second] = await spend(tx, w, 100n);
        const [third] = await spend(tx, w, 100n);
        expect([
          await later(tx, first!),
          await later(tx, second!),
          await later(tx, third!),
        ]).toEqual([true, true, false]);
      });
      expect(await sum(w.wallet)).toBe(700n);
    });

    // What the checks cost, counted by the transaction's own scans of `ledger_entry` (any plan: a
    // scan is one, sequential or index). Re-summed per leg, three legs cost three times one.
    it('at the check, three legs cost less than three single-leg checks', async () => {
      const w = await funded(1000n);
      const scansAtCheck = (count: number) =>
        runtime.$transaction(async (tx) => {
          for (let i = 0; i < count; i += 1) await spend(tx, w, 10n);
          const scans = async () => {
            const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT (seq_scan + COALESCE(idx_scan, 0))::bigint AS n
                 FROM pg_stat_xact_user_tables WHERE relid = 'ledger_entry'::regclass`,
            );
            return row!.n;
          };
          const before = await scans();
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_ledger_entry_wallet_covered IMMEDIATE');
          return (await scans()) - before;
        });
      const one = await scansAtCheck(1);
      const three = await scansAtCheck(3);
      expect(one).toBeGreaterThan(0n);
      expect(three).toBeLessThan(3n * one);
    });

    it('legs of one statement: only the greatest id sums', async () => {
      const w = await funded(1000n);
      const [low, high] = [`LGE_${ulid()}`, `LGE_${ulid()}`].sort();
      await runtime.$transaction(async (tx) => {
        const journalId = await journal(tx, w.organizationId);
        await tx.$executeRawUnsafe(
          `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
           SELECT v.id, $1, a.id, a.organization_id, v.direction::"EntryDirection", 100, a.currency, now()
             FROM ledger_account a,
                  (VALUES ($3, $2, 'DEBIT'), ($4, $2, 'DEBIT'), ($5, $6, 'CREDIT'), ($7, $6, 'CREDIT'))
                    AS v(id, account, direction)
            WHERE a.id = v.account`,
          journalId,
          w.wallet,
          high,
          low,
          `LGE_${ulid()}`,
          w.expense,
          `LGE_${ulid()}`,
        );
        expect([await later(tx, low!), await later(tx, high!)]).toEqual([true, false]);
      });
      expect(await sum(w.wallet)).toBe(800n);
    });

    it('another transaction’s debit is never this one’s later leg', async () => {
      const w = await funded(1000n);
      const [mine] = await runtime.$transaction((tx) => spend(tx, w, 100n));
      await other.$transaction((tx) => spend(tx, w, 100n));
      expect(await later(owner, mine!)).toBe(false);
    });

    it('three legs that together overdraw are refused at commit', async () => {
      const w = await funded(1000n);
      await expect(
        runtime.$transaction(async (tx) => {
          for (let i = 0; i < 3; i += 1) await spend(tx, w, 400n);
        }),
      ).rejects.toThrow(REFUSED);
      expect(await sum(w.wallet)).toBe(1000n);
    });

    it('a leg checked early (SET CONSTRAINTS IMMEDIATE) does not excuse a later overdraft', async () => {
      const w = await funded(1000n);
      await expect(
        runtime.$transaction(async (tx) => {
          await spend(tx, w, 600n);
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_ledger_entry_wallet_covered IMMEDIATE');
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_ledger_entry_wallet_covered DEFERRED');
          await spend(tx, w, 600n);
        }),
      ).rejects.toThrow(REFUSED);
      expect(await sum(w.wallet)).toBe(1000n);
    });

    // A savepoint's rows carry its own xid: never "the same transaction", so never an excuse.
    it('a later leg under a savepoint, rolled back or not, excuses no sum: the overdraft is refused', async () => {
      const w = await funded(1000n);
      await expect(
        runtime.$transaction(async (tx) => {
          const journalId = await journal(tx, w.organizationId);
          const [overdraft] = await legs(tx, journalId, [
            [w.wallet, 'DEBIT', 1500n],
            [w.expense, 'CREDIT', 1500n],
          ]);
          await tx.$executeRawUnsafe('SAVEPOINT later_leg');
          await legs(tx, journalId, [
            [w.wallet, 'DEBIT', 1n],
            [w.expense, 'CREDIT', 1n],
          ]);
          expect(await later(tx, overdraft!)).toBe(false);
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT later_leg');
          expect(await later(tx, overdraft!)).toBe(false);
        }),
      ).rejects.toThrow(REFUSED);
      expect(await sum(w.wallet)).toBe(1000n);
    });

    it('a note rewritten by the session orders locks only: the debit is still summed', async () => {
      const w = await funded(1000n);
      await expect(
        runtime.$transaction(async (tx) => {
          await spend(tx, w, 1001n);
          await tx.$executeRawUnsafe(
            `SELECT set_config('rasta.wallet_covered_accounts', '{}', true)`,
          );
        }),
      ).rejects.toThrow(REFUSED);
      await expect(
        runtime.$transaction(async (tx) => {
          await spend(tx, w, 1n);
          await tx.$executeRawUnsafe(
            `SELECT set_config('rasta.wallet_covered_accounts', 'not an array', true)`,
          );
        }),
      ).rejects.toThrow(/malformed array literal/);
      expect(await sum(w.wallet)).toBe(1000n);
    });
  });
});
