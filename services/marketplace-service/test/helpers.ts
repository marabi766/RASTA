import { ulid } from 'ulid';
import { runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { IdempotencyStore } from '../src/shared/idempotency';
import { OrderRepository } from '../src/order/order.repository';
import { OrderService } from '../src/order/order.service';
import { CatalogueService } from '../src/offer/catalogue.service';
import { loadMarketplaceEnv, type MarketplaceEnv } from '../src/config/env';

/**
 * Scaffolding for the integration tests.
 *
 * Deliberately thin. The point of these suites is that they touch a real
 * PostgreSQL — the row locks, the CHECK constraints and the partial unique
 * index exist only in the database, so anything that hides it behind a helper
 * defeats them.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_MARKETPLACE;
  if (!url) {
    throw new Error(
      'DATABASE_URL_MARKETPLACE is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return url;
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

export function testEnv(): MarketplaceEnv {
  return loadMarketplaceEnv({
    ...process.env,
    DATABASE_URL: databaseUrl(),
    // The suites drive the services directly; no worker is started.
    MARKETPLACE_TEMPORAL_ENABLED: 'false',

    // These suites never verify a token: they call the domain services with an
    // explicit `RequestContext`, so no OIDC discovery and no internal token is
    // ever exchanged. The schema still demands them because the running
    // service needs them, and turbo passes only its declared env list through —
    // so without these the suite fails on configuration that has no bearing on
    // what it tests. Throwaway values, never used to sign or verify anything.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI:
      process.env.OIDC_JWKS_URI ??
      'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE ?? 'rasta-api',
    INTERNAL_TOKEN_SECRET:
      process.env.INTERNAL_TOKEN_SECRET ?? 'integration_suite_unused_secret_32_chars',
  });
}

export interface Wiring {
  prisma: PrismaService;
  env: MarketplaceEnv;
  events: EventPublisher;
  idempotency: IdempotencyStore;
  repository: OrderRepository;
  orders: OrderService;
  catalogue: CatalogueService;
}

/**
 * Wires the domain services by hand.
 *
 * Not through Nest: booting the container would start the outbox relay, which
 * drains every pending row platform-wide and makes the outbox assertions in
 * these suites depend on a timer. economic-service learned that one under
 * `--coverage`, where the relay emptied the table before the test could read it.
 */
export function wire(prisma: PrismaService): Wiring {
  const env = testEnv();
  const events = new EventPublisher(env);
  const idempotency = new IdempotencyStore(prisma, env);
  const repository = new OrderRepository(prisma);
  const orders = new OrderService(prisma, repository, events, env);
  const catalogue = new CatalogueService(prisma, events);

  return { prisma, env, events, idempotency, repository, orders, catalogue };
}

/**
 * Three organizations, generated fresh per run.
 *
 * Generated rather than fixed so a re-run cannot collide with rows an earlier
 * run left behind, and so the isolation tests prove isolation between tenants
 * that genuinely exist rather than between a tenant and an empty set.
 */
export function tenants() {
  const suffix = ulid().slice(-10);
  return {
    buyer: `ORG-ITEST-BUY-${suffix}`,
    supplier: `ORG-ITEST-SUP-${suffix}`,
    other: `ORG-ITEST-OTH-${suffix}`,
  };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
  authType?: 'USER' | 'SERVICE';
  callerService?: string;
  correlationId?: string;
}

/** Runs `fn` as a user (or service) acting for an organization. */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    requestId: ulid(),
    correlationId: options.correlationId ?? `itest-${ulid()}`,
    organizationId: options.organizationId,
    authType: options.authType ?? 'USER',
    roles: options.roles ?? ['ORGANIZATION_ADMIN'],
    startedAt: Date.now(),
    ...(options.userId ? { userId: options.userId } : { userId: 'USR-ITEST' }),
    ...(options.callerService ? { callerService: options.callerService } : {}),
  } as RequestContext;

  return runWithContext(context, fn);
}

/** A unique idempotency key per call site. */
export function key(prefix: string): string {
  return `${prefix}-${ulid()}`;
}

/** Removes everything the named organizations wrote. */
export async function cleanup(
  prisma: PrismaService,
  organizationIds: readonly string[],
): Promise<void> {
  const orgs = [...organizationIds];
  const client = prisma.client;

  await runUnscoped('the integration suite removes what it wrote, across tenants', async () => {
    await client.$executeRawUnsafe(
      `DELETE FROM review WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM order_dispute WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM order_status_history WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM fulfillment WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM order_line WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM "order" WHERE organization_id = ANY($1::text[])
         OR supplier_organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM offer_price_history WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM offer WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM product WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM idempotency_key WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
  });
}

/** Reads the outbox for one organization, in the order rows were written. */
export function outboxFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped('the outbox audit reads platform plumbing', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

/**
 * A product and a published offer, ready to order.
 *
 * The catalogue entry is defined by the supplier here; nothing in the domain
 * requires that, and a buyer-defined product would work the same way.
 */
export async function publishOffer(
  wiring: Wiring,
  supplierOrganizationId: string,
  options: {
    unitPriceMinor?: string;
    availableQuantity?: number;
    minimumQuantity?: number;
    leadTimeDays?: number;
    name?: string;
  } = {},
): Promise<{ productId: string; offerId: string }> {
  return asActor(
    { organizationId: supplierOrganizationId, roles: ['SUPPLIER'], userId: 'USR-ITEST-SUP' },
    async () => {
      const product = await wiring.catalogue.createProduct({
        sku: `SKU-${ulid().slice(-10)}`,
        name: options.name ?? 'بیل مکانیکی — قطعه یدکی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      });

      const offer = await wiring.catalogue.createOffer({
        productId: product.id,
        unitPriceMinor: options.unitPriceMinor ?? '250000',
        currency: 'IRR',
        availableQuantity: options.availableQuantity ?? 10,
        leadTimeDays: options.leadTimeDays ?? 3,
        minimumQuantity: options.minimumQuantity ?? 1,
        publish: true,
      });

      return { productId: product.id, offerId: offer.id };
    },
  );
}
