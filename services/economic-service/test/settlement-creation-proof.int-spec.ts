import { ulid } from 'ulid';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  databaseUrl,
  fundWallet,
  newPrisma,
  ownerDatabaseUrl,
  PLATFORM_ORGANIZATION_ID,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * A settlement proves it happened when it is written (FU-097; #721 r2, F3;
 * migration 20261105120000_settlement_creation_proof).
 *
 * Every forgery here goes straight at the database as the service's own runtime
 * role, and differs by exactly one thing from {@link write}'s hand-written whole
 * settlement, which itself commits: so each refusal is that one difference's. The
 * owner connection only plants what no runtime write can any more.
 */
jest.setTimeout(120_000);

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const GROSS = 10_000n;
const REVENUE = 1_000n;
const NET = GROSS - REVENUE;

const PARTIES = /exactly the parties of its transaction/;
const FIGURES = /exactly the figures of its transaction/;
const COMMISSION = /exactly what its settlement states/;
const TOGETHER = /written together, by one transaction/;
const UNSETTLED = /moves its transaction to SETTLED/;
const JOURNAL = /SETTLEMENT journal its own transaction posted/;
const LEGS = /legs of a settlement journal are exactly the settlement/;
const HOLD = /debits escrow exactly when its journal released the hold/;

interface Leg {
  accountId: string;
  organizationId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: bigint;
  currency?: string;
}

interface Accounts {
  payerWallet: string;
  payerEscrow: string;
  payeeWallet: string;
  revenue: string;
}

/** One difference from the whole, correct settlement {@link write} otherwise writes. */
interface Forgery {
  settlement?: Row;
  commission?: Row | null;
  /** Replaces the columns of the journal, or names an existing one and posts none. */
  journal?: Row;
  journalId?: string;
  legs?: (accounts: Accounts) => Leg[];
  /** `false`: the transaction is not moved to SETTLED. */
  move?: boolean;
  /** Writes a hold released by this journal. */
  hold?: (journalId: string, tx: Tx) => Promise<unknown>;
}

describe('the proof of a settlement at its creation (real database, runtime role)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let runtime: PrismaClient;
  let owner: PrismaClient;
  const org = tenants();
  const payer = `${org.a}-FU97`;
  const payee = `${org.b}-FU97`;
  const chargedPayee = `${org.b}-FU97-CHARGED`;
  const allTakenPayee = `${org.b}-FU97-ALL`;
  const stranger = `${org.c}-FU97`;
  let accounts: Accounts;

  const rule = (organizationId: string, rateBasisPoints: number) =>
    asActor({ organizationId: payer, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.commissions.createRule({
        organizationId,
        businessLine: 'PARTS',
        transactionType: 'MARKETPLACE_ORDER',
        rateBasisPoints,
        status: 'ACTIVE',
        label: 'itest',
      }),
    );

  const accountOf = async (organizationId: string, purpose: string, currency = 'IRR') => {
    const [row] = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ledger_account
        WHERE organization_id = $1 AND purpose = $2::"AccountPurpose" AND currency = $3`,
      organizationId,
      purpose,
      currency,
    );
    return row!.id;
  };

  const newAccount = async (
    organizationId: string,
    purpose: string,
    type: string,
    currency = 'IRR',
  ) => {
    const id = `ACC_${ulid()}`;
    await runtime.$executeRawUnsafe(
      `INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
       VALUES ($1, $2, $3::"AccountType", $4, $5::"AccountPurpose", $6, 'itest')`,
      id,
      organizationId,
      type,
      `ITEST-${id}`,
      purpose,
      currency,
    );
    return id;
  };

  /** An authorised transaction, through the service: ready to settle, nothing else true yet. */
  async function pending(options: { to?: string; holdFunds?: boolean; line?: boolean } = {}) {
    const { to = chargedPayee, holdFunds = false, line = true } = options;
    const transaction = await asActor({ organizationId: payer }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        ...(line ? { businessLine: 'PARTS' as const } : {}),
        counterpartyOrganizationId: to,
        grossAmountMinor: GROSS.toString(),
        currency: 'IRR',
        holdFunds,
      }),
    );
    await asActor({ organizationId: payer }, () =>
      wiring.transactions.authoriseSettlement(transaction.id),
    );
    return transaction.id;
  }

  const settleForReal = (transactionId: string) =>
    asActor({ organizationId: payer }, () => wiring.settlements.settle(transactionId, 'USR-ITEST'));

  const rowsOf = async (transactionId: string) => {
    const [row] = await owner.$queryRawUnsafe<
      { settlements: bigint; commissions: bigint; status: string }[]
    >(
      `SELECT (SELECT count(*) FROM settlement WHERE transaction_id = t.id) AS settlements,
              (SELECT count(*) FROM commission WHERE transaction_id = t.id) AS commissions,
              t.status::text AS status
         FROM "transaction" t WHERE t.id = $1`,
      transactionId,
    );
    return row!;
  };

  const INSERT_ROW = (table: string) =>
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`;

  const insertRow = (tx: Pick<Tx, '$executeRawUnsafe'>, table: string, row: Row) =>
    tx.$executeRawUnsafe(INSERT_ROW(table), JSON.stringify(row));

  const insertJournal = async (tx: Tx, transactionId: string, overrides: Row = {}) => {
    const id = `JRN_${ulid()}`;
    const now = new Date();
    await insertRow(tx, 'journal', {
      id,
      organization_id: payer,
      transaction_id: transactionId,
      journal_type: 'SETTLEMENT',
      description: 'itest',
      posted_at: now,
      posted_by: 'itest',
      correlation_id: 'itest',
      created_at: now,
      ...overrides,
    });
    return id;
  };

  const insertLegs = async (tx: Tx, journalId: string, legs: Leg[]) => {
    for (const leg of legs) {
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction,
                                   amount_minor, currency, posted_at)
         VALUES ($1, $2, $3, $4, $5::"EntryDirection", $6::bigint, $7, now())`,
        `ENT_${ulid()}`,
        journalId,
        leg.accountId,
        leg.organizationId,
        leg.direction,
        leg.amount,
        leg.currency ?? 'IRR',
      );
    }
  };

  const walletLegs = (from: Accounts): Leg[] => [
    { accountId: from.payerWallet, organizationId: payer, direction: 'DEBIT', amount: GROSS },
    { accountId: from.payeeWallet, organizationId: chargedPayee, direction: 'CREDIT', amount: NET },
    {
      accountId: from.revenue,
      organizationId: PLATFORM_ORGANIZATION_ID,
      direction: 'CREDIT',
      amount: REVENUE,
    },
  ];

  /** What `settle()` would write for this file's 10,000 with 1,000 commission to {@link chargedPayee}. */
  const settlementRow = (transactionId: string, journalId: string, at = new Date()): Row => ({
    id: `STL_${ulid()}`,
    organization_id: payer,
    transaction_id: transactionId,
    journal_id: journalId,
    payer_organization_id: payer,
    payee_organization_id: chargedPayee,
    gross_amount_minor: Number(GROSS),
    commission_amount_minor: Number(REVENUE),
    net_amount_minor: Number(NET),
    currency: 'IRR',
    settled_at: at,
    settled_by: 'itest',
  });

  const commissionRow = (
    transactionId: string,
    journalId: string | null,
    at = new Date(),
  ): Row => ({
    id: `CMS_${ulid()}`,
    organization_id: chargedPayee,
    transaction_id: transactionId,
    rule_id: chargedRule,
    business_line: 'PARTS',
    outcome: 'RULE_APPLIED',
    rate_basis_points: 1_000,
    gross_amount_minor: Number(GROSS),
    amount_minor: Number(REVENUE),
    currency: 'IRR',
    journal_id: journalId,
    applied_at: at,
  });

  /** `act` with one trigger lifted, in one owner transaction, which restores it on every exit path. */
  const lifted = (table: string, trigger: string, act: (tx: Tx) => Promise<unknown>) =>
    owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await act(tx);
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    });

  /** A real journal of the payer's, posted long ago, of no settlement. */
  const topUpJournal = async () => {
    const [found] = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM journal WHERE journal_type = 'WALLET_TOP_UP' AND organization_id = $1 LIMIT 1`,
      payer,
    );
    return found!.id;
  };

  /**
   * The whole settlement by hand, in `settle()`'s own order: journal, legs, hold,
   * commission, settlement, transaction. Commits as it stands: everything below
   * refused is refused for its one difference.
   */
  const write = (transactionId: string, forgery: Forgery = {}) => {
    const settledAt = new Date();
    return runtime.$transaction(async (tx) => {
      const journalId =
        forgery.journalId ?? (await insertJournal(tx, transactionId, forgery.journal));
      if (!forgery.journalId) {
        await insertLegs(tx, journalId, forgery.legs?.(accounts) ?? walletLegs(accounts));
      }
      await forgery.hold?.(journalId, tx);
      if (forgery.commission !== null) {
        await insertRow(tx, 'commission', {
          ...commissionRow(transactionId, journalId, settledAt),
          ...forgery.commission,
        });
      }
      await insertRow(tx, 'settlement', {
        ...settlementRow(transactionId, journalId, settledAt),
        ...forgery.settlement,
      });
      if (forgery.move !== false) {
        await tx.$executeRawUnsafe(
          `UPDATE "transaction"
              SET status = 'SETTLED', settled_at = $2::timestamp(3), commission_amount_minor = $3::bigint,
                  net_amount_minor = $4::bigint
            WHERE id = $1`,
          transactionId,
          settledAt,
          REVENUE,
          NET,
        );
      }
    });
  };

  /** Refused, and nothing of it stayed: the real settlement still finds the transaction free. */
  const refused = async (transactionId: string, forgery: Forgery, because: RegExp | string) => {
    await expect(write(transactionId, forgery)).rejects.toThrow(because);
    await expect(rowsOf(transactionId)).resolves.toMatchObject({
      settlements: 0n,
      commissions: 0n,
      status: 'PENDING_SETTLEMENT',
    });
  };

  let chargedRule: string;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    await fundWallet(wiring, payer, 100_000_000n);
    for (const to of [payee, chargedPayee, allTakenPayee, stranger])
      await fundWallet(wiring, to, 0n);
    chargedRule = (await rule(chargedPayee, 1_000)).id;
    await rule(allTakenPayee, 10_000);
    // One real settlement opens the platform's revenue account and the escrow, as the first of a day would.
    await settleForReal(await pending({ holdFunds: true }));
    accounts = {
      payerWallet: await accountOf(payer, 'WALLET'),
      payerEscrow: await accountOf(payer, 'ESCROW'),
      payeeWallet: await accountOf(chargedPayee, 'WALLET'),
      revenue: await accountOf(PLATFORM_ORGANIZATION_ID, 'COMMISSION_REVENUE'),
    };
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
    await runtime.$disconnect();
    await owner.$disconnect();
  });

  describe('settle() keeps working, in its current write order', () => {
    it.each([
      ['held, charged', true, () => chargedPayee, true, 1_000n],
      ['paid from the wallet, charged', false, () => chargedPayee, true, 1_000n],
      ['held, charged nothing', true, () => payee, false, 0n],
      ['paid from the wallet, charged nothing', false, () => payee, false, 0n],
      ['held, charged everything: no leg to the payee', true, () => allTakenPayee, true, 10_000n],
    ] as const)('%s', async (_label, holdFunds, to, line, commission) => {
      const transactionId = await pending({ holdFunds, to: to(), line });
      const result = await settleForReal(transactionId);
      expect(result.commissionAmountMinor).toBe(commission);
      expect(await rowsOf(transactionId)).toMatchObject({
        settlements: 1n,
        commissions: 1n,
        status: 'SETTLED',
      });
    });

    it('and so does the whole of it written by hand: the control every forgery below differs from', async () => {
      const transactionId = await pending();
      await write(transactionId);
      expect(await rowsOf(transactionId)).toMatchObject({ settlements: 1n, status: 'SETTLED' });
    });
  });

  describe('reserving a transaction, the row alone', () => {
    it('a settlement alone, on an unsettled transaction, is refused, and the real settlement still goes through', async () => {
      const transactionId = await pending();
      const id = await topUpJournal();
      await expect(
        insertRow(runtime, 'settlement', settlementRow(transactionId, id)),
      ).rejects.toThrow(TOGETHER);
      await settleForReal(transactionId);
      expect(await rowsOf(transactionId)).toMatchObject({ settlements: 1n, status: 'SETTLED' });
    });

    it('a commission alone, on an unsettled transaction, is refused, and the real settlement still goes through', async () => {
      const transactionId = await pending();
      await expect(
        insertRow(runtime, 'commission', commissionRow(transactionId, null)),
      ).rejects.toThrow(TOGETHER);
      await settleForReal(transactionId);
      expect(await rowsOf(transactionId)).toMatchObject({ commissions: 1n, status: 'SETTLED' });
    });

    it('a forgery in flight delays the settlement behind it, and then does not stop it', async () => {
      const transactionId = await pending();
      const id = await topUpJournal();
      let commit!: () => void;
      const gate = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let inserted!: () => void;
      const reserved = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const forged = runtime.$transaction(
        async (tx) => {
          await insertRow(tx, 'settlement', settlementRow(transactionId, id));
          inserted();
          await gate;
        },
        { timeout: 30_000 },
      );
      await reserved;
      const real = settleForReal(transactionId);
      // The settlement reaches the unique key the forgery holds, and waits on it.
      await expect(
        Promise.race([real, new Promise((resolve) => setTimeout(() => resolve('waiting'), 500))]),
      ).resolves.toBe('waiting');
      commit();
      await expect(forged).rejects.toThrow(TOGETHER);
      await real;
      expect(await rowsOf(transactionId)).toMatchObject({ settlements: 1n, status: 'SETTLED' });
    });

    it('asking for the check at once only fails it sooner', async () => {
      const transactionId = await pending();
      await expect(
        runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_settlement_creation_proven IMMEDIATE');
          const journalId = await insertJournal(tx, transactionId);
          await insertLegs(tx, journalId, walletLegs(accounts));
          await tx.$executeRawUnsafe(
            INSERT_ROW('settlement'),
            JSON.stringify(settlementRow(transactionId, journalId)),
          );
        }),
      ).rejects.toThrow(TOGETHER);
    });
  });

  describe('the unsettled transaction', () => {
    it('never moved to SETTLED', async () => {
      await refused(await pending(), { move: false }, UNSETTLED);
    });

    it('written to by this database transaction, but not moved to SETTLED', async () => {
      await refused(
        await pending(),
        {
          move: false,
          hold: (_journalId, tx) =>
            tx.$executeRawUnsafe(
              `UPDATE "transaction" SET updated_at = now() WHERE organization_id = $1 AND status = 'PENDING_SETTLEMENT'`,
              payer,
            ),
        },
        UNSETTLED,
      );
    });

    it('SETTLED already, by someone else: a top-up with no settlement', async () => {
      const transactionId = `TXN_${ulid()}`;
      await runtime.$executeRawUnsafe(
        `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id, transaction_type, status,
                                    gross_amount_minor, commission_amount_minor, net_amount_minor, occurred_at,
                                    settled_at, correlation_id, updated_at, created_by, business_line)
         VALUES ($1, $2, $3, 'MARKETPLACE_ORDER', 'SETTLED', $4::bigint, $5::bigint, $6::bigint, now(), now(),
                 'COR-FU97', now(), 'itest', 'PARTS')`,
        transactionId,
        payer,
        chargedPayee,
        GROSS,
        REVENUE,
        NET,
      );
      await expect(write(transactionId, { move: false })).rejects.toThrow(UNSETTLED);
    });
  });

  describe('reserving a transaction by rewriting it around the proof', () => {
    const update = (
      transactionId: string,
      assignment: string,
      client: Pick<Tx, '$executeRawUnsafe'> = runtime,
    ) =>
      client.$executeRawUnsafe(
        `UPDATE "transaction" SET ${assignment} WHERE id = $1`,
        transactionId,
      );

    it.each([
      ['its gross', 'gross_amount_minor = 1'],
      ['its payee', `counterparty_organization_id = 'ORG-ELSEWHERE'`],
      ['its payee, to none', 'counterparty_organization_id = NULL'],
      ['its payer', `organization_id = 'ORG-ELSEWHERE'`],
      ['its currency', `currency = 'USD'`],
      ['its line', `business_line = 'LOGISTICS'`],
    ])('%s never changes', async (_label, assignment) => {
      const transactionId = await pending();
      await expect(update(transactionId, assignment)).rejects.toThrow(/Who pays whom, how much/);
    });

    it('moved to SETTLED alone, nothing else written, it is refused at commit', async () => {
      const transactionId = await pending();
      await expect(
        update(
          transactionId,
          `status = 'SETTLED', settled_at = now(), net_amount_minor = gross_amount_minor`,
        ),
      ).rejects.toThrow(TOGETHER);
      await settleForReal(transactionId);
    });

    it.each([
      ['HELD', 'HELD'],
      ['CANCELLED', 'CANCELLED'],
    ])('a whole settlement by hand from %s is refused at the move', async (_label, status) => {
      const transactionId = await pending();
      await update(transactionId, `status = '${status}'`, owner);
      await expect(write(transactionId)).rejects.toThrow(/settled only from PENDING_SETTLEMENT/);
    });

    it('once settled it does not go back to be settled again', async () => {
      const transactionId = await pending();
      await settleForReal(transactionId);
      for (const status of ['PENDING_SETTLEMENT', 'REFUNDED', 'CANCELLED']) {
        await expect(update(transactionId, `status = '${status}'`)).rejects.toThrow(
          /only by its reversal/,
        );
      }
    });

    it.each([
      ['commission and net', 'commission_amount_minor = 500, net_amount_minor = 9500'],
      ['the instant', `settled_at = '2020-01-01'`],
    ])('once settled, %s stay what it settled at', async (_label, assignment) => {
      const transactionId = await pending();
      await settleForReal(transactionId);
      await expect(update(transactionId, assignment)).rejects.toThrow(/settled at never changes/);
    });
  });

  describe('the wrong party', () => {
    it.each([
      ['a payer that is not the transaction’s', { payer_organization_id: 'ORG-ELSEWHERE' }],
      [
        'books and payer of another organization',
        { organization_id: 'ORG-ELSEWHERE', payer_organization_id: 'ORG-ELSEWHERE' },
      ],
      ['a payee that is not the transaction’s', { payee_organization_id: 'ORG-ELSEWHERE' }],
    ])('%s', async (_label, settlement) => {
      await refused(await pending(), { settlement }, PARTIES);
    });
  });

  describe('the wrong amount', () => {
    it.each([
      ['gross', { gross_amount_minor: 20_000, net_amount_minor: 19_000 }],
      [
        'the split of commission and net',
        { commission_amount_minor: 500, net_amount_minor: 9_500 },
      ],
      ['the currency', { currency: 'USD' }],
      ['the instant', { settled_at: new Date(0) }],
    ])('%s', async (_label, settlement) => {
      await refused(await pending(), { settlement }, FIGURES);
    });
  });

  describe('the commission row', () => {
    it('missing', async () => {
      await refused(await pending(), { commission: null }, TOGETHER);
    });

    it.each([
      ['charged to someone other than the payee', { organization_id: 'ORG-ELSEWHERE' }],
      ['on another gross', { gross_amount_minor: 20_000 }],
      ['for another amount', { amount_minor: 500 }],
      ['in another currency', { currency: 'USD' }],
      ['with no journal', { journal_id: null }],
      ['at another instant', { applied_at: new Date(0) }],
      ['on another line', { business_line: 'LOGISTICS' }],
    ])('%s', async (_label, commission) => {
      await refused(await pending(), { commission }, COMMISSION);
    });

    it('naming a journal other than the settlement’s', async () => {
      const id = await topUpJournal();
      await refused(await pending(), { commission: { journal_id: id } }, COMMISSION);
    });

    it('added later to a settlement that committed without one', async () => {
      const transactionId = await pending();
      const journalId = await planted(transactionId);
      await expect(
        insertRow(runtime, 'commission', commissionRow(transactionId, journalId)),
      ).rejects.toThrow(TOGETHER);
    });

    it('written before the settlement, by another transaction', async () => {
      const transactionId = await pending();
      await lifted('commission', 'trg_commission_creation_proven', (tx) =>
        insertRow(tx, 'commission', commissionRow(transactionId, null)),
      );
      await expect(write(transactionId, { commission: null })).rejects.toThrow(TOGETHER);
    });
  });

  /** A settlement committed past the proof, with a journal of its own and no commission. */
  async function planted(transactionId: string) {
    const journalId = await runtime.$transaction(async (tx) => {
      const id = await insertJournal(tx, transactionId);
      await insertLegs(tx, id, walletLegs(accounts));
      return id;
    });
    await lifted('settlement', 'trg_settlement_creation_proven', (tx) =>
      insertRow(tx, 'settlement', settlementRow(transactionId, journalId)),
    );
    return journalId;
  }

  describe('the missing or foreign journal', () => {
    it('no such journal: the foreign key', async () => {
      await refused(
        await pending(),
        { journalId: `JRN_${ulid()}`, commission: null },
        /settlement_journal_id_fkey|Foreign key constraint/,
      );
    });

    it('a commission naming no such journal: its foreign key', async () => {
      const transactionId = await pending();
      await expect(
        insertRow(runtime, 'commission', commissionRow(transactionId, `JRN_${ulid()}`)),
      ).rejects.toThrow(/commission_journal_id_fkey|Foreign key constraint/);
    });

    it('a journal a settlement names cannot be deleted, even with its own guard lifted', async () => {
      const transactionId = await pending();
      await settleForReal(transactionId);
      const [{ journal_id: journalId }] = await owner.$queryRawUnsafe<{ journal_id: string }[]>(
        'SELECT journal_id FROM settlement WHERE transaction_id = $1',
        transactionId,
      );
      await owner
        .$transaction(async (tx) => {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
          await tx.$executeRawUnsafe('ALTER TABLE journal DISABLE TRIGGER trg_journal_immutable');
          await expect(
            tx.$executeRawUnsafe('DELETE FROM journal WHERE id = $1', journalId),
          ).rejects.toThrow(/foreign key|violates|Foreign key/i);
          throw new Error('rolled back: the probe keeps nothing');
        })
        .catch((error: Error) => {
          // Postgres aborted the transaction at the refusal; either way nothing stayed.
          expect(error.message).toMatch(/rolled back|current transaction is aborted/);
        });
    });

    it('a journal of the transaction, posted earlier by another database transaction', async () => {
      const transactionId = await pending();
      const journalId = await runtime.$transaction(async (tx) => {
        const id = await insertJournal(tx, transactionId);
        await insertLegs(tx, id, walletLegs(accounts));
        return id;
      });
      await refused(transactionId, { journalId }, JOURNAL);
    });

    it.each([
      ['of another type', { journal_type: 'FUNDS_HELD' }, JOURNAL],
      ['on the books of another organization', { organization_id: 'ORG-ELSEWHERE' }, JOURNAL],
      ['of no transaction', { transaction_id: null }, JOURNAL],
    ])('a journal %s', async (_label, journal, because) => {
      await refused(await pending(), { journal }, because);
    });

    it('a journal of another transaction, posted in this one', async () => {
      const other = await pending();
      await refused(await pending(), { journal: { transaction_id: other } }, JOURNAL);
    });
  });

  describe('legs that are not the settlement', () => {
    const debit = (amount: bigint, from = 'payerWallet' as keyof Accounts, org2 = payer): Leg => ({
      accountId: accounts[from],
      organizationId: org2,
      direction: 'DEBIT',
      amount,
    });
    const toPayee = (amount: bigint): Leg => ({
      accountId: accounts.payeeWallet,
      organizationId: chargedPayee,
      direction: 'CREDIT',
      amount,
    });
    const toRevenue = (amount: bigint): Leg => ({
      accountId: accounts.revenue,
      organizationId: PLATFORM_ORGANIZATION_ID,
      direction: 'CREDIT',
      amount,
    });

    it('less gross than it says, balanced', async () => {
      const legs = () => [debit(GROSS - 1n), toPayee(NET - 1n), toRevenue(REVENUE)];
      await refused(await pending(), { legs }, LEGS);
    });

    it('more net than it says, the commission short', async () => {
      const legs = () => [debit(GROSS), toPayee(NET + 1n), toRevenue(REVENUE - 1n)];
      await refused(await pending(), { legs }, LEGS);
    });

    it('two debits', async () => {
      const legs = () => [debit(GROSS - 1n), debit(1n), toPayee(NET), toRevenue(REVENUE)];
      await refused(await pending(), { legs }, LEGS);
    });

    it('two credits to the payee', async () => {
      const legs = () => [debit(GROSS), toPayee(NET - 1n), toPayee(1n), toRevenue(REVENUE)];
      await refused(await pending(), { legs }, LEGS);
    });

    it('two credits to revenue', async () => {
      const legs = () => [debit(GROSS), toPayee(NET), toRevenue(REVENUE - 1n), toRevenue(1n)];
      await refused(await pending(), { legs }, LEGS);
    });

    it('debited from a wallet that is not the payer’s', async () => {
      const elsewhere = await accountOf(payee, 'WALLET');
      const legs = (): Leg[] => [
        { accountId: elsewhere, organizationId: payee, direction: 'DEBIT', amount: GROSS },
        toPayee(NET),
        toRevenue(REVENUE),
      ];
      await refused(await pending(), { legs }, LEGS);
    });

    it('credited to a wallet that is not the payee’s', async () => {
      const elsewhere = await accountOf(stranger, 'WALLET');
      const legs = (): Leg[] => [
        debit(GROSS),
        { accountId: elsewhere, organizationId: stranger, direction: 'CREDIT', amount: NET },
        toRevenue(REVENUE),
      ];
      await refused(await pending(), { legs }, LEGS);
    });

    it('a credit to revenue that is a liability under the label', async () => {
      const owner2 = `${org.c}-FU97-${ulid()}`;
      const relabelled = await newAccount(owner2, 'COMMISSION_REVENUE', 'LIABILITY');
      const legs = (): Leg[] => [
        debit(GROSS),
        toPayee(NET),
        { accountId: relabelled, organizationId: owner2, direction: 'CREDIT', amount: REVENUE },
      ];
      await refused(await pending(), { legs }, LEGS);
    });

    it('a leg of a purpose that belongs to none of it', async () => {
      const clearing = await newAccount(payer, 'PAYMENT_CLEARING', 'ASSET');
      const legs = (): Leg[] => [
        { accountId: clearing, organizationId: payer, direction: 'DEBIT', amount: GROSS },
        toPayee(NET),
        toRevenue(REVENUE),
      ];
      await refused(await pending(), { legs }, LEGS);
    });

    it('every leg in another currency than the settlement’s, balanced', async () => {
      const usd = {
        payer: await newAccount(payer, 'WALLET', 'LIABILITY', 'USD'),
        payee: await newAccount(chargedPayee, 'WALLET', 'LIABILITY', 'USD'),
        revenue: await newAccount(
          `${org.c}-FU97-${ulid()}`,
          'COMMISSION_REVENUE',
          'REVENUE',
          'USD',
        ),
      };
      const [{ organization_id: revenueOwner }] = await owner.$queryRawUnsafe<
        { organization_id: string }[]
      >('SELECT organization_id FROM ledger_account WHERE id = $1', usd.revenue);
      const legs = (): Leg[] => [
        {
          accountId: usd.payer,
          organizationId: payer,
          direction: 'DEBIT',
          amount: GROSS,
          currency: 'USD',
        },
        {
          accountId: usd.payee,
          organizationId: chargedPayee,
          direction: 'CREDIT',
          amount: NET,
          currency: 'USD',
        },
        {
          accountId: usd.revenue,
          organizationId: revenueOwner,
          direction: 'CREDIT',
          amount: REVENUE,
          currency: 'USD',
        },
      ];
      await refused(await pending(), { legs }, LEGS);
    });
  });

  describe('escrow and its hold', () => {
    const escrowLegs = (from: Accounts): Leg[] => [
      { accountId: from.payerEscrow, organizationId: payer, direction: 'DEBIT', amount: GROSS },
      ...walletLegs(from).slice(1),
    ];

    const releaseHold = (transactionId: string) => (journalId: string, tx: Tx) =>
      tx.$executeRawUnsafe(
        `UPDATE wallet_hold SET status = 'RELEASED', resolved_journal_id = $2, resolved_at = now(), resolved_by = 'itest'
          WHERE reference = $1 AND status = 'ACTIVE'`,
        transactionId,
        journalId,
      );

    const heldHere = async () => pending({ holdFunds: true });

    it('the hold released by this journal, and the escrow debited: the control', async () => {
      const transactionId = await heldHere();
      await write(transactionId, { legs: escrowLegs, hold: releaseHold(transactionId) });
      expect(await rowsOf(transactionId)).toMatchObject({ settlements: 1n, status: 'SETTLED' });
    });

    it('a hold left ACTIVE', async () => {
      await refused(await heldHere(), { legs: escrowLegs }, HOLD);
    });

    it('a hold left ACTIVE, the wallet debited instead', async () => {
      await refused(await heldHere(), {}, HOLD);
    });

    it('the hold released, the wallet debited instead', async () => {
      const transactionId = await heldHere();
      await refused(transactionId, { hold: releaseHold(transactionId) }, HOLD);
    });

    it('escrow debited with no hold at all', async () => {
      await refused(await pending(), { legs: escrowLegs }, HOLD);
    });

    it.each([
      ['released by another journal', (id: string) => ({ resolved_journal_id: `${id}X` })],
      ['of another organization', () => ({ organization_id: 'ORG-ELSEWHERE' })],
      ['for another amount', () => ({ amount_minor: 1 })],
      ['in another currency', () => ({ currency: 'USD' })],
      ['refunded by this journal, not released', () => ({ status: 'REFUNDED' })],
    ])('a hold %s', async (_label, changes) => {
      const transactionId = await pending();
      const now = new Date();
      const [wallet] = await owner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM wallet WHERE organization_id = $1 AND currency = 'IRR'`,
        payer,
      );
      await refused(
        transactionId,
        {
          legs: escrowLegs,
          hold: (journalId, tx) =>
            insertRow(tx, 'wallet_hold', {
              id: `HLD_${ulid()}`,
              organization_id: payer,
              wallet_id: wallet!.id,
              amount_minor: Number(GROSS),
              currency: 'IRR',
              status: 'RELEASED',
              reference: transactionId,
              reference_type: 'OTHER',
              resolved_journal_id: journalId,
              placed_at: now,
              placed_by: 'itest',
              resolved_at: now,
              ...changes(journalId),
            }),
        },
        HOLD,
      );
    });
  });

  describe('what the migration found stays out of a reversal', () => {
    const frozen = /fixed by its migration/;

    const FROZEN = 'trg_settlement_creation_quarantine_frozen';

    const quarantined = (transactionId: string, table: string, rowId: string) =>
      lifted('settlement_creation_quarantine', FROZEN, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO settlement_creation_quarantine (source_table, row_id, transaction_id, reason)
           VALUES ($1, $2, $3, 'LEGS_DISAGREE')`,
          table,
          rowId,
          transactionId,
        ),
      );

    const unquarantined = (transactionId: string) =>
      lifted('settlement_creation_quarantine', FROZEN, (tx) =>
        tx.$executeRawUnsafe(
          'DELETE FROM settlement_creation_quarantine WHERE transaction_id = $1',
          transactionId,
        ),
      );

    const openCase = (transactionId: string, settlementId: string, caseId = `SRV_${ulid()}`) =>
      owner.$executeRawUnsafe(
        `INSERT INTO settlement_reversal (id, organization_id, transaction_id, settlement_id, source_type, source_reference)
         VALUES ($1, $2, $3, $4, 'MANUAL', $5)`,
        caseId,
        payer,
        transactionId,
        settlementId,
        `RTR_${ulid()}`,
      );

    const settledHere = async () => {
      const transactionId = await pending();
      const result = await settleForReal(transactionId);
      return { transactionId, settlementId: result.settlementId };
    };

    it.each(['settlement', 'commission'])(
      'a case does not open on a quarantined %s',
      async (table) => {
        const { transactionId, settlementId } = await settledHere();
        await quarantined(transactionId, table, settlementId);
        try {
          await expect(openCase(transactionId, settlementId)).rejects.toThrow(
            /could not be proven/,
          );
        } finally {
          await unquarantined(transactionId);
        }
      },
    );

    it('a case already open only ends in a rejection; the rejection itself still goes through', async () => {
      const { transactionId, settlementId } = await settledHere();
      const caseId = `SRV_${ulid()}`;
      await openCase(transactionId, settlementId, caseId);
      await quarantined(transactionId, 'settlement', settlementId);
      try {
        await expect(
          runtime.$executeRawUnsafe(
            `UPDATE settlement_reversal
                SET status = 'PROPOSED', version = version + 1, gross_minor = 1, commission_minor = 0, net_minor = 1,
                    reason = 'the goods came back', evidence_reference = 'TICKET-1', proposed_by = 'a',
                    proposed_by_issuer = 'i', proposed_by_subject = 's', proposed_at = now()
              WHERE id = $1`,
            caseId,
          ),
        ).rejects.toThrow(/could not be proven/);
        await runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'REJECTED', version = version + 1, rejected_by = 'r', rejected_by_issuer = 'i',
                  rejected_by_subject = 'q', rejected_at = now(), rejection_reason = 'nothing to reverse'
            WHERE id = $1`,
          caseId,
        );
      } finally {
        await unquarantined(transactionId);
        await lifted('settlement_reversal', 'trg_settlement_reversal_no_delete', (tx) =>
          tx.$executeRawUnsafe('DELETE FROM settlement_reversal WHERE id = $1', caseId),
        );
      }
    });

    it('the quarantine is frozen, whoever asks', async () => {
      const row = `('settlement', 'STL_X', 'TXN_X', 'LEGS_DISAGREE')`;
      const insert = `INSERT INTO settlement_creation_quarantine (source_table, row_id, transaction_id, reason) VALUES ${row}`;
      await expect(runtime.$executeRawUnsafe(insert)).rejects.toThrow(frozen);
      await expect(owner.$executeRawUnsafe(insert)).rejects.toThrow(frozen);
      await expect(
        // ISOLATION-ALLOW-UNBOUNDED: refused by the trigger under test, and the table is this migration's own.
        owner.$executeRawUnsafe('TRUNCATE settlement_creation_quarantine'),
      ).rejects.toThrow(frozen);
    });

    it('a commission table is not emptied, which its row-level guard never answered', async () => {
      await expect(
        // ISOLATION-ALLOW-UNBOUNDED: refused by the trigger under test, in a transaction rolled back below.
        owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('TRUNCATE commission');
          throw new Error('rolled back: it was not refused');
        }),
      ).rejects.toThrow(/append-only/);
    });
  });
});
