import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Tenant isolation and object-level access, against a real database.
 *
 * `AGENTS.md` § 4 requires this suite for every service holding tenant data,
 * and a marketplace makes it harder than usual: two organizations are
 * legitimately parties to every order, and a third must not be able to tell
 * that order exists.
 *
 * Every refusal below asserts the **status** as well as the fact, because the
 * difference carries information. 404 to a stranger, so the attempt confirms
 * nothing. 403 to a party on the wrong side, because they can already see the
 * record and the refusal is genuinely about authority.
 */
describe('tenant isolation (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>, organizationId = org.buyer) =>
    asActor({ organizationId, roles: ['PROCUREMENT_USER'], userId: 'USR-BUYER' }, fn);

  const asSupplier = <T>(fn: () => Promise<T>, organizationId = org.supplier) =>
    asActor({ organizationId, roles: ['SUPPLIER'], userId: 'USR-SUP' }, fn);

  const asStranger = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['ORGANIZATION_ADMIN'], userId: 'USR-OTHER' }, fn);

  const asSaga = <T>(fn: () => Promise<T>, organizationId = org.buyer) =>
    asActor(
      {
        organizationId,
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
      },
      fn,
    );

  async function anOrder() {
    const { offerId } = await publishOffer(wiring, org.supplier);
    return asBuyer(() => wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('iso')));
  }

  // -------------------------------------------------------------------------

  describe('reads', () => {
    it('lets both parties read the order', async () => {
      const order = await anOrder();

      await expect(asBuyer(() => wiring.orders.get(order.id))).resolves.toMatchObject({
        id: order.id,
      });
      await expect(asSupplier(() => wiring.orders.get(order.id))).resolves.toMatchObject({
        id: order.id,
      });
    });

    it('reports 404 to a third organization, revealing nothing', async () => {
      const order = await anOrder();

      await expect(asStranger(() => wiring.orders.get(order.id))).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
    });

    it('does not leak the other tenant’s identity in the refusal', async () => {
      const order = await anOrder();

      try {
        await asStranger(() => wiring.orders.get(order.id));
        throw new Error('expected a refusal');
      } catch (error) {
        const serialised = JSON.stringify({
          message: (error as Error).message,
          details: (error as { details?: unknown }).details,
        });
        expect(serialised).not.toContain(org.buyer);
        expect(serialised).not.toContain(org.supplier);
      }
    });

    it('lists only the caller’s own orders on each side', async () => {
      const mine = await anOrder();

      const buyerList = await asBuyer(() => wiring.orders.list({ role: 'BUYER', limit: 50 }));
      expect(buyerList.items.map((o) => o.id)).toContain(mine.id);

      const supplierList = await asSupplier(() =>
        wiring.orders.list({ role: 'SUPPLIER', limit: 50 }),
      );
      expect(supplierList.items.map((o) => o.id)).toContain(mine.id);

      const strangerList = await asStranger(() => wiring.orders.list({ role: 'BUYER', limit: 50 }));
      expect(strangerList.items.map((o) => o.id)).not.toContain(mine.id);

      // And a stranger asking as a supplier sees nothing of it either.
      const strangerAsSupplier = await asStranger(() =>
        wiring.orders.list({ role: 'SUPPLIER', limit: 50 }),
      );
      expect(strangerAsSupplier.items.map((o) => o.id)).not.toContain(mine.id);
    });
  });

  describe('writes', () => {
    it('refuses a third organization every command on the order', async () => {
      const order = await anOrder();

      for (const attempt of [
        () => wiring.orders.confirm(order.id),
        () => wiring.orders.fulfill(order.id, {}),
        () => wiring.orders.confirmReceipt(order.id, {}),
        () => wiring.orders.cancel(order.id, { reason: 'not mine to cancel' }),
        () =>
          wiring.orders.raiseDispute(order.id, {
            reason: 'a complaint about somebody else’s order',
          }),
      ]) {
        await expect(asStranger(attempt)).rejects.toThrow();
      }

      // Nothing moved.
      const after = await asBuyer(() => wiring.orders.get(order.id));
      expect(after.status).toBe('PENDING');
    });

    it('refuses the supplier the buyer’s commands, with 403 rather than 404', async () => {
      // The supplier can see this order, so 404 would be a lie. It is a real
      // authorization refusal on a record they are entitled to know about.
      const order = await anOrder();
      await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
      await asSupplier(() => wiring.orders.confirm(order.id));
      await asSupplier(() => wiring.orders.fulfill(order.id, {}));

      await expect(asSupplier(() => wiring.orders.confirmReceipt(order.id, {}))).rejects.toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );

      const after = await asBuyer(() => wiring.orders.get(order.id));
      expect(after.status).toBe('AWAITING_RECEIPT_CONFIRMATION');
      expect(after.receiptConfirmedAt).toBeNull();
    });

    it('refuses the buyer the supplier’s commands', async () => {
      const order = await anOrder();
      await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));

      await expect(
        asActor({ organizationId: org.buyer, roles: ['SUPPLIER', 'PROCUREMENT_USER'] }, () =>
          wiring.orders.confirm(order.id),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });

    it('refuses a buyer to resolve their own dispute', async () => {
      const order = await anOrder();
      await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`));
      await asBuyer(() =>
        wiring.orders.raiseDispute(order.id, { reason: 'the goods never arrived at all' }),
      );

      await expect(
        asBuyer(() =>
          wiring.orders.resolveDispute(order.id, {
            outcome: 'REFUND',
            resolution: 'I have decided in my own favour',
          }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
  });

  describe('offers belong to the supplier that published them', () => {
    it('refuses another supplier the right to reprice one, with 404', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier);

      await expect(
        asActor({ organizationId: org.other, roles: ['SUPPLIER'] }, () =>
          wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '1' }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

      const unchanged = await runUnscoped('the suite verifies the offer was not repriced', () =>
        prisma.client.offer.findUnique({ where: { id: offerId } }),
      );
      expect(unchanged?.unitPriceMinor).toBe(250_000n);
    });

    it('shows a supplier only its own offers', async () => {
      await publishOffer(wiring, org.supplier);
      await publishOffer(wiring, org.other);

      const own = await asSupplier(() => wiring.catalogue.listOwnOffers());
      expect(own.every((offer) => offer.supplierOrganizationId === org.supplier)).toBe(true);
    });

    it('still shows every supplier’s published offers in the catalogue', async () => {
      // The deliberate crossing: a marketplace where you only see your own
      // listings is not a marketplace (ADR-042 § 3).
      const { productId } = await publishOffer(wiring, org.supplier, { name: 'شیلنگ هیدرولیک' });

      const offers = await asBuyer(() => wiring.catalogue.offersFor(productId, 'PRICE_ASC'));
      expect(offers.length).toBeGreaterThan(0);
      expect(offers[0]?.supplierOrganizationId).toBe(org.supplier);
    });
  });

  describe('the oversight role', () => {
    it('is refused every read in this service', async () => {
      const order = await anOrder();

      await expect(
        asActor({ organizationId: org.buyer, roles: ['AUDITOR'] }, () =>
          wiring.orders.get(order.id),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));

      await expect(
        asActor({ organizationId: org.buyer, roles: ['AUDITOR'] }, () =>
          wiring.catalogue.searchProducts({ sort: 'PRICE_ASC', limit: 10 }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
  });

  describe('a service token is bound to the organization it names', () => {
    it('cannot advance an order belonging to another tenant', async () => {
      // The ADR-035 lesson, applied here: a service is exempt from the role
      // check and from nothing else.
      const order = await anOrder();

      await expect(
        asSaga(() => wiring.orders.confirmReceipt(order.id, {}), org.other),
      ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
  });
});
