import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
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
 * A wallet's ledger never sums below zero at commit, whoever posts (FU-228, migration
 * 20261108120000_wallet_account_covered_at_commit). The debits are written by hand, as the runtime
 * role: the service's own debits check first and recompute, and a hand-written one does neither.
 */
jest.setTimeout(120_000);

const REFUSED = new RegExp(WALLET_ACCOUNT_COVERED_REFUSAL);
const ONLY_RC = /A guard that locks and then reads runs only under READ COMMITTED/;

type Raw = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

describe('a wallet or escrow account never sums below zero at commit (real database)', () => {
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
    await prisma.stop();
    await Promise.all([owner.$disconnect(), runtime.$disconnect(), other.$disconnect()]);
  });

  /** A wallet of its own, funded through the service; its WALLET and ESCROW account ids. */
  const funded = async (amount: bigint) => {
    const organizationId = `${org.a}-COVERED-${(n += 1)}`;
    const { walletId } = await fundWallet(wiring, organizationId, amount);
    const account = (purpose: 'WALLET' | 'ESCROW' | 'REWARD_EXPENSE') =>
      asActor({ organizationId }, () =>
        wiring.prisma.transaction((tx) =>
          wiring.ledger.resolveAccount(tx, purpose, organizationId, 'IRR', 'itest'),
        ),
      );
    return {
      organizationId,
      walletId,
      wallet: (await account('WALLET')).id,
      escrow: (await account('ESCROW')).id,
      expense: (await account('REWARD_EXPENSE')).id,
    };
  };

  /** A balanced journal by hand: `from` debited, `to` credited. */
  const post = async (
    tx: Raw,
    organizationId: string,
    from: string,
    to: string,
    amount: bigint,
  ) => {
    const journalId = `JRN_${ulid()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
       VALUES ($1, $2, 'REWARD_GRANT', 'hand-written by the suite', now(), 'itest', 'itest')`,
      journalId,
      organizationId,
    );
    for (const [accountId, direction] of [
      [from, 'DEBIT'],
      [to, 'CREDIT'],
    ] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         SELECT $1, $2, a.id, a.organization_id, $4::"EntryDirection", $5, a.currency, now()
           FROM ledger_account a WHERE a.id = $3`,
        `LGE_${ulid()}`,
        journalId,
        accountId,
        direction,
        amount,
      );
    }
    return journalId;
  };

  const sum = async (accountId: string) => {
    const [row] = await owner.$queryRawUnsafe<{ s: bigint }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS s
         FROM ledger_entry WHERE account_id = $1`,
      accountId,
    );
    return row!.s;
  };

  it('control: a hand-written debit the account covers commits', async () => {
    const w = await funded(1000n);
    await runtime.$transaction((tx) => post(tx, w.organizationId, w.wallet, w.expense, 1000n));
    expect(await sum(w.wallet)).toBe(0n);
  });

  it('(a) a hand-written debit past the wallet balance is refused at commit, and nothing is written', async () => {
    const w = await funded(1000n);
    let journalId = '';
    await expect(
      runtime.$transaction(async (tx) => {
        journalId = await post(tx, w.organizationId, w.wallet, w.expense, 1001n);
      }),
    ).rejects.toThrow(REFUSED);
    expect(await sum(w.wallet)).toBe(1000n);
    const [row] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM journal WHERE id = $1',
      journalId,
    );
    expect(row!.n).toBe(0n);
  });

  it('(a) escrow is covered the same way: taken back with no hold in it, refused', async () => {
    const w = await funded(1000n);
    await expect(
      runtime.$transaction((tx) => post(tx, w.organizationId, w.escrow, w.wallet, 1n)),
    ).rejects.toThrow(REFUSED);
    expect(await sum(w.escrow)).toBe(0n);
  });

  it('(a) a debit credited back later in the same transaction is asked at commit, and commits', async () => {
    const w = await funded(1000n);
    await runtime.$transaction(async (tx) => {
      await post(tx, w.organizationId, w.wallet, w.expense, 1500n);
      await post(tx, w.organizationId, w.expense, w.wallet, 500n);
    });
    expect(await sum(w.wallet)).toBe(0n);
  });

  describe('through the service’s transaction, the refusal is 422 INSUFFICIENT_BALANCE', () => {
    const asService = (organizationId: string, fn: (tx: Raw) => Promise<unknown>) =>
      asActor({ organizationId }, () =>
        wiring.prisma.transaction((tx) =>
          runUnscoped('the suite writes a hand-made journal', () => fn(tx as unknown as Raw)),
        ),
      );

    it('refused at commit by the ledger', async () => {
      const w = await funded(1000n);
      await expect(
        asService(w.organizationId, (tx) => post(tx, w.organizationId, w.wallet, w.expense, 1001n)),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 422 });
    });

    it('refused at the recompute by ck_wallet_balances', async () => {
      const w = await funded(1000n);
      await expect(
        asService(w.organizationId, async (tx) => {
          await post(tx, w.organizationId, w.wallet, w.expense, 1001n);
          const [locked] = await wiring.walletRepository.lock(tx as never, [w.walletId]);
          await wiring.walletRepository.recomputeFromLedger(tx as never, locked!);
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 422 });
      expect(await sum(w.wallet)).toBe(1000n);
    });
  });

  describe('(b) two debits that together overdraw: exactly one commits', () => {
    /** Until a session of this database waits on an advisory lock: the race is on. */
    const someoneWaits = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        // As the waiter's role: a role sees only its own sessions' wait events.
        const [row] = await runtime.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        if (row!.n > 0n) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('nobody waited on the account lock');
    };

    it('the second waits for the first to commit, then sums both and is refused', async () => {
      const w = await funded(1000n);
      let release!: () => void;
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => (opened = resolve));
      const first = other.$transaction(
        async (tx) => {
          // Asked at this statement rather than at commit, so the lock is held from here.
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_ledger_entry_wallet_covered IMMEDIATE');
          await post(tx, w.organizationId, w.wallet, w.expense, 600n);
          opened();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 },
      );
      await Promise.race([ready, first]);
      const second = runtime
        .$transaction((tx) => post(tx, w.organizationId, w.wallet, w.expense, 600n))
        .then(
          () => null,
          (error: Error) => error,
        );
      try {
        await someoneWaits();
      } finally {
        release?.();
      }
      expect(await first.then(() => null)).toBeNull();
      expect((await second)?.message).toMatch(REFUSED);
      expect(await sum(w.wallet)).toBe(400n);
    });

    it('both written, then both committed at once', async () => {
      const w = await funded(1000n);
      let arrived = 0;
      let go!: () => void;
      const barrier = new Promise<void>((resolve) => (go = resolve));
      const debit = (client: PrismaClient) =>
        client.$transaction(
          async (tx) => {
            await post(tx, w.organizationId, w.wallet, w.expense, 600n);
            if ((arrived += 1) === 2) go();
            await barrier;
          },
          { timeout: 60_000 },
        );
      const outcomes = await Promise.allSettled([debit(runtime), debit(other)]);
      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refusal = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect((refusal.reason as Error).message).toMatch(REFUSED);
      expect(await sum(w.wallet)).toBe(400n);
    });

    // Both read a snapshot from before the wait (#936 r1 F1): every level but READ COMMITTED.
    it.each(['RepeatableRead', 'Serializable'] as const)(
      'under %s, which reads from before the wait, a covered debit is refused too',
      async (isolationLevel) => {
        const w = await funded(1000n);
        await expect(
          runtime.$transaction((tx) => post(tx, w.organizationId, w.wallet, w.expense, 1n), {
            isolationLevel,
          }),
        ).rejects.toThrow(ONLY_RC);
        expect(await sum(w.wallet)).toBe(1000n);
      },
    );
  });
});
