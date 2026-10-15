import { RastaError, runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  fundWallet,
  newPrisma,
  readBalances,
  testEnv,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import {
  IdempotencyStore,
  TerminalRefusalError,
  type IdempotentAnswer,
} from '../src/shared/idempotency';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Idempotency (docs/06 § 6.8, docs/10 § 10.12).
 *
 * > ثبت دو باره یک تراکنش با یک کلید → یک اثر، یک پاسخ
 *
 * The property under test is **exactly one financial effect**, not "the second
 * call returns something sensible". Every assertion below therefore checks the
 * ledger and the balance as well as the response — a replay that returned the
 * right body while posting a second journal would pass a weaker test and lose
 * a customer their money.
 */
describe('idempotency (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let idempotency: IdempotencyStore;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    idempotency = new IdempotencyStore(prisma, testEnv());
  });

  /**
   * The answer of a work with no effect of its own, stored in a transaction
   * of its own — the stand-in for the effect's transaction a real command
   * stores it in.
   */
  const respondWith = <T>(answer: IdempotentAnswer<T>, response: T) =>
    prisma.transaction((tx) => answer.respond(tx, response));
  const answering =
    <T>(response: T) =>
    (answer: IdempotentAnswer<T>) =>
      respondWith(answer, response);

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  describe('the documented contract', () => {
    it('executes once for a new key', async () => {
      const executed = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-new-0001', { a: 1 }, 201, answering({ ok: true })),
      );
      expect(executed).toEqual({ ok: true });
    });

    it('replays the stored response for the same key and body, without re-executing', async () => {
      let runs = 0;
      const work = (answer: IdempotentAnswer<{ attempt: number }>) => {
        runs += 1;
        return respondWith(answer, { attempt: runs });
      };

      const first = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-replay-01', { a: 1 }, 201, work),
      );
      const second = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-replay-01', { a: 1 }, 201, work),
      );

      expect(first).toEqual({ attempt: 1 });
      expect(second).toEqual({ attempt: 1 });
      expect(runs).toBe(1);
    });

    it('ignores key order in the body, so a retry is recognised as one', async () => {
      let runs = 0;
      const work = (answer: IdempotentAnswer<{ runs: number }>) => {
        runs += 1;
        return respondWith(answer, { runs });
      };

      await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-order-01', { a: 1, b: 2 }, 201, work),
      );
      await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-order-01', { b: 2, a: 1 }, 201, work),
      );

      expect(runs).toBe(1);
    });

    it('refuses the same key with a different body', async () => {
      await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'key-reuse-01', { amountMinor: '100' }, 201, answering({})),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          idempotency.run(
            'POST /itest',
            'key-reuse-01',
            { amountMinor: '999' },
            201,
            answering({}),
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    });

    it.each(['__proto__', 'constructor'])(
      'refuses a body that differs only under a %s key (#194)',
      async (name) => {
        // JSON.parse makes `name` an own key, as the request body parser does.
        const body = (x: number): unknown => ({
          amountMinor: '100',
          extra: JSON.parse(`{"${name}":{"x":${x}}}`) as unknown,
        });
        const k = `key-proto-${name}`;
        let runs = 0;
        const work = (answer: IdempotentAnswer<{ runs: number }>) =>
          respondWith(answer, { runs: (runs += 1) });
        const run = (x: number) =>
          asActor({ organizationId: org.a }, () =>
            idempotency.run('POST /itest', k, body(x), 201, work),
          );

        expect(await run(1)).toEqual({ runs: 1 });
        await expect(run(2)).rejects.toThrow(
          expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }),
        );
        // The same body is still the retry it is: replayed, not run again.
        expect(await run(1)).toEqual({ runs: 1 });
        expect(runs).toBe(1);
      },
    );

    it('refuses a key that is still in flight', async () => {
      // A caller retrying before the first attempt finished. `409 CONFLICT`
      // rather than a second execution, which is the safe way round for a
      // financial write: an early retry is a nuisance, a double charge is an
      // incident.
      await asActor({ organizationId: org.a }, () =>
        idempotency.claim('POST /itest', 'key-flight-01', {}),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          idempotency.claim('POST /itest', 'key-flight-01', {}),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    });

    it('frees the key when the work failed, so a corrected retry can proceed', async () => {
      // A settlement refused for insufficient balance must be retryable with
      // the same key once the wallet is topped up.
      await expect(
        asActor({ organizationId: org.a }, () =>
          idempotency.run('POST /itest', 'key-failed-01', {}, 201, async () => {
            throw new Error('the work failed');
          }),
        ),
      ).rejects.toThrow('the work failed');

      await expect(
        asActor({ organizationId: org.a }, () =>
          idempotency.run('POST /itest', 'key-failed-01', {}, 201, answering({ ok: true })),
        ),
      ).resolves.toEqual({ ok: true });
    });

    describe('the answer is stored with the effect (review of #283, finding 2)', () => {
      const endpoint = 'POST /itest/answer';
      const record = (key: string) =>
        runUnscoped('the suite reads the idempotency record', () =>
          prisma.client.idempotencyKey.findFirst({
            where: { organizationId: org.a, endpoint, key },
          }),
        );
      const run = <T>(key: string, work: (answer: IdempotentAnswer<T>) => Promise<unknown>) =>
        asActor({ organizationId: org.a }, () => idempotency.run(endpoint, key, {}, 200, work));

      it('replays an answer whose transaction committed, whatever failed after it', async () => {
        let runs = 0;
        const work = async (answer: IdempotentAnswer<{ applied: number }>) => {
          runs += 1;
          await respondWith(answer, { applied: runs });
          throw new Error('the read after the commit failed');
        };

        await expect(run('key-answer-01', work)).rejects.toThrow(
          'the read after the commit failed',
        );
        expect(await record('key-answer-01')).toMatchObject({
          state: 'COMPLETED',
          responseStatus: 200,
          responseBody: { applied: 1 },
        });
        await expect(run('key-answer-01', work)).resolves.toEqual({ applied: 1 });
        expect(runs).toBe(1);
      });

      it('frees the key when the transaction holding the answer rolled back', async () => {
        await expect(
          run('key-answer-02', (answer: IdempotentAnswer<{ ok: boolean }>) =>
            prisma.transaction(async (tx) => {
              await answer.respond(tx, { ok: true });
              throw new Error('the effect failed after its answer');
            }),
          ),
        ).rejects.toThrow('the effect failed after its answer');
        expect(await record('key-answer-02')).toBeNull();
        await expect(run('key-answer-02', answering({ ok: true }))).resolves.toEqual({ ok: true });
      });

      it('keeps the claim of a work that returned without storing an answer', async () => {
        // A programming error, after which the work may have committed: the
        // key is neither completed with a guess nor freed for a second run.
        await expect(run('key-answer-03', async () => ({ ok: true }))).rejects.toThrow(
          expect.objectContaining({ code: 'INTERNAL_ERROR' }),
        );
        expect(await record('key-answer-03')).toMatchObject({ state: 'IN_PROGRESS' });
        await expect(run('key-answer-03', answering({ ok: true }))).rejects.toThrow(
          expect.objectContaining({ code: 'CONFLICT' }),
        );
      });

      it('answers with the stored body, not anything the work returned', async () => {
        await expect(
          run('key-answer-04', async (answer: IdempotentAnswer<{ from: string }>) => {
            await respondWith(answer, { from: 'the transaction' });
            return { from: 'after it' };
          }),
        ).resolves.toEqual({ from: 'the transaction' });
      });

      const refusals = {
        DECLINED: { code: 'BUSINESS_RULE_VIOLATION', message: 'Declined, and final' },
      } as const;

      it('replays a declared refusal stored with the effect that ended in it', async () => {
        let runs = 0;
        const declined = new TerminalRefusalError('DECLINED', refusals.DECLINED);
        const work = async (answer: IdempotentAnswer<unknown>) => {
          runs += 1;
          await prisma.transaction((tx) => answer.refuse(tx, declined));
          throw declined;
        };
        const refuse = () =>
          asActor({ organizationId: org.a }, () =>
            idempotency.run(endpoint, 'key-answer-05', {}, 200, work, {
              terminalRefusals: refusals,
            }),
          );

        await expect(refuse()).rejects.toThrow('Declined, and final');
        expect(await record('key-answer-05')).toMatchObject({
          state: 'COMPLETED',
          responseStatus: 422,
          responseBody: { refusal: 'DECLINED' },
        });
        await expect(refuse()).rejects.toThrow('Declined, and final');
        expect(runs).toBe(1);
      });

      it('ignores a refusal the endpoint did not declare, and releases the key for it', async () => {
        const undeclared = new TerminalRefusalError('OTHER', refusals.DECLINED);
        let committed = false;
        await expect(
          run('key-answer-06', async (answer) => {
            await prisma.transaction(async (tx) => {
              await answer.refuse(tx, undeclared);
              committed = true;
            });
            throw undeclared;
          }),
        ).rejects.toThrow('Declined, and final');
        // The effect it ended is never rolled back for it.
        expect(committed).toBe(true);
        expect(await record('key-answer-06')).toBeNull();
      });
    });

    describe('terminal refusals (opt-in)', () => {
      const refusals = {
        DECLINED: { code: 'BUSINESS_RULE_VIOLATION', message: 'Declined, and final' },
      } as const;
      const declined = () => new TerminalRefusalError('DECLINED', refusals.DECLINED, { n: 1 });
      const run = (
        key: string,
        body: unknown,
        work: (answer: IdempotentAnswer<unknown>) => Promise<unknown>,
        opt = true,
      ) =>
        asActor({ organizationId: org.a }, () =>
          idempotency.run(
            'POST /itest/terminal',
            key,
            body,
            200,
            work,
            opt ? { terminalRefusals: refusals } : undefined,
          ),
        );
      const stored = (key: string) =>
        runUnscoped('the suite reads the idempotency record', () =>
          prisma.client.idempotencyKey.findFirst({
            where: { organizationId: org.a, endpoint: 'POST /itest/terminal', key },
          }),
        );

      it('records a declared refusal and replays it, without running the work again', async () => {
        let runs = 0;
        const work = async () => {
          runs += 1;
          throw declined();
        };

        await expect(run('key-term-01', { a: 1 }, work)).rejects.toThrow(
          expect.objectContaining({
            code: 'BUSINESS_RULE_VIOLATION',
            message: 'Declined, and final',
          }),
        );
        await expect(run('key-term-01', { a: 1 }, work)).rejects.toThrow(
          expect.objectContaining({
            code: 'BUSINESS_RULE_VIOLATION',
            message: 'Declined, and final',
          }),
        );
        expect(runs).toBe(1);

        // Codes only: the status and the closed name, nothing the error carried.
        const row = await stored('key-term-01');
        expect(row).toMatchObject({
          state: 'COMPLETED',
          responseStatus: 422,
          responseBody: { refusal: 'DECLINED' },
        });
      });

      it('still refuses the same key with a different body', async () => {
        await expect(
          run('key-term-02', { a: 1 }, async () => Promise.reject(declined())),
        ).rejects.toThrow();
        await expect(run('key-term-02', { a: 2 }, answering({ ok: true }))).rejects.toThrow(
          expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }),
        );
      });

      it('releases the key for a refusal the endpoint did not declare', async () => {
        const undeclared = () =>
          new TerminalRefusalError('OTHER', { code: 'BUSINESS_RULE_VIOLATION', message: 'x' });
        await expect(
          run('key-term-03', {}, async () => Promise.reject(undeclared())),
        ).rejects.toThrow();
        expect(await stored('key-term-03')).toBeNull();
        await expect(run('key-term-03', {}, answering({ ok: true }))).resolves.toEqual({
          ok: true,
        });
      });

      it('releases the key for any other error, even on an opted-in endpoint', async () => {
        await expect(
          run('key-term-04', {}, async () => {
            throw RastaError.insufficientBalance('WAL-1', '10', '1');
          }),
        ).rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));
        expect(await stored('key-term-04')).toBeNull();
        await expect(run('key-term-04', {}, answering({ ok: true }))).resolves.toEqual({
          ok: true,
        });
      });

      it('releases the key when the endpoint did not opt in at all', async () => {
        await expect(
          run('key-term-05', {}, async () => Promise.reject(declined()), false),
        ).rejects.toThrow();
        expect(await stored('key-term-05')).toBeNull();
      });
    });

    it('keeps one organization key from colliding with another', async () => {
      // The key is scoped by tenant and endpoint, so two organizations using
      // the same client-generated key do not interfere.
      const a = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', 'shared-key-01', {}, 201, answering({ who: 'a' })),
      );
      const b = await asActor({ organizationId: org.b }, () =>
        idempotency.run('POST /itest', 'shared-key-01', {}, 201, answering({ who: 'b' })),
      );

      expect(a).toEqual({ who: 'a' });
      expect(b).toEqual({ who: 'b' });
    });

    it('keeps one endpoint key from colliding with another', async () => {
      const one = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /one', 'endpoint-key-01', {}, 201, answering({ where: 'one' })),
      );
      const two = await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /two', 'endpoint-key-01', {}, 201, answering({ where: 'two' })),
      );

      expect(one).toEqual({ where: 'one' });
      expect(two).toEqual({ where: 'two' });
    });
  });

  describe('exactly one financial effect', () => {
    it('creates one transaction and one hold for a retried request', async () => {
      const organizationId = `${org.c}-IDEM`;
      await fundWallet(wiring, organizationId, 5_000_000n);

      const body = {
        transactionType: 'MARKETPLACE_ORDER' as const,
        counterpartyOrganizationId: org.b,
        grossAmountMinor: '2000000',
        currency: 'IRR' as const,
        holdFunds: true,
      };

      const create = () =>
        asActor({ organizationId }, () =>
          idempotency.run(
            'POST /v1/transactions',
            'financial-key-01',
            body,
            201,
            (answer: IdempotentAnswer<{ id: string }>) =>
              wiring.transactions.create(
                { ...body, idempotencyKey: 'financial-key-01' },
                answer.map(({ id }) => ({ id })),
              ),
          ),
        );

      const first = await create();
      const second = await create();

      // The same transaction, not a second one.
      expect(second.id).toBe(first.id);

      const transactions = await asActor({ organizationId }, () =>
        prisma.client.transaction.findMany({ where: { organizationId } }),
      );
      expect(transactions).toHaveLength(1);

      // And the money left the wallet once.
      const balances = await readBalances(prisma, await walletId(organizationId));
      expect(balances.pending).toBe(2_000_000n);
      expect(balances.available).toBe(3_000_000n);

      await cleanup(prisma, [organizationId]);
    });

    it('posts no second journal on a replayed settlement', async () => {
      const organizationId = `${org.c}-IDEM-SETTLE`;
      await fundWallet(wiring, organizationId, 1_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );

      const settle = () =>
        asActor({ organizationId }, () =>
          idempotency.run(
            'POST /v1/settlements',
            'settle-key-01',
            { transactionId: transaction.id },
            201,
            (answer: IdempotentAnswer<{ settlementId: string }>) =>
              wiring.settlements.settle(
                transaction.id,
                'USR-ITEST',
                answer.map(({ settlementId }) => ({ settlementId })),
              ),
          ),
        );

      const first = await settle();
      const second = await settle();

      expect(second.settlementId).toBe(first.settlementId);

      const journals = await runUnscoped(
        'the idempotency audit counts journals per transaction',
        () =>
          prisma.client.journal.findMany({
            where: { transactionId: transaction.id, journalType: 'SETTLEMENT' },
          }),
      );
      expect(journals).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });

    it('refuses a second settlement even without an idempotency key', async () => {
      // The last line of defence, when a caller bypasses the key entirely: the
      // row lock plus the compare-and-set status update.
      const organizationId = `${org.c}-IDEM-DOUBLE`;
      await fundWallet(wiring, organizationId, 1_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );

      await asActor({ organizationId }, () =>
        wiring.settlements.settle(transaction.id, 'USR-ITEST'),
      );

      await expect(
        asActor({ organizationId }, () => wiring.settlements.settle(transaction.id, 'USR-ITEST')),
      ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));

      await cleanup(prisma, [organizationId]);
    });

    it('settles once when two identical requests race', async () => {
      // Both hold the same key. One executes, the other finds IN_PROGRESS or
      // replays — and either way exactly one settlement journal exists.
      const organizationId = `${org.c}-IDEM-RACE`;
      await fundWallet(wiring, organizationId, 1_000_000n);

      const transaction = await asActor({ organizationId }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );

      const settle = () =>
        asActor({ organizationId }, () =>
          idempotency.run(
            'POST /v1/settlements',
            'race-key-01',
            { transactionId: transaction.id },
            201,
            (answer: IdempotentAnswer<{ settlementId: string }>) =>
              wiring.settlements.settle(
                transaction.id,
                'USR-ITEST',
                answer.map(({ settlementId }) => ({ settlementId })),
              ),
          ),
        ).then(
          () => 'ok' as const,
          (error: { code?: string }) => (error?.code ?? 'UNKNOWN') as string,
        );

      const outcomes = await Promise.all([settle(), settle(), settle()]);

      expect(outcomes.filter((outcome) => outcome === 'ok').length).toBeGreaterThanOrEqual(1);

      const journals = await runUnscoped(
        'the idempotency audit counts journals per transaction',
        () =>
          prisma.client.journal.findMany({
            where: { transactionId: transaction.id, journalType: 'SETTLEMENT' },
          }),
      );
      expect(journals).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });
  });

  describe('expiry', () => {
    it('purges records past their retention window', async () => {
      // The key carries this run's tenant, and the back-dating below names
      // both. It used to be the literal `key-expire-01` matched on `key`
      // alone: every concurrent run writes that same string, and a row is a
      // key *per organization*, so the statement reached back through every
      // other run's records and expired them too. `purgeExpired` then deleted
      // them — it is deliberately platform-wide upkeep, deleting by age and
      // never by tenant, so it does exactly what it is told.
      const key = `key-expire-01-${org.a}`;

      await asActor({ organizationId: org.a }, () =>
        idempotency.run('POST /itest', key, {}, 201, answering({})),
      );

      // Both columns are moved back together, because `ck_idempotency_expiry`
      // requires `expires_at > created_at` — a record that expired before it
      // was created is not a state the table permits, which is the constraint
      // doing its job.
      await runUnscoped('the expiry test back-dates a record it created', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE idempotency_key
              SET created_at = now() - interval '48 hours',
                  expires_at = now() - interval '24 hours'
            WHERE key = $1 AND organization_id = $2`,
          key,
          org.a,
        ),
      );

      const purged = await asActor({ organizationId: org.a }, () => idempotency.purgeExpired());
      expect(purged).toBeGreaterThanOrEqual(1);
    });

    it('lets exactly one of many concurrent claims take over an expired key', async () => {
      // Economic batch 2, item g. Every claimer finds the same expired row.
      // Deleting it by key alone let a late claimer remove the fresh claim an
      // earlier one had just written — two PROCEEDs for one key — and a claimer
      // whose delete found the row already gone answered a 500.
      const organizationId = `${org.b}-RECLAIM`;
      const key = `key-reclaim-${organizationId}`;
      await asActor({ organizationId }, () =>
        idempotency.run('POST /itest', key, { a: 1 }, 201, answering({})),
      );
      await runUnscoped('the race test back-dates a record it created', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE idempotency_key
              SET created_at = now() - interval '48 hours',
                  expires_at = now() - interval '24 hours'
            WHERE key = $1 AND organization_id = $2`,
          key,
          organizationId,
        ),
      );

      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () =>
          asActor({ organizationId }, () => idempotency.claim('POST /itest', key, { a: 1 })).then(
            (claim) => claim.kind,
            (error: { code?: string }) => error.code ?? 'UNKNOWN',
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'PROCEED')).toHaveLength(1);
      // Everyone else was told the key is in flight: no 500, no second owner.
      expect(
        outcomes.filter((outcome) => outcome !== 'PROCEED').every((o) => o === 'CONFLICT'),
      ).toBe(true);

      const rows = await runUnscoped('the race test reads the one live claim', () =>
        prisma.client.idempotencyKey.findMany({ where: { organizationId, key } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('IN_PROGRESS');
      expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  async function walletId(organizationId: string): Promise<string> {
    const wallet = await runUnscoped('the idempotency audit reads the wallet under test', () =>
      prisma.client.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency: 'IRR' } },
      }),
    );
    if (!wallet) throw new Error(`no wallet for ${organizationId}`);
    return wallet.id;
  }
});
