import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { JournalReversalService } from '../src/ledger/journal-reversal.service';
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
 * The storage of a settlement reversal (RLG-002-1; docs/24 Q-76; D-115 A).
 *
 * No service writes these rows yet, so everything here goes straight at the
 * database through the service's own runtime role: these rules have to hold for
 * whatever RLG-002-2 and RLG-002-3 turn out to do, and an owner connection would
 * prove less. The owner is used for fixtures only.
 */
jest.setTimeout(120_000);

type Tx = Prisma.TransactionClient;
interface Settled {
  transactionId: string;
  settlementId: string;
  payeeOrganizationId: string;
}
interface Amounts {
  gross: bigint;
  commission: bigint;
  net: bigint;
}

const GROSS = 10_000n;
const ISSUER = 'http://itest.invalid/realms/rasta';
const PROPOSER = ['USR-RLG-PROPOSER', ISSUER, 'sub-proposer'] as const;
const APPROVER = ['USR-RLG-APPROVER', ISSUER, 'sub-approver'] as const;

const noCommission = (gross: bigint): Amounts => ({ gross, commission: 0n, net: gross });

describe('settlement reversal storage (real database, runtime role)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let runtime: PrismaClient;
  let owner: PrismaClient;
  const org = tenants();
  const payer = `${org.a}-RLG`;
  const payee = `${org.b}-RLG`;
  /** Charged 10% by its own rule: 1,000 of every settlement's {@link GROSS}. */
  const chargedPayee = `${org.b}-RLG-CHARGED`;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    await fundWallet(wiring, payer, 10_000_000n);
    await fundWallet(wiring, payee, 0n);
    await fundWallet(wiring, chargedPayee, 0n);
    await asActor({ organizationId: payer, roles: ['SYSTEM_ADMIN'] }, () =>
      wiring.commissions.createRule({
        organizationId: chargedPayee,
        businessLine: 'PARTS',
        transactionType: 'MARKETPLACE_ORDER',
        rateBasisPoints: 1_000,
        status: 'ACTIVE',
        label: 'itest',
      }),
    );
  });

  afterAll(async () => {
    // A case is never removed; this suite's own go with the guard lifted in one
    // owner transaction, which a crash rolls back.
    await owner.$transaction(async (tx) => {
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction.
      await tx.$executeRawUnsafe(
        'ALTER TABLE settlement_reversal DISABLE TRIGGER trg_settlement_reversal_no_delete',
      );
      await tx.$executeRawUnsafe(
        'DELETE FROM settlement_reversal WHERE organization_id = $1',
        payer,
      );
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(
        'ALTER TABLE settlement_reversal ENABLE TRIGGER trg_settlement_reversal_no_delete',
      );
    });
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
    await runtime.$disconnect();
    await owner.$disconnect();
  });

  /** A really settled transaction, through the service's own settlement path. */
  async function settled(charged = false): Promise<Settled> {
    const payeeOrganizationId = charged ? chargedPayee : payee;
    const transaction = await asActor({ organizationId: payer }, () =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        ...(charged ? { businessLine: 'PARTS' as const } : {}),
        counterpartyOrganizationId: payeeOrganizationId,
        grossAmountMinor: GROSS.toString(),
        currency: 'IRR',
        holdFunds: true,
      }),
    );
    await asActor({ organizationId: payer }, () =>
      wiring.transactions.authoriseSettlement(transaction.id),
    );
    await asActor({ organizationId: payer }, () =>
      wiring.settlements.settle(transaction.id, 'USR-ITEST'),
    );
    const [row] = await owner.$queryRawUnsafe<{ id: string; commission: bigint }[]>(
      'SELECT id, commission_amount_minor AS commission FROM settlement WHERE transaction_id = $1',
      transaction.id,
    );
    expect(row!.commission).toBe(charged ? 1_000n : 0n);
    return { transactionId: transaction.id, settlementId: row!.id, payeeOrganizationId };
  }

  const open = async (
    fixture: Settled,
    overrides: {
      organizationId?: string;
      settlementId?: string;
      status?: string;
      sourceType?: string;
      sourceReference?: string;
      id?: string;
    } = {},
    client: Pick<Tx, '$executeRawUnsafe'> = runtime,
  ): Promise<string> => {
    const id = overrides.id ?? `SRV_${ulid()}`;
    await client.$executeRawUnsafe(
      `INSERT INTO settlement_reversal
         (id, organization_id, transaction_id, settlement_id, source_type, source_reference, status)
       VALUES ($1, $2, $3, $4, $5::"SettlementReversalSource", $6, $7::"SettlementReversalStatus")`,
      id,
      overrides.organizationId ?? payer,
      fixture.transactionId,
      overrides.settlementId ?? fixture.settlementId,
      overrides.sourceType ?? 'RETURN_REQUEST',
      overrides.sourceReference ?? `RTR_${ulid()}`,
      overrides.status ?? 'OPEN',
    );
    return id;
  };

  const propose = (
    id: string,
    amounts: Amounts,
    client: Pick<Tx, '$executeRawUnsafe'> = runtime,
    by: readonly [string, string, string] = PROPOSER,
  ) =>
    client.$executeRawUnsafe(
      `UPDATE settlement_reversal
          SET status = 'PROPOSED', version = version + 1,
              gross_minor = $2::bigint, commission_minor = $3::bigint, net_minor = $4::bigint,
              reason = 'the goods came back', evidence_reference = 'TICKET-1',
              proposed_by = $5, proposed_by_issuer = $6, proposed_by_subject = $7, proposed_at = now()
        WHERE id = $1`,
      id,
      amounts.gross,
      amounts.commission,
      amounts.net,
      ...by,
    );

  /** The account of one organization and purpose; the platform's revenue is whichever a settlement opened. */
  const account = async (tx: Tx, organizationId: string, purpose = 'WALLET', currency = 'IRR') => {
    const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ledger_account
        WHERE organization_id = $1 AND purpose = $2::"AccountPurpose" AND currency = $3`,
      organizationId,
      purpose,
      currency,
    );
    return row!.id;
  };

  const leg = (
    tx: Tx,
    journalId: string,
    accountId: string,
    organizationId: string,
    direction: 'DEBIT' | 'CREDIT',
    amount: bigint,
    currency = 'IRR',
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction,
                                 amount_minor, currency, posted_at)
       VALUES ($1, $2, $3, $4, $5::"EntryDirection", $6::bigint, $7, now())`,
      `ENT_${ulid()}`,
      journalId,
      accountId,
      organizationId,
      direction,
      amount,
      currency,
    );

  const emptyJournal = async (
    tx: Tx,
    transactionId: string,
    options: { type?: string; organizationId?: string } = {},
  ) => {
    const id = `JRN_${ulid()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description,
                            posted_at, posted_by, correlation_id)
       VALUES ($1, $2, $3, $4::"JournalType", 'itest reversal', now(), 'itest', 'itest')`,
      id,
      options.organizationId ?? payer,
      transactionId,
      options.type ?? 'SETTLEMENT_REVERSAL',
    );
    return id;
  };

  /** The reversal's legs (no wallet is recomputed: that is RLG-002-3's, and these rules read the ledger). */
  async function journal(
    tx: Tx,
    fixture: Settled,
    amounts: Amounts,
    options: { type?: string; organizationId?: string; currency?: string } = {},
  ): Promise<string> {
    const id = await emptyJournal(tx, fixture.transactionId, options);
    const { payeeOrganizationId: to } = fixture;
    const { currency = 'IRR' } = options;
    await leg(
      tx,
      id,
      await account(tx, payer, 'WALLET', currency),
      payer,
      'CREDIT',
      amounts.gross,
      currency,
    );
    if (amounts.net > 0n) {
      await leg(
        tx,
        id,
        await account(tx, to, 'WALLET', currency),
        to,
        'DEBIT',
        amounts.net,
        currency,
      );
    }
    if (amounts.commission > 0n) {
      const revenue = await account(tx, PLATFORM_ORGANIZATION_ID, 'COMMISSION_REVENUE');
      await leg(tx, id, revenue, PLATFORM_ORGANIZATION_ID, 'DEBIT', amounts.commission, currency);
    }
    return id;
  }

  const markApplied = (
    tx: Pick<Tx, '$executeRawUnsafe'>,
    id: string,
    journalId: string,
    by: readonly [string, string, string] = APPROVER,
  ) =>
    tx.$executeRawUnsafe(
      `UPDATE settlement_reversal
          SET status = 'APPLIED', version = version + 1, journal_id = $2,
              approved_by = $3, approved_by_issuer = $4, approved_by_subject = $5, approved_at = now()
        WHERE id = $1`,
      id,
      journalId,
      ...by,
    );

  const moveTransaction = (tx: Pick<Tx, '$executeRawUnsafe'>, id: string, status: string) =>
    tx.$executeRawUnsafe(
      `UPDATE "transaction" SET status = $2::"TransactionStatus" WHERE id = $1`,
      id,
      status,
    );

  /** The whole act of RLG-002-3, minus the wallets: journal, then case, then transaction. */
  const apply = async (fixture: Settled, id: string, part: bigint | Amounts, status: string) =>
    runtime.$transaction(async (tx) => {
      const amounts = typeof part === 'bigint' ? noCommission(part) : part;
      const journalId = await journal(tx, fixture, amounts);
      await markApplied(tx, id, journalId);
      await moveTransaction(tx, fixture.transactionId, status);
      return journalId;
    });

  /** A rejection's columns, as one assignment list: `$2`, `$3`, `$4` are the rejecter. */
  const REJECTED_BY = `rejected_by = $2, rejected_by_issuer = $3, rejected_by_subject = $4,
                       rejected_at = now(), rejection_reason = 'the goods did not come back'`;

  const CLEAR_PROPOSAL = `gross_minor = NULL, commission_minor = NULL, net_minor = NULL, reason = NULL,
                          evidence_reference = NULL, proposed_by = NULL, proposed_by_issuer = NULL,
                          proposed_by_subject = NULL, proposed_at = NULL`;

  const statusOf = async (id: string) => {
    const [row] = await owner.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status::text AS status FROM "transaction" WHERE id = $1',
      id,
    );
    return row!.status;
  };

  describe('opening a case', () => {
    it('opens one case per source; another source type is another fact', async () => {
      const fixture = await settled();
      const sourceReference = `RTR_${ulid()}`;
      await open(fixture, { sourceReference });
      await expect(open(fixture, { sourceReference })).rejects.toThrow(/already exists/);
      await expect(open(fixture, { sourceReference, sourceType: 'MANUAL' })).resolves.toEqual(
        expect.any(String),
      );
    });

    it('opens only OPEN', async () => {
      const fixture = await settled();
      await expect(open(fixture, { status: 'PROPOSED' })).rejects.toThrow(/opened OPEN/);
    });

    it("refuses another organization's books, another settlement, and no settlement at all", async () => {
      const fixture = await settled();
      const other = await settled();
      await expect(open(fixture, { organizationId: payee })).rejects.toThrow(/payer's settled/);
      await expect(open(fixture, { settlementId: other.settlementId })).rejects.toThrow(
        /payer's settled/,
      );
      await expect(open(fixture, { settlementId: `STL_${ulid()}` })).rejects.toThrow(
        /payer's settled/,
      );
    });

    it('refuses a transaction that is not settled, whatever its settlement row says', async () => {
      const fixture = await settled();
      // Moved for this one owner transaction: the refusal rolls it back.
      await expect(
        owner.$transaction(async (tx) => {
          await moveTransaction(tx, fixture.transactionId, 'REFUNDED');
          await open(fixture, {}, tx);
        }),
      ).rejects.toThrow(/payer's settled/);
      await expect(statusOf(fixture.transactionId)).resolves.toBe('SETTLED');
    });

    it("refuses a contract statement's obligation: nobody has decided what that means", async () => {
      const fixture = await settled();
      // Turned into a statement's obligation for this one owner transaction: the
      // refusal rolls it back with everything else.
      await expect(
        owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "transaction"
                SET source_type = 'STATEMENT', source_reference = $2, created_by = 'economic-service',
                    transaction_type = 'CONSTRUCTION_STATEMENT', idempotency_key = NULL,
                    causation_id = 'itest'
              WHERE id = $1`,
            fixture.transactionId,
            `STM_${ulid()}`,
          );
          await open(fixture, {}, tx);
        }),
      ).rejects.toThrow(/payer's settled/);
    });

    it('refuses a blank-looking source or an id that is not ours', async () => {
      const fixture = await settled();
      await expect(open(fixture, { sourceReference: ' x y ' })).rejects.toThrow(
        /ck_settlement_reversal_source_reference/,
      );
      await expect(open(fixture, { id: 'TXN_1' })).rejects.toThrow(/ck_settlement_reversal_id/);
    });
  });

  describe('the shape of a proposal', () => {
    it.each<[string, Amounts]>([
      ['gross ≠ commission + net', { gross: 100n, commission: 10n, net: 80n }],
      ['zero gross', { gross: 0n, commission: 0n, net: 0n }],
      ['negative net', { gross: 100n, commission: 200n, net: -100n }],
      ['negative commission', { gross: 100n, commission: -1n, net: 101n }],
    ])('refuses %s', async (_label, amounts) => {
      // A commission to spare, so the row's own arithmetic is what refuses.
      const id = await open(await settled(true));
      await expect(propose(id, amounts)).rejects.toThrow(/ck_settlement_reversal_amounts/);
    });

    it('takes commission zero and net zero (a part small enough to round to one side)', async () => {
      const fixture = await settled(true);
      await expect(
        propose(await open(fixture), { gross: 100n, commission: 0n, net: 100n }),
      ).resolves.toBe(1);
      await expect(
        propose(await open(fixture), { gross: 100n, commission: 100n, net: 0n }),
      ).resolves.toBe(1);
    });

    it('refuses a proposal with an amount or a proposer missing', async () => {
      const id = await open(await settled());
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = 'PROPOSED', version = version + 1,
                  gross_minor = 100, commission_minor = 0, net_minor = 100 WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/ck_settlement_reversal_proposal/);
    });

    it('refuses free text for evidence, and a blank reason', async () => {
      const id = await open(await settled());
      const set = (reason: string, evidence: string, subject: string) =>
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'PROPOSED', version = version + 1, gross_minor = 1, commission_minor = 0,
                  net_minor = 1, reason = $2, evidence_reference = $3, proposed_by = 'u',
                  proposed_by_issuer = 'i', proposed_by_subject = $4, proposed_at = now()
            WHERE id = $1`,
          id,
          reason,
          evidence,
          subject,
        );
      const broken: [string, string, string][] = [
        ['the goods came back', 'see my email please', 's'],
        ['   ', 'TICKET-1', 's'],
        ['the goods came back', 'TICKET-1', ' '],
      ];
      for (const [reason, evidence, subject] of broken) {
        await expect(set(reason, evidence, subject)).rejects.toThrow(/ck_settlement_reversal_text/);
      }
    });
  });

  describe('the transitions', () => {
    /** One case at each status, each reachable only through the legal path. */
    async function caseAt(status: 'OPEN' | 'PROPOSED' | 'APPLIED' | 'REJECTED') {
      const fixture = await settled();
      const id = await open(fixture);
      if (status === 'OPEN') return { fixture, id };
      await propose(id, noCommission(100n));
      if (status === 'APPLIED') await apply(fixture, id, 100n, 'PARTIALLY_REVERSED');
      if (status === 'REJECTED') {
        await runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'REJECTED', version = version + 1, ${REJECTED_BY}
            WHERE id = $1`,
          id,
          ...APPROVER,
        );
      }
      return { fixture, id };
    }

    it.each([
      ['OPEN', 'OPEN'],
      ['OPEN', 'APPLIED'],
      ['PROPOSED', 'PROPOSED'],
    ] as const)('refuses %s → %s', async (from, to) => {
      const { id } = await caseAt(from);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = $2::"SettlementReversalStatus", version = version + 1 WHERE id = $1`,
          id,
          to,
        ),
      ).rejects.toThrow(/moves OPEN to PROPOSED/);
    });

    it.each(['APPLIED', 'REJECTED'] as const)(
      '%s is final: no status, no field, however the version moves',
      async (from) => {
        const { id } = await caseAt(from);
        for (const assignment of [
          `status = 'OPEN', version = version + 1`,
          `status = 'PROPOSED', version = version + 1`,
          `reason = 'rewritten afterwards', version = version + 1`,
          'updated_at = now()',
        ]) {
          await expect(
            runtime.$executeRawUnsafe(
              `UPDATE settlement_reversal SET ${assignment} WHERE id = $1`,
              id,
            ),
          ).rejects.toThrow(/final once applied or rejected/);
        }
      },
    );

    it('returns a rejected proposal to OPEN, cleared, keeping who rejected it and why', async () => {
      const { id } = await caseAt('PROPOSED');
      const back = (assignments: string, ...params: string[]) =>
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = 'OPEN', version = version + 1, ${assignments} WHERE id = $1`,
          id,
          ...params,
        );
      await expect(back(`${REJECTED_BY}`, ...APPROVER)).rejects.toThrow(
        /ck_settlement_reversal_proposal/,
      );
      await expect(back(CLEAR_PROPOSAL)).rejects.toThrow(/rejected by someone named/);
      await back(`${CLEAR_PROPOSAL}, ${REJECTED_BY}`, ...APPROVER);
      await expect(propose(id, noCommission(200n))).resolves.toBe(1);
      const [row] = await owner.$queryRawUnsafe<{ gross: bigint; rejecter: string }[]>(
        'SELECT gross_minor AS gross, rejected_by AS rejecter FROM settlement_reversal WHERE id = $1',
        id,
      );
      expect(row).toEqual({ gross: 200n, rejecter: APPROVER[0] });
      // That rejection is a record now: nothing but a new rejection writes it.
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'OPEN', version = version + 1, ${CLEAR_PROPOSAL}, rejected_at = rejected_at
            WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/rejected by someone named/);
    });

    it('a new proposal cannot rewrite the record of the last rejection', async () => {
      const { id } = await caseAt('PROPOSED');
      await runtime.$executeRawUnsafe(
        `UPDATE settlement_reversal
            SET status = 'OPEN', version = version + 1, ${CLEAR_PROPOSAL}, ${REJECTED_BY} WHERE id = $1`,
        id,
        ...APPROVER,
      );
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'PROPOSED', version = version + 1, gross_minor = 1, commission_minor = 0,
                  net_minor = 1, reason = 'the goods came back', evidence_reference = 'TICKET-1',
                  proposed_by = 'u', proposed_by_issuer = 'i', proposed_by_subject = 's',
                  proposed_at = now(), rejection_reason = 'a nicer reason'
            WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/Only a rejection writes/);
    });

    it('closes an OPEN case nobody will propose, even with nothing left to reverse', async () => {
      const fixture = await settled();
      const [stale, whole] = [await open(fixture), await open(fixture)];
      await propose(whole, noCommission(GROSS));
      await apply(fixture, whole, GROSS, 'REVERSED');
      await expect(propose(stale, noCommission(1n))).rejects.toThrow(/never reversed beyond/);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = 'REJECTED', version = version + 1, ${REJECTED_BY} WHERE id = $1`,
          stale,
          ...PROPOSER,
        ),
      ).resolves.toBe(1);
    });

    it('moves exactly one version at a time: a stale write loses', async () => {
      const { id } = await caseAt('OPEN');
      for (const version of ['version', 'version + 2', 'version - 1']) {
        await expect(
          runtime.$executeRawUnsafe(
            `UPDATE settlement_reversal
                SET status = 'PROPOSED', version = ${version}, gross_minor = 1, commission_minor = 0,
                    net_minor = 1, reason = 'the goods came back', evidence_reference = 'TICKET-1',
                    proposed_by = 'u', proposed_by_issuer = 'i', proposed_by_subject = 's',
                    proposed_at = now()
              WHERE id = $1`,
            id,
          ),
        ).rejects.toThrow(/one version at a time/);
      }
    });

    it.each([
      ['organization_id', `'ORG-ELSEWHERE'`],
      ['transaction_id', `'TXN_ELSEWHERE'`],
      ['settlement_id', `'STL_ELSEWHERE'`],
      ['source_reference', `'RTR_ELSEWHERE'`],
      ['source_type', `'MANUAL'`],
      ['created_at', "now() - interval '1 day'"],
    ])('never changes %s', async (column, value) => {
      const { id } = await caseAt('OPEN');
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET ${column} = ${value}, status = 'PROPOSED', version = version + 1, gross_minor = 1,
                  commission_minor = 0, net_minor = 1, reason = 'the goods came back',
                  evidence_reference = 'TICKET-1', proposed_by = 'u', proposed_by_issuer = 'i',
                  proposed_by_subject = 's', proposed_at = now()
            WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/about never changes/);
    });

    it.each([
      ['gross', 'gross_minor = 99, net_minor = 99'],
      ['commission', 'commission_minor = 1, net_minor = 99'],
      ['reason', `reason = 'something else entirely'`],
      ['evidence', `evidence_reference = 'TICKET-2'`],
      ['proposer', `proposed_by = 'USR-SOMEONE-ELSE'`],
    ])('an approval approves exactly what was proposed: not another %s', async (_l, change) => {
      const { fixture, id } = await caseAt('PROPOSED');
      await expect(
        runtime.$transaction(async (tx) => {
          const journalId = await journal(tx, fixture, noCommission(100n));
          await tx.$executeRawUnsafe(
            `UPDATE settlement_reversal
                SET status = 'APPLIED', version = version + 1, journal_id = $2, approved_by = 'a',
                    approved_by_issuer = $3, approved_by_subject = 'b', approved_at = now(), ${change}
              WHERE id = $1`,
            id,
            journalId,
            ISSUER,
          );
        }),
      ).rejects.toThrow(/exactly what was proposed/);
    });

    it('a case is never removed', async () => {
      const { id } = await caseAt('OPEN');
      await expect(
        runtime.$executeRawUnsafe('DELETE FROM settlement_reversal WHERE id = $1', id),
      ).rejects.toThrow(/never removed/);
    });

    it('a table is never emptied either, by anyone', async () => {
      await expect(
        // ISOLATION-ALLOW-UNBOUNDED: refused by the trigger under test, in a transaction rolled back.
        owner.$executeRawUnsafe('TRUNCATE settlement_reversal'),
      ).rejects.toThrow(/never removed/);
    });
  });

  describe('four-eyes', () => {
    const attempt = async (by: readonly [string, string, string]) => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      return runtime.$transaction(async (tx) => {
        await markApplied(tx, id, await journal(tx, fixture, noCommission(100n)), by);
        await moveTransaction(tx, fixture.transactionId, 'PARTIALLY_REVERSED');
      });
    };

    it.each<[string, readonly [string, string, string]]>([
      ['the same person', PROPOSER],
      ['the same subject under another user id', ['USR-OTHER', PROPOSER[1], PROPOSER[2]]],
      ['the same user id under another subject', [PROPOSER[0], ISSUER, 'sub-other']],
      ['another issuer: not provably someone else', [APPROVER[0], 'http://other', APPROVER[2]]],
      ["a user id naming the proposer's subject", [PROPOSER[2], ISSUER, 'sub-other']],
      ["a subject naming the proposer's user id", ['USR-OTHER', ISSUER, PROPOSER[0]]],
    ])('refuses an approval by %s', async (_label, by) => {
      await expect(attempt(by)).rejects.toThrow(/ck_settlement_reversal_four_eyes/);
    });

    it('takes an approval by someone provably else', async () => {
      await expect(attempt(APPROVER)).resolves.toBeUndefined();
    });

    it.each<[string, readonly [string, string, string]]>([
      ['the same person', PROPOSER],
      ['the same subject under another user id', ['USR-OTHER', PROPOSER[1], PROPOSER[2]]],
      ['the same user id under another subject', [PROPOSER[0], ISSUER, 'sub-other']],
      ["a user id naming the proposer's subject", [PROPOSER[2], ISSUER, 'sub-other']],
      ["a subject naming the proposer's user id", ['USR-OTHER', ISSUER, PROPOSER[0]]],
    ])('refuses a rejection, final or back to OPEN, by %s', async (_label, by) => {
      const id = await open(await settled());
      await propose(id, noCommission(100n));
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = 'REJECTED', version = version + 1, ${REJECTED_BY} WHERE id = $1`,
          id,
          ...by,
        ),
      ).rejects.toThrow(/not its proposer/);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'OPEN', version = version + 1, ${CLEAR_PROPOSAL}, ${REJECTED_BY} WHERE id = $1`,
          id,
          ...by,
        ),
      ).rejects.toThrow(/not its proposer/);
    });

    it('takes a rejection from another issuer: it moves nothing, so no proof of two people', async () => {
      const id = await open(await settled());
      await propose(id, noCommission(100n));
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal SET status = 'REJECTED', version = version + 1, ${REJECTED_BY} WHERE id = $1`,
          id,
          'USR-OTHER',
          'http://other',
          'sub-other',
        ),
      ).resolves.toBe(1);
    });

    it('an approver is named in full, and only on an applied case', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      await expect(
        runtime.$transaction(async (tx) => {
          const journalId = await journal(tx, fixture, noCommission(100n));
          await tx.$executeRawUnsafe(
            `UPDATE settlement_reversal SET status = 'APPLIED', version = version + 1, journal_id = $2 WHERE id = $1`,
            id,
            journalId,
          );
        }),
      ).rejects.toThrow(/ck_settlement_reversal_approval/);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'OPEN', version = version + 1, ${CLEAR_PROPOSAL}, ${REJECTED_BY},
                  approved_by = 'someone' WHERE id = $1`,
          id,
          ...APPROVER,
        ),
      ).rejects.toThrow(/ck_settlement_reversal_approval/);
    });

    it('a rejection is named in full', async () => {
      const id = await open(await settled());
      await propose(id, noCommission(100n));
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'REJECTED', version = version + 1, rejected_by = 'someone', rejected_at = now()
            WHERE id = $1`,
          id,
        ),
      ).rejects.toThrow(/ck_settlement_reversal_rejection/);
    });

    it.each([
      ['blank rejecter', ' ', 'the goods did not come back'],
      ['blank reason', 'USR-X', '   '],
    ])('refuses a rejection with a %s', async (_label, by, reason) => {
      const id = await open(await settled());
      await propose(id, noCommission(100n));
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'REJECTED', version = version + 1, rejected_by = $2, rejected_by_issuer = 'i',
                  rejected_by_subject = 's', rejected_at = now(), rejection_reason = $3
            WHERE id = $1`,
          id,
          by,
          reason,
        ),
      ).rejects.toThrow(/ck_settlement_reversal_text/);
    });
  });

  describe('the cumulative cap (D-115 A)', () => {
    it('refuses a proposal beyond the settlement, and beyond what remains', async () => {
      const fixture = await settled();
      await expect(propose(await open(fixture), noCommission(GROSS + 1n))).rejects.toThrow(
        /never reversed beyond/,
      );
      const first = await open(fixture);
      await propose(first, noCommission(6_000n));
      await apply(fixture, first, 6_000n, 'PARTIALLY_REVERSED');
      await expect(propose(await open(fixture), noCommission(4_001n))).rejects.toThrow(
        /never reversed beyond/,
      );
      await expect(propose(await open(fixture), noCommission(4_000n))).resolves.toBe(1);
    });

    it('refuses an over-reversal at the approval, though each proposal fitted when made', async () => {
      const fixture = await settled();
      const [a, b] = [await open(fixture), await open(fixture)];
      await propose(a, noCommission(6_000n));
      await propose(b, noCommission(6_000n));
      await apply(fixture, a, 6_000n, 'PARTIALLY_REVERSED');
      await expect(apply(fixture, b, 6_000n, 'REVERSED')).rejects.toThrow(/never reversed beyond/);
      expect(await statusOf(fixture.transactionId)).toBe('PARTIALLY_REVERSED');
    });

    it('caps commission and net, not only gross', async () => {
      const fixture = await settled(true);
      await expect(
        propose(await open(fixture), { gross: 2_000n, commission: 1_001n, net: 999n }),
      ).rejects.toThrow(/never reversed beyond/);
      await expect(
        propose(await open(fixture), { gross: 9_500n, commission: 0n, net: 9_500n }),
      ).rejects.toThrow(/never reversed beyond/);
    });

    it('two concurrent approvals: the second waits for the first, then sees it', async () => {
      const fixture = await settled();
      const [a, b] = [await open(fixture), await open(fixture)];
      await propose(a, noCommission(6_000n));
      await propose(b, noCommission(6_000n));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding!: () => void;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const options = { timeout: 30_000, maxWait: 30_000 };
      const first = runtime.$transaction(async (tx) => {
        await markApplied(tx, a, await journal(tx, fixture, noCommission(6_000n)));
        await moveTransaction(tx, fixture.transactionId, 'PARTIALLY_REVERSED');
        holding();
        await gate;
      }, options);
      await held;
      const second = runtime.$transaction(async (tx) => {
        await markApplied(tx, b, await journal(tx, fixture, noCommission(6_000n)));
        await moveTransaction(tx, fixture.transactionId, 'REVERSED');
      }, options);
      const outcome = second.then(
        () => null,
        (error: Error) => error.message,
      );

      // The second is really waiting on the row, or this proves nothing.
      for (let tries = 0; ; tries += 1) {
        // Through the same role: another role's query text reads NULL here.
        const [{ waiting }] = await runtime.$queryRawUnsafe<{ waiting: bigint }[]>(
          `SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database()
              AND query LIKE '%settlement_reversal%'`,
        );
        if (waiting > 0n) break;
        if (tries > 100) throw new Error('the second approval never waited for the lock');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await first;
      expect(await outcome).toMatch(/never reversed beyond/);
      expect(await statusOf(fixture.transactionId)).toBe('PARTIALLY_REVERSED');
    });

    it.each(['RepeatableRead', 'Serializable'] as const)(
      'refuses %s: a snapshot older than the lock would read a stale sum',
      async (isolationLevel) => {
        const id = await open(await settled());
        await expect(
          runtime.$transaction((tx) => propose(id, noCommission(100n), tx), { isolationLevel }),
        ).rejects.toThrow(/only under READ COMMITTED/);
      },
    );
  });

  describe('the transaction follows the money', () => {
    it('walks SETTLED → PARTIALLY_REVERSED → PARTIALLY_REVERSED → REVERSED, the remainder last', async () => {
      const fixture = await settled(true);
      const parts: [Amounts, string][] = [
        [{ gross: 3_333n, commission: 333n, net: 3_000n }, 'PARTIALLY_REVERSED'],
        [{ gross: 3_333n, commission: 333n, net: 3_000n }, 'PARTIALLY_REVERSED'],
        [{ gross: 3_334n, commission: 334n, net: 3_000n }, 'REVERSED'],
      ];
      for (const [amounts, status] of parts) {
        const id = await open(fixture);
        await propose(id, amounts);
        await apply(fixture, id, amounts, status);
        expect(await statusOf(fixture.transactionId)).toBe(status);
      }
      // Nothing remains, so nothing more opens.
      await expect(open(fixture)).rejects.toThrow(/payer's settled/);
    });

    it('a reversed transaction still says when it settled, and its figures still add up', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      await apply(fixture, id, 100n, 'PARTIALLY_REVERSED');
      for (const assignment of ['settled_at = NULL', 'net_amount_minor = 1']) {
        await expect(
          runtime.$executeRawUnsafe(
            `UPDATE "transaction" SET ${assignment} WHERE id = $1`,
            fixture.transactionId,
          ),
        ).rejects.toThrow(/ck_transaction_reversed_settled/);
      }
    });

    it('a last reversal that would leave a commission remainder behind cannot fit', async () => {
      // gross is exhausted only when commission and net are too (the caps).
      const fixture = await settled(true);
      await expect(
        propose(await open(fixture), { gross: GROSS, commission: 999n, net: 9_001n }),
      ).rejects.toThrow(/never reversed beyond/);
    });

    it.each(['PARTIALLY_REVERSED', 'REVERSED'])(
      'refuses %s with no applied reversal behind it',
      async (status) => {
        const fixture = await settled();
        await expect(moveTransaction(runtime, fixture.transactionId, status)).rejects.toThrow(
          /as far as its applied reversals say/,
        );
        // A proposal is not money.
        await propose(await open(fixture), noCommission(GROSS));
        await expect(moveTransaction(runtime, fixture.transactionId, status)).rejects.toThrow(
          /as far as its applied reversals say/,
        );
      },
    );

    it('refuses REVERSED short of the gross, and PARTIALLY_REVERSED at it', async () => {
      const part = await settled();
      const a = await open(part);
      await propose(a, noCommission(100n));
      await expect(apply(part, a, 100n, 'REVERSED')).rejects.toThrow(
        /as far as its applied reversals say/,
      );
      const whole = await settled();
      const b = await open(whole);
      await propose(b, noCommission(GROSS));
      await expect(apply(whole, b, GROSS, 'PARTIALLY_REVERSED')).rejects.toThrow(
        /as far as its applied reversals say/,
      );
    });

    it('does not let an unsettled transaction become reversed', async () => {
      const held = await asActor({ organizationId: payer }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '100',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await expect(moveTransaction(runtime, held.id, 'REVERSED')).rejects.toThrow(
        /Only a settled transaction is reversed/,
      );
    });

    it('does not let a transaction be born reversed', async () => {
      const fixture = await settled();
      await expect(
        runtime.$executeRawUnsafe(
          `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id, transaction_type,
                                      status, gross_amount_minor, currency, occurred_at, correlation_id,
                                      created_by, updated_at)
           SELECT $2, organization_id, counterparty_organization_id, transaction_type,
                  'REVERSED'::"TransactionStatus", gross_amount_minor, currency, occurred_at,
                  correlation_id, created_by, now()
             FROM "transaction" WHERE id = $1`,
          fixture.transactionId,
          `TXN_${ulid()}`,
        ),
      ).rejects.toThrow(/Only a settled transaction is reversed/);
    });

    it.each(['SETTLED', 'PENDING_SETTLEMENT', 'HELD', 'REFUNDED'])(
      'a reversed transaction never returns to %s',
      async (status) => {
        const fixture = await settled();
        const id = await open(fixture);
        await propose(id, noCommission(GROSS));
        await apply(fixture, id, GROSS, 'REVERSED');
        await expect(moveTransaction(runtime, fixture.transactionId, status)).rejects.toThrow(
          /never leaves its reversal/,
        );
      },
    );

    it('an applied case whose transaction did not move does not commit', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      await expect(
        runtime.$transaction(async (tx) => {
          await markApplied(tx, id, await journal(tx, fixture, noCommission(100n)));
        }),
      ).rejects.toThrow(/moves its transaction with it/);
      expect(await statusOf(fixture.transactionId)).toBe('SETTLED');
    });
  });

  describe('the journal', () => {
    const appliedWith = async (
      journalOf: (tx: Tx, fixture: Settled) => Promise<string>,
      options: { charged?: boolean; amounts?: Amounts } = {},
    ) => {
      const fixture = await settled(options.charged);
      const id = await open(fixture);
      await propose(id, options.amounts ?? noCommission(100n));
      return runtime.$transaction(async (tx) => {
        await markApplied(tx, id, await journalOf(tx, fixture));
        await moveTransaction(tx, fixture.transactionId, 'PARTIALLY_REVERSED');
      });
    };
    const refused = /its own journal, whose legs are the reversal/;
    const hundred = noCommission(100n);

    it('takes the journal the reversal is, commission leg included', async () => {
      const amounts = { gross: 1_000n, commission: 100n, net: 900n };
      await expect(
        appliedWith((tx, fixture) => journal(tx, fixture, amounts), { charged: true, amounts }),
      ).resolves.toBeUndefined();
    });

    it('refuses a journal of another type', async () => {
      await expect(
        appliedWith((tx, fixture) => journal(tx, fixture, hundred, { type: 'WALLET_TOP_UP' })),
      ).rejects.toThrow(refused);
    });

    it("refuses another transaction's journal, or another organization's", async () => {
      const other = await settled();
      await expect(appliedWith((tx) => journal(tx, other, hundred))).rejects.toThrow(refused);
      await expect(
        appliedWith((tx, fixture) => journal(tx, fixture, hundred, { organizationId: payee })),
      ).rejects.toThrow(refused);
    });

    it('refuses a journal crediting more or less than the gross', async () => {
      for (const credit of [99n, 101n]) {
        await expect(
          appliedWith((tx, fixture) => journal(tx, fixture, noCommission(credit))),
        ).rejects.toThrow(refused);
      }
    });

    it('refuses a journal in another currency, on real accounts of both parties', async () => {
      for (const organizationId of [payer, payee]) {
        await owner.$executeRawUnsafe(
          `INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
           SELECT $1, organization_id, account_type, account_code, purpose, 'USD', created_by
             FROM ledger_account
            WHERE organization_id = $2 AND purpose = 'WALLET' AND currency = 'IRR'`,
          `ACC_${ulid()}`,
          organizationId,
        );
      }
      await expect(
        appliedWith((tx, fixture) => journal(tx, fixture, hundred, { currency: 'USD' })),
      ).rejects.toThrow(refused);
    });

    it('refuses money moving the wrong way: from the payer to the payee', async () => {
      await expect(
        appliedWith(async (tx, fixture) => {
          const id = await emptyJournal(tx, fixture.transactionId);
          await leg(tx, id, await account(tx, payer), payer, 'DEBIT', 100n);
          await leg(tx, id, await account(tx, payee), payee, 'CREDIT', 100n);
          return id;
        }),
      ).rejects.toThrow(refused);
    });

    it('refuses money going to a third wallet, or coming from one', async () => {
      const accomplice = chargedPayee;
      await expect(
        appliedWith(async (tx, fixture) => {
          const id = await emptyJournal(tx, fixture.transactionId);
          await leg(tx, id, await account(tx, accomplice), accomplice, 'CREDIT', 100n);
          await leg(tx, id, await account(tx, payee), payee, 'DEBIT', 100n);
          return id;
        }),
      ).rejects.toThrow(refused);
      await expect(
        appliedWith(async (tx, fixture) => {
          const id = await emptyJournal(tx, fixture.transactionId);
          await leg(tx, id, await account(tx, payer), payer, 'CREDIT', 100n);
          await leg(tx, id, await account(tx, accomplice), accomplice, 'DEBIT', 100n);
          return id;
        }),
      ).rejects.toThrow(refused);
    });

    it('refuses legs that do not say what the case says about commission', async () => {
      const amounts = { gross: 1_000n, commission: 100n, net: 900n };
      await expect(
        // The payee debited the whole gross, the platform's revenue untouched.
        appliedWith((tx, fixture) => journal(tx, fixture, noCommission(1_000n)), {
          charged: true,
          amounts,
        }),
      ).rejects.toThrow(refused);
    });

    it('refuses a further leg once the case names the journal, in or after that transaction', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, hundred);
      // The attack: legs that pass the check, then balanced legs that move the
      // payer's money to a third party before commit.
      await expect(
        runtime.$transaction(async (tx) => {
          const journalId = await journal(tx, fixture, hundred);
          await markApplied(tx, id, journalId);
          await moveTransaction(tx, fixture.transactionId, 'PARTIALLY_REVERSED');
          await leg(tx, journalId, await account(tx, payer), payer, 'DEBIT', 5_000n);
          await leg(tx, journalId, await account(tx, chargedPayee), chargedPayee, 'CREDIT', 5_000n);
        }),
      ).rejects.toThrow(/takes no leg once its reversal names it/);
      await expect(statusOf(fixture.transactionId)).resolves.toBe('SETTLED');
    });

    it('refuses a case applied with no journal named', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement_reversal
              SET status = 'APPLIED', version = version + 1, approved_by = $2,
                  approved_by_issuer = $3, approved_by_subject = $4, approved_at = now()
            WHERE id = $1`,
          id,
          ...APPROVER,
        ),
      ).rejects.toThrow(refused);
    });

    it('one journal backs one reversal', async () => {
      const fixture = await settled();
      const [a, b] = [await open(fixture), await open(fixture)];
      await propose(a, noCommission(100n));
      await propose(b, noCommission(100n));
      const journalId = await apply(fixture, a, 100n, 'PARTIALLY_REVERSED');
      await expect(markApplied(runtime, b, journalId)).rejects.toThrow(/already exists/);
    });

    it('no SETTLEMENT_REVERSAL journal commits without the applied case that names it', async () => {
      const fixture = await settled();
      await expect(
        runtime.$transaction((tx) => journal(tx, fixture, noCommission(100n))),
      ).rejects.toThrow(/only for the applied reversal/);
      const [{ count }] = await owner.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) FROM journal WHERE transaction_id = $1 AND journal_type::text = 'SETTLEMENT_REVERSAL'`,
        fixture.transactionId,
      );
      expect(count).toBe(0n);
    });

    it('no ledger reversal undoes one, by SQL either', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      const journalId = await apply(fixture, id, 100n, 'PARTIALLY_REVERSED');
      await expect(
        runtime.$executeRawUnsafe(
          `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description, posted_at,
                                posted_by, correlation_id, reverses_id, reversal_reason)
           VALUES ($1, $2, $3, 'REVERSAL', 'undo', now(), 'itest', 'itest', $4, 'an attempt')`,
          `JRN_${ulid()}`,
          payer,
          fixture.transactionId,
          journalId,
        ),
      ).rejects.toThrow(/no ledger reversal undoes one/);
    });

    it('the generic reversal refuses to undo one, and writes nothing', async () => {
      const fixture = await settled();
      const id = await open(fixture);
      await propose(id, noCommission(100n));
      const journalId = await apply(fixture, id, 100n, 'PARTIALLY_REVERSED');
      const reversals = new JournalReversalService(
        prisma,
        wiring.ledger,
        wiring.walletRepository,
        wiring.transactionRepository,
      );
      await expect(
        asActor({ organizationId: payer, roles: ['SYSTEM_ADMIN'] }, () =>
          reversals.reverse(journalId, 'an attempt to undo the reversal'),
        ),
      ).rejects.toThrow(/SETTLEMENT_REVERSAL journal is not reversed through the ledger/);
      const [{ count }] = await owner.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*) FROM journal WHERE reverses_id = $1',
        journalId,
      );
      expect(count).toBe(0n);
    });
  });

  describe('what the cap is measured against', () => {
    it.each([
      [
        'gross',
        'gross_amount_minor = gross_amount_minor * 2, net_amount_minor = net_amount_minor * 2',
      ],
      ['gross, downwards', 'gross_amount_minor = 100, net_amount_minor = 100'],
      ['commission', 'commission_amount_minor = 1, net_amount_minor = net_amount_minor - 1'],
      ['payee', `payee_organization_id = 'ORG-ELSEWHERE'`],
      ['payer', `payer_organization_id = 'ORG-ELSEWHERE'`],
      ['transaction', `transaction_id = 'TXN_ELSEWHERE'`],
      ['journal', `journal_id = 'JRN_ELSEWHERE'`],
      ['currency', `currency = 'USD'`],
    ])('a settlement never changes its %s', async (_label, assignment) => {
      const fixture = await settled();
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE settlement SET ${assignment} WHERE id = $1`,
          fixture.settlementId,
        ),
      ).rejects.toThrow(/parties and figures never change/);
    });

    it('a settlement with a case behind it is never deleted', async () => {
      const fixture = await settled();
      await open(fixture);
      await expect(
        runtime.$executeRawUnsafe('DELETE FROM settlement WHERE id = $1', fixture.settlementId),
      ).rejects.toThrow(/settlement_reversal_settlement_id_fkey|Foreign key/i);
    });
  });

  describe('tenancy', () => {
    it('another organization neither reads a case nor writes it through the guarded client', async () => {
      const id = await open(await settled());
      const other = `${org.c}-RLG`;
      await expect(
        asActor({ organizationId: other }, () =>
          prisma.client.settlementReversal.findMany({ where: { id } }),
        ),
      ).resolves.toEqual([]);
      await expect(
        asActor({ organizationId: other }, () =>
          prisma.client.settlementReversal.updateMany({ where: { id }, data: { version: 2 } }),
        ),
      ).resolves.toEqual({ count: 0 });
      const own = await asActor({ organizationId: payer }, () =>
        prisma.client.settlementReversal.findMany({ where: { id } }),
      );
      expect(own.map((row) => row.id)).toEqual([id]);
      const everyone = await runUnscoped('the suite counts one case across the table', () =>
        prisma.client.settlementReversal.count({ where: { id } }),
      );
      expect(everyone).toBe(1);
    });
  });
});
