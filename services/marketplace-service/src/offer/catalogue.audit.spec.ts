import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { EventPublisher } from '../events/publisher';
import { MARKETPLACE_EVENTS, validateMarketplacePayload } from '../events/events';
import type { PrismaService } from '../prisma/prisma.service';
import { CatalogueService } from './catalogue.service';

/**
 * Catalogue changes that used to publish nothing are audited (AGENTS.md S-06,
 * global audit L7-14): a product, a draft offer, and an offer change that
 * leaves it unpublished. One event each, in the write's transaction, under
 * the owning supplier's tenant.
 *
 * That the event and the row really commit together is proven against
 * PostgreSQL in `test/audit-records.int-spec.ts`.
 */

const SUPPLIER = 'ORG-SUPPLIER';
const T0 = new Date('2026-09-25T10:00:00.000Z');

function asSupplier<T>(fn: () => Promise<T>): Promise<T> {
  const context = {
    correlationId: 'COR_1',
    requestId: 'REQ_1',
    organizationId: SUPPLIER,
    userId: 'USR_SUP',
    roles: ['SUPPLIER'],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
  } as RequestContext;
  return runWithContext(context, fn);
}

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'OFR_1',
    organizationId: SUPPLIER,
    productId: 'PRD_1',
    unitPriceMinor: 250000n,
    currency: 'IRR',
    availableQuantity: 10,
    leadTimeDays: 3,
    minimumQuantity: 1,
    status: 'PUBLISHED',
    version: 1,
    publishedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function harness(existingOffer = offerRow()) {
  const enqueued: Array<{
    tx: unknown;
    eventName: string;
    organizationId: string;
    payload: unknown;
  }> = [];
  const tx = {
    product: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        status: 'ACTIVE',
        createdAt: T0,
      })),
      findUnique: jest.fn(async () => ({ id: 'PRD_1', status: 'ACTIVE' })),
    },
    offer: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        minimumQuantity: 1,
        version: 1,
        ...data,
        createdAt: T0,
      })),
      findUnique: jest.fn(async () => existingOffer),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existingOffer,
        ...data,
        updatedAt: T0,
      })),
    },
    offerPriceHistory: { create: jest.fn() },
  };
  const prisma = {
    client: tx,
    transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const events = {
    enqueue: jest.fn(
      async (
        client: unknown,
        input: { eventName: string; organizationId: string; payload: unknown },
      ) => {
        validateMarketplacePayload(input.eventName as never, input.payload);
        enqueued.push({ tx: client, ...input });
      },
    ),
  } as unknown as EventPublisher;

  return { tx, enqueued, service: new CatalogueService(prisma, events) };
}

describe('createProduct — audit', () => {
  it('records exactly one PRODUCT_CREATED, in the create transaction, under the supplier', async () => {
    const h = harness();

    const product = await asSupplier(() =>
      h.service.createProduct({
        sku: 'SKU-1',
        name: 'فیلتر روغن',
        category: 'PARTS',
        kind: 'GOODS',
        unit: 'EA',
      } as never),
    );

    expect(h.enqueued).toEqual([
      {
        tx: h.tx,
        eventName: MARKETPLACE_EVENTS.PRODUCT_CREATED,
        aggregateId: product.id,
        organizationId: SUPPLIER,
        payload: {
          productId: product.id,
          organizationId: SUPPLIER,
          sku: 'SKU-1',
          category: 'PARTS',
          kind: 'GOODS',
          unit: 'EA',
          createdBy: 'USR_SUP',
          createdAt: T0.toISOString(),
        },
      },
    ]);
  });
});

describe('createOffer — audit', () => {
  const dto = {
    productId: 'PRD_1',
    unitPriceMinor: '250000',
    currency: 'IRR',
    availableQuantity: 10,
    leadTimeDays: 3,
    minimumQuantity: 1,
  };

  it('records a draft as exactly one OFFER_DRAFTED', async () => {
    const h = harness();

    const offer = await asSupplier(() =>
      h.service.createOffer({ ...dto, publish: false } as never),
    );

    expect(h.enqueued.map((event) => event.eventName)).toEqual([MARKETPLACE_EVENTS.OFFER_DRAFTED]);
    expect(h.enqueued[0]).toMatchObject({
      tx: h.tx,
      organizationId: SUPPLIER,
      payload: { offerId: offer.id, supplierOrganizationId: SUPPLIER, version: 1 },
    });
  });

  it('records a published offer as OFFER_PUBLISHED alone, as before', async () => {
    const h = harness();

    await asSupplier(() => h.service.createOffer({ ...dto, publish: true } as never));

    expect(h.enqueued.map((event) => event.eventName)).toEqual([
      MARKETPLACE_EVENTS.OFFER_PUBLISHED,
    ]);
  });
});

describe('updateOffer — audit', () => {
  it('records withdrawing a published offer as exactly one OFFER_UPDATED', async () => {
    const h = harness();

    await asSupplier(() => h.service.updateOffer('OFR_1', { status: 'WITHDRAWN' } as never));

    expect(h.enqueued).toEqual([
      expect.objectContaining({
        tx: h.tx,
        eventName: MARKETPLACE_EVENTS.OFFER_UPDATED,
        organizationId: SUPPLIER,
        payload: expect.objectContaining({
          previousStatus: 'PUBLISHED',
          status: 'WITHDRAWN',
          changedFields: ['status'],
          updatedBy: 'USR_SUP',
        }),
      }),
    ]);
  });

  it('names only the fields that actually changed on a draft', async () => {
    const h = harness(offerRow({ status: 'DRAFT', publishedAt: null }));

    await asSupplier(() =>
      h.service.updateOffer('OFR_1', { unitPriceMinor: '300000', leadTimeDays: 3 } as never),
    );

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].payload).toMatchObject({
      changedFields: ['unitPriceMinor'],
      unitPriceMinor: '300000',
      version: 2,
    });
  });

  it('records nothing for a draft update that changed nothing', async () => {
    const h = harness(offerRow({ status: 'DRAFT', publishedAt: null }));

    await asSupplier(() => h.service.updateOffer('OFR_1', { leadTimeDays: 3 } as never));

    expect(h.enqueued).toEqual([]);
  });

  it('leaves a change to a published offer to OFFER_PUBLISHED, as before', async () => {
    const h = harness();

    await asSupplier(() => h.service.updateOffer('OFR_1', { availableQuantity: 4 } as never));

    expect(h.enqueued.map((event) => event.eventName)).toEqual([
      MARKETPLACE_EVENTS.OFFER_PUBLISHED,
    ]);
  });
});
