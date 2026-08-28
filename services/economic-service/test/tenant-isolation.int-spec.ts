import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { asActor, cleanup, fundWallet, newPrisma, tenants, wire, type Wiring } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Tenant isolation, against a real database (AGENTS.md § 4, § 5).
 *
 * > هر Feature جدید که داده مستأجر را لمس می‌کند باید یک Tenant Isolation Test
 * > داشته باشد که ثابت کند مستأجر A نمی‌تواند داده مستأجر B را بخواند یا تغییر
 * > دهد.
 *
 * In a financial service that is the difference between a wallet and a public
 * ledger, so the suite proves it against the guard and the database rather
 * than against a mock that would assume the behaviour.
 *
 * Two cases here need more than the automatic guard, and both are covered
 * explicitly because both were places a leak could hide:
 *
 *   **A transaction names two organizations.** The guard cannot express "the
 *   payer or the payee", so those reads cross it deliberately and are narrowed
 *   in `access.ts`. The narrowing is what is under test.
 *
 *   **Commission and reward rules are not automatically scoped**, because a
 *   NULL organization means platform-wide and the guard would hide every
 *   global rule. Their scoping is hand-written, so it is proven here.
 */
describe('tenant isolation (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);

    await fundWallet(wiring, org.a, 5_000_000n);
    await fundWallet(wiring, org.b, 5_000_000n);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  describe('wallets', () => {
    it('never returns another organization wallet', async () => {
      const theirs = await asActor({ organizationId: org.b }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );

      await expect(
        asActor({ organizationId: org.a }, () => wiring.wallets.getById(theirs.id)),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('opens a separate wallet per organization rather than sharing one', async () => {
      const mine = await asActor({ organizationId: org.a }, () => wiring.wallets.getOrOpen('IRR'));
      const theirs = await asActor({ organizationId: org.b }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );
      expect(mine.id).not.toBe(theirs.id);
    });

    it('lists only its own holds', async () => {
      const mine = await asActor({ organizationId: org.a }, () => wiring.wallets.getOrOpen('IRR'));
      const holds = await asActor({ organizationId: org.b }, () =>
        wiring.wallets.listHolds(mine.id),
      );
      // The guard scopes the query, so another tenant's wallet id yields
      // nothing rather than someone else's escrow.
      expect(holds).toEqual([]);
    });
  });

  describe('the ledger', () => {
    it('never returns another organization account', async () => {
      const theirAccounts = await asActor({ organizationId: org.b }, () =>
        wiring.ledger.listAccounts(),
      );
      expect(theirAccounts.length).toBeGreaterThan(0);

      await expect(
        asActor({ organizationId: org.a }, () => wiring.ledger.getAccount(theirAccounts[0]!.id)),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('lists only its own accounts', async () => {
      const mine = await asActor({ organizationId: org.a }, () => wiring.ledger.listAccounts());
      expect(mine.every((account) => account.organizationId === org.a)).toBe(true);
    });

    it('never returns another organization journal', async () => {
      const theirJournal = await asActor({ organizationId: org.b }, () =>
        prisma.client.journal.findFirst({ where: { organizationId: org.b } }),
      );
      expect(theirJournal).not.toBeNull();

      await expect(
        asActor({ organizationId: org.a }, () => wiring.ledger.getJournal(theirJournal!.id)),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('shows a statement only for an account the caller owns', async () => {
      const theirAccounts = await asActor({ organizationId: org.b }, () =>
        wiring.ledger.listAccounts(),
      );

      await expect(
        asActor({ organizationId: org.a }, () =>
          wiring.ledger.listEntries(theirAccounts[0]!.id, undefined, 10),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });
  });

  describe('transactions', () => {
    it('shows a transaction to its payer and its payee, and to nobody else', async () => {
      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );

      // Payer.
      await expect(
        asActor({ organizationId: org.a }, () => wiring.transactions.get(transaction.id)),
      ).resolves.toMatchObject({ id: transaction.id });

      // Payee — the case a plain tenant filter would wrongly hide.
      await expect(
        asActor({ organizationId: org.b }, () => wiring.transactions.get(transaction.id)),
      ).resolves.toMatchObject({ id: transaction.id });

      // A third organization: 404, never 403.
      await expect(
        asActor({ organizationId: org.c }, () => wiring.transactions.get(transaction.id)),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('lists only the caller own transactions by default', async () => {
      const listed = await asActor({ organizationId: org.c }, () =>
        wiring.transactions.list({ limit: 50 }),
      );
      expect(listed.items).toEqual([]);
    });

    it('shows the payee its incoming transactions, and only its own', async () => {
      const incoming = await asActor({ organizationId: org.b }, () =>
        wiring.transactions.list({ limit: 50, includeIncoming: true }),
      );

      expect(incoming.items.length).toBeGreaterThan(0);
      for (const item of incoming.items) {
        expect([item.organizationId, item.counterpartyOrganizationId]).toContain(org.b);
      }
    });

    it('refuses a third organization attempt to move somebody else transaction', async () => {
      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '500000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );

      await expect(
        asActor({ organizationId: org.c }, () =>
          wiring.transactions.authoriseSettlement(transaction.id),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('refuses a settlement commanded by an organization that is not the payer', async () => {
      const transaction = await asActor({ organizationId: org.a }, () =>
        wiring.transactions.create({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: org.b,
          grossAmountMinor: '500000',
          currency: 'IRR',
          holdFunds: true,
        }),
      );
      await asActor({ organizationId: org.a }, () =>
        wiring.transactions.authoriseSettlement(transaction.id),
      );

      // The payee is a party to the transaction and may read it — but it may
      // not commit the payer's money.
      await expect(
        asActor({ organizationId: org.b }, async () => {
          const loaded = await wiring.transactions.get(transaction.id);
          const { canCommitOrganization } = await import('../src/access/access');
          canCommitOrganization(loaded.organizationId);
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'TENANT_MISMATCH' }));
    });
  });

  describe('governance rules, which the guard cannot scope automatically', () => {
    it('shows a platform-wide rule to every organization', async () => {
      await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
        wiring.commissions.createRule({
          transactionType: 'LOGISTICS',
          rateBasisPoints: 100,
          status: 'ACTIVE',
          label: 'itest-global',
        }),
      );

      const seenByB = await asActor({ organizationId: org.b }, () =>
        wiring.commissions.listRules('LOGISTICS'),
      );
      expect(seenByB.map((rule) => rule.label)).toContain('itest-global');
    });

    it('never shows one organization private rate to another', async () => {
      // A negotiated rate is commercially sensitive. This is the leak the
      // hand-written `{ OR: [null, organizationId] }` scope has to prevent —
      // and the reason it is tested here rather than assumed.
      await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
        wiring.commissions.createRule({
          organizationId: org.a,
          transactionType: 'PROCUREMENT_ORDER',
          rateBasisPoints: 42,
          status: 'ACTIVE',
          label: 'itest-private-to-a',
        }),
      );

      const seenByB = await asActor({ organizationId: org.b }, () =>
        wiring.commissions.listRules('PROCUREMENT_ORDER'),
      );
      expect(seenByB.map((rule) => rule.label)).not.toContain('itest-private-to-a');

      const seenByA = await asActor({ organizationId: org.a }, () =>
        wiring.commissions.listRules('PROCUREMENT_ORDER'),
      );
      expect(seenByA.map((rule) => rule.label)).toContain('itest-private-to-a');
    });

    it('never charges one organization at another negotiated rate', async () => {
      // The financial consequence of the same leak: B settling a
      // PROCUREMENT_ORDER must not pick up A's 42bp arrangement.
      const decision = await asActor({ organizationId: org.b }, () =>
        prisma.transaction((tx) =>
          wiring.commissions.decide(tx, {
            organizationId: org.b,
            transactionType: 'PROCUREMENT_ORDER',
            occurredAt: new Date(),
            grossAmountMinor: 1_000_000n,
            currency: 'IRR',
          }),
        ),
      );

      expect(decision.matched).toBe(false);
      expect(decision.amountMinor).toBe(0n);
    });

    it('keeps reward rules scoped the same way', async () => {
      await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
        wiring.rewards.createRule({
          organizationId: org.a,
          triggerEvent: 'USAGE_RECORDED',
          rewardType: 'POINTS',
          points: 7,
          status: 'ACTIVE',
          label: 'itest-reward-private-to-a',
        }),
      );

      const seenByB = await asActor({ organizationId: org.b }, () =>
        wiring.rewards.listRules('USAGE_RECORDED'),
      );
      expect(seenByB.map((rule) => rule.label)).not.toContain('itest-reward-private-to-a');
    });
  });

  describe('the guard fails closed', () => {
    it('refuses a scoped query with no request context at all', async () => {
      // ADR-011's promise: a query that forgets its scope throws rather than
      // running unscoped. A loud 500 in development beats a silent
      // cross-tenant read in production.
      await expect(prisma.client.wallet.findMany()).rejects.toThrow();
    });

    it('refuses a query that names an organization other than the request', async () => {
      const context: RequestContext = {
        correlationId: `itest-${ulid()}`,
        requestId: `itest-${ulid()}`,
        organizationId: org.a,
        userId: 'USR-ITEST',
        roles: ['ORGANIZATION_ADMIN'],
        authType: 'USER',
        startedAt: Date.now(),
      };

      await expect(
        runWithContext(context, async () =>
          prisma.client.wallet.findMany({ where: { organizationId: org.b } }),
        ),
      ).rejects.toThrow(/runUnscoped/);
    });

    it('refuses to create a row for another organization', async () => {
      // "Cross-tenant writes are never implicit."
      await expect(
        asActor({ organizationId: org.a }, () =>
          prisma.client.walletHold.create({
            data: {
              id: `HLD_ITEST_${ulid()}`,
              organizationId: org.b,
              walletId: 'WLT_NOPE',
              amountMinor: 1n,
              currency: 'IRR',
              reference: 'x',
              referenceType: 'TRANSACTION',
              placedAt: new Date(),
              placedBy: 'itest',
            },
          }),
        ),
      ).rejects.toThrow(/never implicit|Cross-tenant/);
    });
  });

  describe('the oversight role reaches nothing', () => {
    it('is refused a wallet in its own organization', async () => {
      // CONSTRAINT (product document, ch. 4): province oversight is aggregate
      // only. Asserted here as well as in the unit suite, because this is the
      // path a real request takes.
      const { assertWalletVisible } = await import('../src/access/access');
      const wallet = await asActor({ organizationId: org.a }, () =>
        wiring.wallets.getOrOpen('IRR'),
      );

      expect(() =>
        runWithContext(
          {
            correlationId: 'itest',
            requestId: 'itest',
            organizationId: org.a,
            userId: 'USR-AUDITOR',
            roles: ['AUDITOR'],
            authType: 'USER',
            startedAt: Date.now(),
          },
          () => assertWalletVisible(wallet),
        ),
      ).toThrow(RastaError);
    });
  });
});
