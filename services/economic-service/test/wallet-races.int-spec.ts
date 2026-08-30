import { runUnscoped, runWithContext } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The wallet paths that only exist because two things can happen at once.
 *
 * Each one is a branch written deliberately — a race lost, a lock contended,
 * an amount refused — and none had ever been executed. They are the branches
 * where getting it wrong does not produce an error but a wrong balance, which
 * is the failure this service exists to prevent.
 *
 * Real database throughout. A row lock, a unique constraint and an optimistic
 * update are not things a mock can have.
 */
describe('wallet races and refusals (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.platform]);
    await prisma.onModuleDestroy();
  });

  describe('opening a wallet', () => {
    it('gives both callers the same wallet when two first requests race', async () => {
      // `(organization_id, currency)` is unique, so one of two concurrent
      // first requests loses the insert. The loser must not fail: its wallet
      // is as good as the winner's, and a 500 here would mean an organization
      // could be locked out of the platform by its own second tab.
      const racing = tenants().a;

      const [first, second] = await Promise.all([
        asActor({ organizationId: racing }, () => wiring.wallets.getOrOpen('IRR')),
        asActor({ organizationId: racing }, () => wiring.wallets.getOrOpen('IRR')),
      ]);

      expect(first.id).toBe(second.id);

      // Exactly one wallet exists, not two with one orphaned.
      const count = await runUnscoped('the suite counts the wallets the race produced', () =>
        prisma.client.wallet.count({ where: { organizationId: racing } }),
      );
      expect(count).toBe(1);

      await cleanup(prisma, [racing]);
    });

    it('opens in the platform currency when the caller names none', async () => {
      // The default is not cosmetic. A wallet opened in the wrong currency
      // cannot be reconciled against a ledger account denominated in another,
      // and nothing later in the flow asks again.
      const fresh = tenants().a;

      const wallet = await asActor({ organizationId: fresh }, () => wiring.wallets.getOrOpen());
      expect(wallet.currency).toBe('IRR');

      await cleanup(prisma, [fresh]);
    });

    it('names this service as the author when no user is behind the call', async () => {
      // A wallet opened by a service command — a settlement reaching an
      // organization nobody has logged into — still has to record who opened
      // the ledger accounts behind it. An empty author would make the audit
      // trail claim provenance it does not have, and `getContext().userId` is
      // genuinely absent on a service call rather than merely unusual.
      const fresh = tenants().a;

      // Built here rather than through `asActor`, which always supplies a user
      // id — so the very absence this test is about cannot be expressed
      // through it. A service-to-service call genuinely has no user.
      await runWithContext(
        {
          correlationId: `itest-${fresh}`,
          requestId: `itest-${fresh}`,
          organizationId: fresh,
          roles: ['SERVICE'],
          authType: 'SERVICE',
          callerService: 'marketplace-service',
          startedAt: Date.now(),
        },
        async () => wiring.wallets.getOrOpen('IRR'),
      );

      const accounts = await runUnscoped('the suite reads the accounts a service opened', () =>
        prisma.client.ledgerAccount.findMany({
          where: { organizationId: fresh },
          select: { createdBy: true },
        }),
      );

      expect(accounts.length).toBeGreaterThan(0);
      // The service's own name, not a blank and not a fabricated user id.
      for (const account of accounts) {
        expect(account.createdBy).toBe('economic-service');
      }

      await cleanup(prisma, [fresh]);
    });
  });

  describe('crediting a wallet', () => {
    it('refuses a credit that is not positive', async () => {
      // A zero or negative credit is a debit wearing the wrong name. Allowing
      // it would post a journal that says money arrived when it left, and the
      // balanced-journal trigger would not catch it: the entries would balance
      // perfectly and describe the opposite of what happened.
      const wallet = await asActor({ organizationId: org.a }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );

      for (const amount of [0n, -1n, -250000n]) {
        await expect(
          asActor({ organizationId: org.a }, () =>
            prisma.transaction((tx) =>
              wiring.wallets.credit(tx, {
                wallet,
                amountMinor: amount,
                counterpartPurpose: 'PAYMENT_CLEARING',
                journalType: 'WALLET_TOP_UP',
                description: 'a credit that must be refused',
                postedBy: 'USR-RACE-TEST',
              }),
            ),
          ),
        ).rejects.toThrow(
          expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }) as unknown as Error,
        );
      }

      // And nothing was posted by any of the three attempts.
      const journals = await runUnscoped('the suite counts journals after refused credits', () =>
        prisma.client.journal.count({
          where: { organizationId: org.a, description: 'a credit that must be refused' },
        }),
      );
      expect(journals).toBe(0);
    });
  });
});
