import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { PaymentService, REFUND_HOLD_REFERENCE_TYPE } from '../src/payment/payment.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { HOLD_NOT_FUNDED } from '../src/wallet/wallet.service';
import {
  asActor,
  bareObligation,
  cleanup,
  coverByHand,
  databaseUrl,
  fundWallet,
  newPrisma,
  ownerDatabaseUrl,
  plantPaymentIntent,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Funding is money that is there, once, in the wallet's currency (#859 r1, F1;
 * migration 20261106130000_transaction_funded_hold).
 *
 * Holds and journals are written by hand, because only a row no service writes can be
 * any of these. The owner plants them; the runtime role is who then tries to rewrite them.
 */
jest.setTimeout(120_000);

const AMOUNT = 7000n;
const TERMS_FIXED = /What a hold holds, and the journal that funded it, never change/;
const FINAL = /A resolved hold is final/;
const NEVER_FUNDED = /A hold never funded moves no money/;
const WHOSE_FIXED = /Whose a hold is and what it is for never changes/;
const AT_COMMIT = /At commit, a hold that names a journal or is resolved is funded by it/;
const LEG_REFUSED = /A journal takes no leg once a hold names it/;
const NEVER_REVERSED = /A journal a hold names is never reversed/;

type Raw = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

interface Leg {
  purpose: 'ESCROW' | 'WALLET' | 'PAYMENT_CLEARING' | 'REWARD_EXPENSE' | 'COMMISSION_REVENUE';
  direction: 'DEBIT' | 'CREDIT';
  amount?: bigint;
  /** Whose account: the payer's unless named. */
  organizationId?: string;
}

/** What `placeHold` posts: the wallet debited and escrow credited, by the amount. */
const INTO_ESCROW: Leg[] = [
  { purpose: 'WALLET', direction: 'DEBIT' },
  { purpose: 'ESCROW', direction: 'CREDIT' },
];

describe('funding is money that is there, once, in the wallet’s currency (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  let owner: PrismaClient;
  /** A second owner connection: the other side of a race. */
  let other: PrismaClient;
  let runtime: PrismaClient;
  let walletId: string;
  const org = tenants();
  const payer = `${org.a}-FUNDING`;

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    provider = new MockPaymentProvider();
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      provider,
      wiring.paymentReconciliation,
      testEnv(),
    );
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    other = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    ({ walletId } = await fundWallet(wiring, payer, 50_000_000n));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a]);
    await prisma.onModuleDestroy();
    await owner.$disconnect();
    await other.$disconnect();
    await runtime.$disconnect();
  });

  /** The account, and its organization: a platform purpose is the platform's (`ownerOf`). */
  const accountOf = (purpose: Leg['purpose'], currency: string, organizationId = payer) =>
    asActor({ organizationId }, () =>
      wiring.prisma.transaction((tx) =>
        wiring.ledger.resolveAccount(tx, purpose, organizationId, currency, 'itest'),
      ),
    );

  /** Legs onto a journal `tx` opened: what `trg_ledger_entry_open_journal` still lets in. */
  const writeLegs = async (
    tx: Raw,
    journalId: string,
    legs: Leg[],
    { amount = AMOUNT, currency = 'IRR' } = {},
  ) => {
    for (const leg of legs) {
      const account = await accountOf(leg.purpose, currency, leg.organizationId);
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         VALUES ($1, $2, $3, $4, $5::"EntryDirection", $6, $7, now())`,
        `LGE_${ulid()}`,
        journalId,
        account.id,
        account.organizationId,
        leg.direction,
        leg.amount ?? amount,
        currency,
      );
    }
  };

  const writeJournal = async (
    tx: Raw,
    transactionId: string,
    { legs = INTO_ESCROW, amount = AMOUNT, currency = 'IRR', type = 'FUNDS_HELD' } = {},
  ) => {
    const journalId = `JRN_${ulid()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description, posted_at, posted_by, correlation_id)
       VALUES ($1, $2, $3, $4::"JournalType", 'planted by the suite', now(), 'itest', 'itest')`,
      journalId,
      payer,
      transactionId,
      type,
    );
    await writeLegs(tx, journalId, legs, { amount, currency });
    return journalId;
  };

  const plantJournal = async (
    transactionId: string,
    options: Parameters<typeof writeJournal>[2] = {},
  ) => {
    // A wallet or escrow it debits holds the money first (FU-228): what is asked here is where
    // the money came from, not whether it was there.
    for (const leg of options.legs ?? INTO_ESCROW) {
      if (leg.direction !== 'DEBIT') continue;
      const account = await accountOf(leg.purpose, options.currency ?? 'IRR', leg.organizationId);
      await coverByHand(account.id, leg.amount ?? options.amount ?? AMOUNT);
    }
    return owner.$transaction((tx) => writeJournal(tx, transactionId, options));
  };

  const plantHold = async (
    reference: string,
    journalId: string | null,
    { type = 'TRANSACTION', amount = AMOUNT, currency = 'IRR' } = {},
    client: Raw = owner,
  ) => {
    const holdId = `HLD_${ulid()}`;
    await client.$executeRawUnsafe(
      `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                reference_type, placed_journal_id, placed_at, placed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'itest')`,
      holdId,
      payer,
      walletId,
      amount,
      currency,
      reference,
      type,
      journalId,
    );
    return holdId;
  };

  const funded = async (holdId: string) => {
    const [row] = await runtime.$queryRawUnsafe<{ funded: boolean }[]>(
      'SELECT wallet_hold_funded($1) AS funded',
      holdId,
    );
    return row!.funded;
  };

  /**
   * The predicate's answer for a hold planted by hand, read in the transaction that plants it; and
   * that transaction commits exactly when the answer is yes (`trg_wallet_hold_funded_at_commit`).
   */
  const plantedFunded = async (
    reference: string,
    journalId: string | null,
    options: Parameters<typeof plantHold>[2] = {},
  ) => {
    let seen: boolean | undefined;
    const outcome = await owner
      .$transaction(async (tx) => {
        const holdId = await plantHold(reference, journalId, options, tx);
        const [row] = await tx.$queryRawUnsafe<{ funded: boolean }[]>(
          'SELECT wallet_hold_funded($1) AS funded',
          holdId,
        );
        seen = row!.funded;
      })
      .then(
        () => null,
        (error: Error) => error,
      );
    if (seen) expect(outcome).toBeNull();
    else expect(outcome?.message).toMatch(AT_COMMIT);
    return seen;
  };

  const obligation = () => bareObligation(prisma, payer);

  /** A hold exactly as `placeHold` would write it, by hand: what a row below changes one thing of. */
  const fundedHold = async () => {
    const reference = await obligation();
    const journalId = await plantJournal(reference);
    const holdId = await plantHold(reference, journalId);
    expect(await funded(holdId)).toBe(true);
    return { reference, journalId, holdId };
  };

  /** As a refund resolves it: REFUNDED, by a journal returning the amount. */
  const resolve = async (holdId: string) => {
    const [hold] = await owner.$queryRawUnsafe<{ reference: string }[]>(
      'SELECT reference FROM wallet_hold WHERE id = $1',
      holdId,
    );
    const journalId = await plantJournal(hold!.reference, {
      type: 'FUNDS_REFUNDED',
      legs: [
        { purpose: 'ESCROW', direction: 'DEBIT' },
        { purpose: 'WALLET', direction: 'CREDIT' },
      ],
    });
    await owner.$executeRawUnsafe(
      `UPDATE wallet_hold SET status = 'REFUNDED', resolved_at = now(), resolved_by = 'itest',
              resolved_journal_id = $2 WHERE id = $1`,
      holdId,
      journalId,
    );
    return journalId;
  };

  const holdRow = async (holdId: string) => {
    const [row] = await owner.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM wallet_hold WHERE id = $1',
      holdId,
    );
    return row!;
  };

  /** A captured top-up, through the service: what a refund hold's journal has to name. */
  const toppedUp = async (amount = AMOUNT, organizationId = payer, wallet = walletId) => {
    const { paymentIntentId } = await asActor({ organizationId }, () =>
      payments.topUp(wallet, { amountMinor: amount.toString(), idempotencyKey: ulid() }),
    );
    const intent = await runUnscoped('the suite reads the intent it created', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: paymentIntentId } }),
    );
    return { intentId: paymentIntentId, transactionId: intent.transactionId! };
  };

  const refund = (intentId: string) =>
    asActor({ organizationId: payer }, () => payments.refund(intentId, 'itest'));

  const intentState = (intentId: string) =>
    runUnscoped('the suite reads the intent and what hangs off it', async () => ({
      intent: await prisma.client.paymentIntent.findUniqueOrThrow({
        where: { id: intentId },
        select: { status: true, failureReason: true },
      }),
      holds: await prisma.client.walletHold.count({ where: { reference: intentId } }),
      tasks: await prisma.client.paymentReconciliationTask.count({
        where: { paymentIntentId: intentId },
      }),
    }));

  const spyOnRefund = () => jest.spyOn(provider, 'refund');

  describe('the journal has to move the money', () => {
    it('crediting and debiting its own escrow moves nothing, and funds nothing', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference, {
        legs: [
          { purpose: 'ESCROW', direction: 'CREDIT' },
          { purpose: 'ESCROW', direction: 'DEBIT' },
        ],
      });
      expect(await plantedFunded(reference, journalId)).toBe(false);
    });

    it.each<[string, Leg[], boolean]>([
      [
        'net of the hold’s amount, in several legs: funded',
        [
          { purpose: 'ESCROW', direction: 'CREDIT', amount: AMOUNT * 2n },
          { purpose: 'ESCROW', direction: 'DEBIT', amount: AMOUNT },
          { purpose: 'WALLET', direction: 'DEBIT', amount: AMOUNT },
        ],
        true,
      ],
      [
        'credited with the amount but debited back in part: not funded',
        [
          { purpose: 'ESCROW', direction: 'CREDIT', amount: AMOUNT },
          { purpose: 'ESCROW', direction: 'DEBIT', amount: 1n },
          { purpose: 'WALLET', direction: 'DEBIT', amount: AMOUNT - 1n },
        ],
        false,
      ],
      [
        'more than the hold’s amount: not funded',
        [
          { purpose: 'ESCROW', direction: 'CREDIT', amount: AMOUNT + 1n },
          { purpose: 'WALLET', direction: 'DEBIT', amount: AMOUNT + 1n },
        ],
        false,
      ],
    ])('%s', async (_label, legs, expected) => {
      const reference = await obligation();
      const journalId = await plantJournal(reference, { legs });
      expect(await plantedFunded(reference, journalId)).toBe(expected);
    });
  });

  describe('a resolved hold is final', () => {
    it('is not made ACTIVE again, by any role, and stays as it was', async () => {
      const { holdId } = await fundedHold();
      await resolve(holdId);
      const before = await holdRow(holdId);
      for (const client of [runtime, owner]) {
        await expect(
          client.$executeRawUnsafe(
            `UPDATE wallet_hold SET status = 'ACTIVE', resolved_at = NULL, resolved_by = NULL,
                    resolved_journal_id = NULL WHERE id = $1`,
            holdId,
          ),
        ).rejects.toThrow(FINAL);
      }
      expect(await holdRow(holdId)).toEqual(before);
    });

    it.each([
      `status = 'RELEASED'`,
      `resolved_journal_id = 'JRN_ELSEWHERE'`,
      `resolved_by = 'someone else'`,
      `resolution_note = 'said afterwards'`,
    ])('%s is refused', async (assignment) => {
      const { holdId } = await fundedHold();
      await resolve(holdId);
      await expect(
        runtime.$executeRawUnsafe(`UPDATE wallet_hold SET ${assignment} WHERE id = $1`, holdId),
      ).rejects.toThrow(FINAL);
    });

    it('a retry is a new hold with a new journal, and the provider declining twice returns each', async () => {
      const made = await toppedUp();
      const decline = () =>
        spyOnRefund().mockResolvedValueOnce({
          outcome: 'FAILED',
          failureCode: 'DECLINED_BY_ISSUER',
        } as never);
      decline();
      await expect(refund(made.intentId)).rejects.toThrow();
      const [first] = await owner.$queryRawUnsafe<
        { id: string; placed_journal_id: string; status: string }[]
      >(
        'SELECT id, placed_journal_id, status::text AS status FROM wallet_hold WHERE reference = $1',
        made.intentId,
      );
      expect(first!.status).toBe('REFUNDED');
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE wallet_hold SET status = 'ACTIVE', resolved_at = NULL, resolved_by = NULL,
                  resolved_journal_id = NULL WHERE id = $1`,
          first!.id,
        ),
      ).rejects.toThrow(FINAL);

      await refund(made.intentId);
      const holds = await owner.$queryRawUnsafe<
        { id: string; placed_journal_id: string; status: string }[]
      >(
        'SELECT id, placed_journal_id, status::text AS status FROM wallet_hold WHERE reference = $1 ORDER BY placed_at',
        made.intentId,
      );
      expect(holds).toHaveLength(2);
      expect(holds.map((hold) => hold.status)).toEqual(['REFUNDED', 'REFUNDED']);
      expect(holds[1]!.placed_journal_id).not.toBe(holds[0]!.placed_journal_id);
    });

    it('nor is a hold inserted resolved, unless a journal funded it', async () => {
      const reference = await obligation();
      const resolvedJournal = await plantJournal(reference, { type: 'FUNDS_REFUNDED' });
      const insert = (journalId: string | null) =>
        owner.$executeRawUnsafe(
          `INSERT INTO wallet_hold (id, organization_id, wallet_id, amount_minor, currency, reference,
                                    reference_type, status, placed_journal_id, placed_at, placed_by,
                                    resolved_at, resolved_by, resolved_journal_id)
           VALUES ($1, $2, $3, $4, 'IRR', $5, 'TRANSACTION', 'REFUNDED', $6, now(), 'itest', now(), 'itest', $7)`,
          `HLD_${ulid()}`,
          payer,
          walletId,
          AMOUNT,
          reference,
          journalId,
          resolvedJournal,
        );
      await expect(insert(null)).rejects.toThrow(NEVER_FUNDED);
      await expect(insert(await plantJournal(reference))).resolves.toBe(1);
    });
  });

  describe('a journal backs one hold, for good', () => {
    it.each([
      ['still active', false],
      ['consumed by a hold since resolved', true],
    ])('%s: no other hold names it, of either purpose', async (_label, resolved) => {
      const { holdId, journalId } = await fundedHold();
      if (resolved) await resolve(holdId);
      const made = await toppedUp();
      for (const [reference, type] of [
        [await obligation(), 'TRANSACTION'],
        [made.intentId, 'PAYMENT_REFUND'],
      ] as const) {
        await expect(plantHold(reference, journalId, { type })).rejects.toThrow(
          /wallet_hold_placed_journal_id_key|Unique constraint|23505/,
        );
      }
    });

    it.each([
      ['cleared', () => `placed_journal_id = NULL`],
      ['pointed at another journal', (other: string) => `placed_journal_id = '${other}'`],
    ])('its pointer is not %s, on a hold active or resolved', async (_label, assignment) => {
      const active = await fundedHold();
      const other = await plantJournal(active.reference);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE wallet_hold SET ${assignment(other)} WHERE id = $1`,
          active.holdId,
        ),
      ).rejects.toThrow(TERMS_FIXED);

      const resolved = await fundedHold();
      await resolve(resolved.holdId);
      await expect(
        runtime.$executeRawUnsafe(
          `UPDATE wallet_hold SET ${assignment(other)} WHERE id = $1`,
          resolved.holdId,
        ),
      ).rejects.toThrow(FINAL);
    });

    it('and a hold with no journal is not given one afterwards', async () => {
      const reference = await obligation();
      const holdId = await plantHold(reference, null);
      const journalId = await plantJournal(reference);
      await expect(
        runtime.$executeRawUnsafe(
          'UPDATE wallet_hold SET placed_journal_id = $2 WHERE id = $1',
          holdId,
          journalId,
        ),
      ).rejects.toThrow(TERMS_FIXED);
    });
  });

  describe('its financial terms are fixed once placed', () => {
    it.each([
      ['amount', `amount_minor = amount_minor + 1`, TERMS_FIXED],
      ['currency', `currency = 'USD'`, TERMS_FIXED],
      ['wallet', `wallet_id = 'WLT_ELSEWHERE'`, WHOSE_FIXED],
      ['purpose', `reference_type = 'PAYMENT_REFUND'`, WHOSE_FIXED],
      ['obligation', `reference = 'ELSEWHERE'`, WHOSE_FIXED],
    ])('%s', async (_label, assignment, refusal) => {
      const { holdId } = await fundedHold();
      for (const client of [runtime, owner]) {
        await expect(
          client.$executeRawUnsafe(`UPDATE wallet_hold SET ${assignment} WHERE id = $1`, holdId),
        ).rejects.toThrow(refusal);
      }
    });

    it('control: resolving an active hold writes what a resolution writes', async () => {
      const { holdId } = await fundedHold();
      await resolve(holdId);
      expect(await holdRow(holdId)).toMatchObject({ status: 'REFUNDED' });
      expect(await funded(holdId)).toBe(true);
    });
  });

  describe('funded at commit, by the journal as it stands then (FU-182)', () => {
    const committedHolds = async (reference: string) =>
      (
        await owner.$queryRawUnsafe<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM wallet_hold WHERE reference = $1',
          reference,
        )
      )[0]!.n;

    /** Escrow back out to the payer's wallet: what a later leg would take from the funding. */
    const TAKEN_BACK: Leg[] = [
      { purpose: 'ESCROW', direction: 'DEBIT' },
      { purpose: 'WALLET', direction: 'CREDIT' },
    ];

    /**
     * One transaction: the funding journal and its hold, the hold resolved while that journal still
     * funds it (so every statement-time check passes), then `edit`. `lifted`: the statement-time
     * refusal of a leg is disabled first, inside this transaction only (back with its rollback).
     */
    const resolvedThenEdited = (
      reference: string,
      edit: (tx: Raw, journalId: string) => Promise<unknown>,
      { lifted = false } = {},
    ) =>
      owner.$transaction(
        async (tx) => {
          if (lifted) {
            // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this owner transaction,
            // whose rollback restores the trigger.
            await tx.$executeRawUnsafe(
              'ALTER TABLE ledger_entry DISABLE TRIGGER trg_ledger_entry_hold_journal_closed',
            );
          }
          const journalId = await writeJournal(tx, reference);
          const holdId = await plantHold(reference, journalId, {}, tx);
          const refund = await writeJournal(tx, reference, {
            type: 'FUNDS_REFUNDED',
            legs: TAKEN_BACK,
          });
          await tx.$executeRawUnsafe(
            `UPDATE wallet_hold SET status = 'REFUNDED', resolved_at = now(), resolved_by = 'itest',
                    resolved_journal_id = $2 WHERE id = $1`,
            holdId,
            refund,
          );
          await edit(tx, journalId);
        },
        { timeout: 30_000 },
      );

    it('control: written and resolved in one transaction, it commits', async () => {
      const reference = await obligation();
      await resolvedThenEdited(reference, async () => undefined);
      expect(await committedHolds(reference)).toBe(1n);
    });

    it('a leg added to its journal after the hold is written is refused where it is added', async () => {
      const reference = await obligation();
      await expect(
        resolvedThenEdited(reference, (tx, journalId) => writeLegs(tx, journalId, TAKEN_BACK)),
      ).rejects.toThrow(LEG_REFUSED);
      expect(await committedHolds(reference)).toBe(0n);
    });

    it('with that refusal lifted, the commit refuses what every statement let through', async () => {
      const reference = await obligation();
      await expect(
        resolvedThenEdited(reference, (tx, journalId) => writeLegs(tx, journalId, TAKEN_BACK), {
          lifted: true,
        }),
      ).rejects.toThrow(AT_COMMIT);
      expect(await committedHolds(reference)).toBe(0n);
      const [trigger] = await owner.$queryRawUnsafe<{ enabled: string }[]>(
        `SELECT tgenabled AS enabled FROM pg_trigger WHERE tgname = 'trg_ledger_entry_hold_journal_closed'`,
      );
      expect(trigger!.enabled).toBe('O');
    });

    const reverse = (journalId: string) =>
      asActor({ organizationId: payer }, () =>
        wiring.prisma.transaction((tx) => wiring.ledger.reverse(tx, journalId, 'itest', 'itest')),
      );

    it('its journal is never reversed, the hold active or resolved', async () => {
      const active = await fundedHold();
      const resolved = await fundedHold();
      await resolve(resolved.holdId);
      for (const { holdId, journalId } of [active, resolved]) {
        await expect(reverse(journalId)).rejects.toThrow(NEVER_REVERSED);
        expect(await funded(holdId)).toBe(true);
      }
    });

    /** The exact opposite of a journal, by hand: what `LedgerService.reverse` writes. */
    const reversalOf = async (tx: Raw, journalId: string) => {
      const reversal = `JRN_${ulid()}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO journal (id, organization_id, transaction_id, journal_type, description, posted_at,
                              posted_by, correlation_id, reverses_id, reversal_reason)
         SELECT $1, organization_id, transaction_id, 'REVERSAL', 'reversed by the suite', now(), posted_by,
                correlation_id, id, 'planted by the suite'
           FROM journal WHERE id = $2`,
        reversal,
        journalId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
         SELECT 'LGE_' || md5(id || $1), $1, account_id, organization_id,
                (CASE direction WHEN 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END)::"EntryDirection",
                amount_minor, currency, now()
           FROM ledger_entry WHERE journal_id = $2`,
        reversal,
        journalId,
      );
    };

    /** Until a session of this database waits on an advisory lock: the race is on. */
    const someoneWaits = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        // As the owner: a role sees only its own sessions' wait events.
        const [row] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        if (row!.n > 0n) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('nobody waited on the hold journal lock');
    };

    /** Opens `first` in a transaction on `other`, runs `then` while it is open, then commits it. */
    const whileOpen = async (
      first: (tx: Raw) => Promise<unknown>,
      then: () => Promise<unknown>,
    ) => {
      let release!: () => void;
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => (opened = resolve));
      const held = other.$transaction(
        async (tx) => {
          await first(tx);
          opened();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 },
      );
      await Promise.race([ready, held]);
      const second = then().then(
        () => null,
        (error: Error) => error,
      );
      try {
        await someoneWaits();
      } finally {
        release?.();
      }
      return {
        first: await held.then(
          () => null,
          (error: Error) => error,
        ),
        second: await second,
      };
    };

    it('a reversal first and a hold naming its journal at once: the hold waits for it, and is refused', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference);
      const raced = await whileOpen(
        (tx) => reversalOf(tx, journalId),
        () => plantHold(reference, journalId),
      );
      expect(raced.first).toBeNull();
      expect(raced.second?.message).toMatch(AT_COMMIT);
    });

    it('a hold first and a reversal of its journal at once: the reversal waits for it, and is refused', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference);
      const raced = await whileOpen(
        async (tx) => {
          // Its check runs at this statement, not at commit: the lock is held from here.
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_wallet_hold_funded_at_commit IMMEDIATE');
          await plantHold(reference, journalId, {}, tx);
        },
        () => owner.$transaction((tx) => reversalOf(tx, journalId)),
      );
      expect(raced.first).toBeNull();
      expect(raced.second?.message).toMatch(NEVER_REVERSED);
    });

    const WRITTEN_ONLY_RC = /A guard that locks and then reads runs only under READ COMMITTED/;
    const REVERSED_ONLY_RC = /A guard that locks and then reads runs only under READ COMMITTED/;

    // SERIALIZABLE reads the same snapshot from before the wait, and aborts one of two that cross
    // only when both are SERIALIZABLE (#936 r1 F1): every level but READ COMMITTED is refused.
    it.each(['RepeatableRead', 'Serializable'] as const)(
      'under %s, which reads from before the wait, neither is written',
      async (isolationLevel) => {
        const reference = await obligation();
        const journalId = await plantJournal(reference);
        await expect(
          owner.$transaction((tx) => plantHold(reference, journalId, {}, tx), { isolationLevel }),
        ).rejects.toThrow(WRITTEN_ONLY_RC);
        await expect(
          owner.$transaction((tx) => reversalOf(tx, journalId), { isolationLevel }),
        ).rejects.toThrow(REVERSED_ONLY_RC);
        // Control: the same two under READ COMMITTED, one after the other.
        await plantHold(reference, journalId);
        await expect(owner.$transaction((tx) => reversalOf(tx, journalId))).rejects.toThrow(
          NEVER_REVERSED,
        );
      },
    );

    const serializable = { isolationLevel: 'Serializable', timeout: 30_000 } as const;

    it('a READ COMMITTED reversal first and a SERIALIZABLE hold naming its journal: the hold is refused', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference);
      const raced = await whileOpen(
        (tx) => reversalOf(tx, journalId),
        () => owner.$transaction((tx) => plantHold(reference, journalId, {}, tx), serializable),
      );
      expect(raced.first).toBeNull();
      expect(raced.second?.message).toMatch(WRITTEN_ONLY_RC);
      expect(await committedHolds(reference)).toBe(0n);
    });

    it('a READ COMMITTED hold first and a SERIALIZABLE reversal of its journal: the reversal is refused', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference);
      const raced = await whileOpen(
        async (tx) => {
          await tx.$executeRawUnsafe('SET CONSTRAINTS trg_wallet_hold_funded_at_commit IMMEDIATE');
          await plantHold(reference, journalId, {}, tx);
        },
        () => owner.$transaction((tx) => reversalOf(tx, journalId), serializable),
      );
      expect(raced.first).toBeNull();
      expect(raced.second?.message).toMatch(REVERSED_ONLY_RC);
      const [reversals] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT count(*) AS n FROM journal WHERE reverses_id = $1',
        journalId,
      );
      expect(reversals!.n).toBe(0n);
    });

    it('control: a FUNDS_HELD journal no hold names is reversed like any other', async () => {
      await expect(reverse(await plantJournal(await obligation()))).resolves.toBeDefined();
    });
  });

  describe('funded by the payer’s own wallet, and by nothing else (FU-182)', () => {
    const stranger = `${org.a}-SOURCE`;
    const INTO_ESCROW_FROM = (...sources: Leg[]): Leg[] => [
      ...sources,
      { purpose: 'ESCROW', direction: 'CREDIT' },
    ];

    it.each<[string, Leg[]]>([
      [
        'platform payment clearing, the top-up’s own counterpart',
        INTO_ESCROW_FROM({ purpose: 'PAYMENT_CLEARING', direction: 'DEBIT' }),
      ],
      ['reward expense', INTO_ESCROW_FROM({ purpose: 'REWARD_EXPENSE', direction: 'DEBIT' })],
      [
        'commission revenue',
        INTO_ESCROW_FROM({ purpose: 'COMMISSION_REVENUE', direction: 'DEBIT' }),
      ],
      [
        'another organization’s wallet',
        INTO_ESCROW_FROM({ purpose: 'WALLET', direction: 'DEBIT', organizationId: stranger }),
      ],
      [
        'half the payer’s wallet and half clearing',
        INTO_ESCROW_FROM(
          { purpose: 'WALLET', direction: 'DEBIT', amount: AMOUNT / 2n },
          { purpose: 'PAYMENT_CLEARING', direction: 'DEBIT', amount: AMOUNT / 2n },
        ),
      ],
    ])('escrow credited from %s funds no hold', async (_label, legs) => {
      const reference = await obligation();
      expect(await plantedFunded(reference, await plantJournal(reference, { legs }))).toBe(false);
    });

    it('nor does the top-up’s own journal', async () => {
      const made = await toppedUp();
      const [topUp] = await owner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM journal WHERE transaction_id = $1 AND journal_type = 'WALLET_TOP_UP'`,
        made.transactionId,
      );
      expect(await plantedFunded(made.transactionId, topUp!.id)).toBe(false);
    });

    it('control: a real top-up does, held by the service', async () => {
      await toppedUp();
      const reference = await obligation();
      const { holdId } = await asActor({ organizationId: payer }, () =>
        wiring.prisma.transaction(async (tx) => {
          const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
          return wiring.wallets.placeHold(tx, {
            wallet: locked!,
            amountMinor: AMOUNT,
            reference,
            referenceType: 'TRANSACTION',
            transactionId: reference,
            placedBy: 'itest',
          });
        }),
      );
      expect(await funded(holdId)).toBe(true);
    });
  });

  describe('the obligation of its purpose', () => {
    it('control: a refund hold funded for its own intent', async () => {
      const made = await toppedUp();
      const journalId = await plantJournal(made.transactionId);
      expect(await plantedFunded(made.intentId, journalId, { type: 'PAYMENT_REFUND' })).toBe(true);
    });

    it.each<[string, (made: { intentId: string; transactionId: string }) => Promise<string>]>([
      ['another intent’s top-up', async () => (await toppedUp()).transactionId],
      ['a transaction of its own', () => obligation()],
    ])('a refund hold is not funded by a journal naming %s', async (_label, named) => {
      const made = await toppedUp();
      const journalId = await plantJournal(await named(made));
      expect(await plantedFunded(made.intentId, journalId, { type: 'PAYMENT_REFUND' })).toBe(false);
    });

    it('nor when it names no intent, nor another amount than the intent’s', async () => {
      const made = await toppedUp();
      const nothing = await plantedFunded(`REF_${ulid()}`, await plantJournal(made.transactionId), {
        type: 'PAYMENT_REFUND',
      });
      expect(nothing).toBe(false);
      const other = await toppedUp();
      const journalId = await plantJournal(other.transactionId, { amount: AMOUNT + 1n });
      expect(
        await plantedFunded(other.intentId, journalId, {
          type: 'PAYMENT_REFUND',
          amount: AMOUNT + 1n,
        }),
      ).toBe(false);
    });

    it('nor when the intent it names is on another wallet', async () => {
      const elsewhere = `${org.a}-ELSEWHERE`;
      const { walletId: theirs } = await fundWallet(wiring, elsewhere, 0n);
      const made = await toppedUp(AMOUNT, elsewhere, theirs);
      const journalId = await plantJournal(made.transactionId);
      expect(await plantedFunded(made.intentId, journalId, { type: 'PAYMENT_REFUND' })).toBe(false);
    });

    it('nor when the intent it names is in another currency', async () => {
      const made = await toppedUp();
      await plantPaymentIntent(
        `UPDATE payment_intent SET currency = 'USD' WHERE id = $1`,
        made.intentId,
      );
      const journalId = await plantJournal(made.transactionId);
      expect(await plantedFunded(made.intentId, journalId, { type: 'PAYMENT_REFUND' })).toBe(false);
    });

    it('a purpose not named is funded by nothing', async () => {
      const reference = `REF_${ulid()}`;
      const journalId = await plantJournal(reference);
      expect(await plantedFunded(reference, journalId, { type: 'OTHER' })).toBe(false);
    });

    it('a transaction’s hold is not funded by a journal of another transaction', async () => {
      const journalId = await plantJournal(await obligation());
      expect(await plantedFunded(await obligation(), journalId)).toBe(false);
    });
  });

  describe('the wallet’s currency', () => {
    it('genuine USD escrow does not fund a USD hold on an IRR wallet', async () => {
      const reference = await obligation();
      const journalId = await plantJournal(reference, { currency: 'USD' });
      expect(await plantedFunded(reference, journalId, { currency: 'USD' })).toBe(false);
    });

    /**
     * What can still stand: a USD hold naming no journal (D-130's unproven rows). One naming a
     * journal never commits, so the service's own currency checks are asked of this one.
     */
    const inDollars = (reference: string, type: string) =>
      plantHold(reference, null, { type, currency: 'USD' });

    it('control: the same journal shape in IRR does', async () => {
      await fundedHold();
    });

    it('a retry is no replay of a hold in another currency, and moves nothing', async () => {
      const reference = await obligation();
      await inDollars(reference, 'TRANSACTION');
      const placed = jest.spyOn(wiring.ledger, 'post');
      await expect(
        asActor({ organizationId: payer }, () =>
          wiring.prisma.transaction(async (tx) => {
            const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
            return wiring.wallets.placeHold(tx, {
              wallet: locked!,
              amountMinor: AMOUNT,
              reference,
              referenceType: 'TRANSACTION',
              transactionId: reference,
              placedBy: 'itest',
            });
          }),
        ),
      ).rejects.toThrow(/in another currency/);
      expect(placed).not.toHaveBeenCalled();
    });

    it('a payment refund with a USD hold on an IRR wallet never reaches the provider', async () => {
      const made = await toppedUp();
      await inDollars(made.intentId, REFUND_HOLD_REFERENCE_TYPE);
      const before = await intentState(made.intentId);
      const ask = spyOnRefund();
      await expect(refund(made.intentId)).rejects.toThrow(/in another currency/);
      expect(ask).not.toHaveBeenCalled();
      expect(await intentState(made.intentId)).toEqual(before);
    });

    it('nor does a refund whose intent is in another currency than its wallet', async () => {
      const made = await toppedUp();
      await plantPaymentIntent(
        `UPDATE payment_intent SET currency = 'USD' WHERE id = $1`,
        made.intentId,
      );
      const before = await intentState(made.intentId);
      const ask = spyOnRefund();
      await expect(refund(made.intentId)).rejects.toThrow(HOLD_NOT_FUNDED);
      expect(ask).not.toHaveBeenCalled();
      expect(await intentState(made.intentId)).toEqual(before);

      // `PaymentService.refund` asks the currency itself, and not only through the predicate.
      jest.spyOn(wiring.walletRepository, 'isHoldFunded').mockResolvedValue(true);
      await expect(refund(made.intentId)).rejects.toThrow(HOLD_NOT_FUNDED);
      expect(ask).not.toHaveBeenCalled();
      expect(await intentState(made.intentId)).toEqual(before);
    });

    it('nor does a refund whose hold the predicate does not call funded', async () => {
      const made = await toppedUp();
      const before = await intentState(made.intentId);
      const ask = spyOnRefund();
      jest.spyOn(wiring.walletRepository, 'isHoldFunded').mockResolvedValue(false);
      await expect(refund(made.intentId)).rejects.toThrow(HOLD_NOT_FUNDED);
      expect(ask).not.toHaveBeenCalled();
      expect(await intentState(made.intentId)).toEqual(before);
    });

    it('control: an ordinary refund asks the provider, in the intent’s currency', async () => {
      const made = await toppedUp();
      const ask = spyOnRefund();
      await refund(made.intentId);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ currency: 'IRR' }));
    });
  });
});
