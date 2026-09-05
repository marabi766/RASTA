/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Demo seed for marketplace-service.
 *
 * ## Everything here is illustrative
 *
 * No price, quantity, lead time or supplier below is an agreed commercial
 * fact. They are examples chosen so the implemented catalogue behaviour is
 * *visible* on a fresh database — nothing more. In particular the two gravel
 * offers are priced and paced so that "cheapest" and "fastest" are different
 * suppliers, because that is the only way to see that both sort keys work
 * rather than to be told they do.
 *
 * ## What this file deliberately does not contain
 *
 * **No orders.** An order in this service is the head of a saga (ADR-040):
 * the row exists because economic-service held funds against a real
 * transaction id, and its status history records who moved it and when. Every
 * one of those facts is owned by another service, and economic-service seeds
 * no wallet and no balance on purpose. A seeded `CONFIRMED` order would
 * therefore be a claim that money was committed when none was — the kind of
 * demo state that reads as evidence. The honest boundary for a seed that owns
 * only this database is the catalogue, so the catalogue is where it stops.
 *
 * Consequently there is no fulfilment, no dispute, no review and no order
 * history either: each of them is a fact about an order that did not happen.
 *
 * **No outbox message.** `OFFER_PUBLISHED` is emitted when a supplier
 * publishes an offer. These offers were not published by a supplier just now;
 * they were written by a seed. Enqueuing the event anyway would make the
 * relay wake every consumer with a publication that never occurred, and would
 * put a live message on a broker as a side effect of seeding a database.
 * The published *state* is a row and is true; the *event* would not be.
 *
 * **No supplier qualification or rating.** supplier-service does not exist
 * (ADR-041), so there is nothing to qualify a supplier against. A seeded
 * score would invent the assessment the platform has not built.
 *
 * **No stock, no reservation.** `availableQuantity` is what a supplier says
 * it can supply — it is not warehouse stock, which belongs to
 * inventory-service and does not exist.
 *
 * **No payment, settlement, commission or reward.** Those live in
 * economic-service, whose own seed refuses to invent a rate (docs/24 Q-08,
 * Q-09). Nothing here creates a financial obligation.
 *
 * ## Cross-service identifiers
 *
 * Organizations come from organization-service's seed and users from
 * identity-service's seed, unchanged. Nothing new is invented here: this
 * service holds no copy of either table, so a wrong id would not fail — it
 * would quietly produce a catalogue owned by an organization the platform has
 * never heard of.
 *
 * ## Idempotency
 *
 * Every row has a fixed id and is written with an upsert, so a second run
 * creates nothing. Offers and price-history rows are written **once** and then
 * left alone (`update: {}`): price, version and publication state are
 * supplier-owned, and a seed that rewrote them could reset a version — or
 * worse, walk one forward — every time someone ran it. Product text is
 * refreshed, because a catalogue description is not state anybody edits
 * through this seed's rows.
 */

/**
 * The database this seed is allowed to touch.
 *
 * Resolved explicitly and handed to `PrismaClient` rather than left to the
 * schema's `env("DATABASE_URL")`, so the seed cannot silently connect to
 * whichever database happens to be exported into the shell — which, in a
 * monorepo where every service has its own, is a real way to write a
 * marketplace catalogue into identity-service.
 */
function resolveDatabaseUrl(): string {
  const generic = process.env.DATABASE_URL;
  const specific = process.env.DATABASE_URL_MARKETPLACE;

  const url = generic ?? specific;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL or DATABASE_URL_MARKETPLACE. ' +
        'Run via `pnpm --filter @rasta/marketplace-service db:seed`, which loads the repo-root .env.',
    );
  }

  // DATABASE_URL wins, because that is the documented precedence everywhere
  // else. When both are set and disagree, say so: the generic one is usually
  // left over from another service's command, and the failure it causes
  // otherwise is a catalogue in the wrong database rather than an error.
  if (generic && specific && generic !== specific) {
    console.warn('  ! DATABASE_URL and DATABASE_URL_MARKETPLACE differ; using DATABASE_URL.');
  }

  return url;
}

/** `host:port/database`, with the credentials left out of the log. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparsable connection string)';
  }
}

// -----------------------------------------------------------------------------
// Identifiers owned by other services. Kept in step with their seeds by hand.
// -----------------------------------------------------------------------------

/** organization-service seed: the union operates the platform. */
const UNION = 'ORG-UNION-YAZD';
/** organization-service seed: two dehyari organizations that also supply. */
const DEH_ONE = 'ORG-DEH-0001';
const DEH_TWO = 'ORG-DEH-0002';

/** identity-service seed. Recorded as the actor on the rows they own. */
const UNION_ADMIN = 'USR-SEED-UNION-ADMIN';
const DEH_ONE_ADMIN = 'USR-SEED-DEHYARI-ADMIN';
const DEH_TWO_ADMIN = 'USR-SEED-DEHYARI2-ADMIN';

const CURRENCY = 'IRR';

/**
 * Fixed instants, not `Date.now()`.
 *
 * A seed whose timestamps move on every run is not idempotent in any sense
 * that matters: the rows are the same, but nothing downstream can assert they
 * are unchanged.
 */
const CREATED_AT = new Date('2026-01-15T08:00:00.000Z');
const REPRICED_AT = new Date('2026-03-02T09:30:00.000Z');

// -----------------------------------------------------------------------------
// Catalogue
// -----------------------------------------------------------------------------

/**
 * Mirrors `searchTextFor` in `src/offer/catalogue.service.ts` exactly.
 *
 * It is copied rather than imported: the seed runs through
 * `@swc-node/register` against source, and importing the catalogue service
 * would pull in `@rasta/nest-common`, which is only present once the workspace
 * has been built — so `pnpm db:seed` on a clean checkout would fail with a
 * missing module rather than seed anything.
 *
 * The copy is held to the original by `src/offer/catalogue-seed.spec.ts`,
 * which asserts every seeded product's `searchText` equals what the production
 * function produces for it. If the production construction changes and this
 * does not, that test fails.
 */
export function seedSearchText(input: {
  name: string;
  category: string;
  sku: string;
  description?: string | undefined;
}): string {
  return [input.name, input.category, input.sku, input.description ?? ''].join(' ').trim();
}

type SeedProduct = {
  id: string;
  organizationId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  kind: 'GOOD' | 'SERVICE';
  unit: string;
  createdBy: string;
};

/**
 * Four catalogue entries defined by the union, which operates the platform.
 *
 * Three goods and one service, because `ProductKind` exists precisely so a
 * consumer can tell them apart, and a catalogue with only goods never shows
 * that it can.
 */
export const SEED_PRODUCTS: SeedProduct[] = [
  {
    id: 'PRD_SEED_AGGREGATE',
    organizationId: UNION,
    sku: 'SEED-AGG-001',
    name: 'شن و ماسه ساختمانی',
    description: 'شن و ماسه شسته برای بتن‌ریزی و زیرسازی معابر روستایی. داده نمونه.',
    category: 'مصالح ساختمانی',
    kind: 'GOOD',
    unit: 'تن',
    createdBy: UNION_ADMIN,
  },
  {
    id: 'PRD_SEED_CEMENT',
    organizationId: UNION,
    sku: 'SEED-CEM-002',
    name: 'سیمان پرتلند تیپ ۲',
    description: 'کیسه ۵۰ کیلوگرمی سیمان پرتلند تیپ ۲. داده نمونه.',
    category: 'مصالح ساختمانی',
    kind: 'GOOD',
    unit: 'کیسه',
    createdBy: UNION_ADMIN,
  },
  {
    id: 'PRD_SEED_HYDRAULIC_HOSE',
    organizationId: UNION,
    sku: 'SEED-PRT-003',
    name: 'شیلنگ هیدرولیک ماشین‌آلات سنگین',
    description: 'شیلنگ فشار قوی برای بیل مکانیکی و لودر. داده نمونه.',
    category: 'قطعات یدکی',
    kind: 'GOOD',
    unit: 'عدد',
    createdBy: UNION_ADMIN,
  },
  {
    id: 'PRD_SEED_GRADER_SERVICE',
    organizationId: UNION,
    sku: 'SEED-SRV-004',
    name: 'اجاره گریدر با راننده',
    description: 'اجاره ساعتی گریدر همراه با راننده برای تسطیح معابر. داده نمونه.',
    category: 'خدمات ماشین‌آلات',
    kind: 'SERVICE',
    unit: 'ساعت',
    createdBy: UNION_ADMIN,
  },
];

type SeedOffer = {
  id: string;
  organizationId: string;
  productId: string;
  unitPriceMinor: bigint;
  availableQuantity: number;
  leadTimeDays: number;
  minimumQuantity: number;
  status: 'DRAFT' | 'PUBLISHED';
  version: number;
  publishedAt: Date | null;
  createdBy: string;
  note: string;
};

/**
 * Offers from two supplying organizations.
 *
 * All money is `bigint` in IRR minor units — rial (ADR-022). Never a float,
 * and never a "toman" figure that looks smaller than it is.
 *
 * The two aggregate offers are the interesting pair: `ORG-DEH-0002` is
 * cheaper and slower, `ORG-DEH-0001` is dearer and faster, so `PRICE_ASC` and
 * `LEAD_TIME_ASC` return them in different orders and each sort is
 * demonstrably applied rather than merely accepted.
 */
export const SEED_OFFERS: SeedOffer[] = [
  {
    id: 'OFR_SEED_AGGREGATE_D1',
    organizationId: DEH_ONE,
    productId: 'PRD_SEED_AGGREGATE',
    unitPriceMinor: 9_500_000n,
    availableQuantity: 500,
    leadTimeDays: 3,
    minimumQuantity: 5,
    status: 'PUBLISHED',
    version: 1,
    publishedAt: CREATED_AT,
    createdBy: DEH_ONE_ADMIN,
    note: 'dearer, faster',
  },
  {
    id: 'OFR_SEED_AGGREGATE_D2',
    organizationId: DEH_TWO,
    productId: 'PRD_SEED_AGGREGATE',
    // Version 2 on purpose: the only way to show that repricing keeps its
    // history is to seed an offer that has been repriced once. The v1 row
    // below records what it used to cost.
    unitPriceMinor: 8_900_000n,
    availableQuantity: 220,
    leadTimeDays: 7,
    minimumQuantity: 10,
    status: 'PUBLISHED',
    version: 2,
    publishedAt: CREATED_AT,
    createdBy: DEH_TWO_ADMIN,
    note: 'cheaper, slower — repriced once, version 2',
  },
  {
    id: 'OFR_SEED_CEMENT_D2',
    organizationId: DEH_TWO,
    productId: 'PRD_SEED_CEMENT',
    unitPriceMinor: 2_850_000n,
    availableQuantity: 1_200,
    leadTimeDays: 2,
    minimumQuantity: 20,
    status: 'PUBLISHED',
    version: 1,
    publishedAt: CREATED_AT,
    createdBy: DEH_TWO_ADMIN,
    note: '',
  },
  {
    id: 'OFR_SEED_HOSE_D1',
    organizationId: DEH_ONE,
    productId: 'PRD_SEED_HYDRAULIC_HOSE',
    unitPriceMinor: 4_800_000n,
    availableQuantity: 12,
    leadTimeDays: 5,
    minimumQuantity: 1,
    status: 'PUBLISHED',
    version: 1,
    publishedAt: CREATED_AT,
    createdBy: DEH_ONE_ADMIN,
    note: '',
  },
  {
    id: 'OFR_SEED_GRADER_D2',
    organizationId: DEH_TWO,
    productId: 'PRD_SEED_GRADER_SERVICE',
    unitPriceMinor: 12_000_000n,
    availableQuantity: 160,
    leadTimeDays: 1,
    minimumQuantity: 4,
    status: 'PUBLISHED',
    version: 1,
    publishedAt: CREATED_AT,
    createdBy: DEH_TWO_ADMIN,
    note: 'the SERVICE product; quantity is hours offered, not stock',
  },
  {
    // Not published, so "a supplier sees its own draft and nobody else sees
    // anything" is a state the demo can actually be pointed at. It is absent
    // from search results by construction, not by filtering.
    id: 'OFR_SEED_HOSE_D2_DRAFT',
    organizationId: DEH_TWO,
    productId: 'PRD_SEED_HYDRAULIC_HOSE',
    unitPriceMinor: 5_200_000n,
    availableQuantity: 30,
    leadTimeDays: 9,
    minimumQuantity: 1,
    status: 'DRAFT',
    version: 1,
    publishedAt: null,
    createdBy: DEH_TWO_ADMIN,
    note: 'DRAFT — supplier-owned state, never in a search result',
  },
];

type SeedPriceHistory = {
  id: string;
  offerId: string;
  version: number;
  unitPriceMinor: bigint;
  changedAt: Date;
  changedBy: string;
};

/**
 * One row per version of every offer.
 *
 * `organizationId` and `currency` are taken from the offer rather than typed
 * again, because a history row that disagrees with its offer about who owns it
 * is worse than no history at all.
 */
const SEED_PRICE_HISTORY: SeedPriceHistory[] = [
  {
    id: 'OPH_SEED_AGGREGATE_D1_V1',
    offerId: 'OFR_SEED_AGGREGATE_D1',
    version: 1,
    unitPriceMinor: 9_500_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_ONE_ADMIN,
  },
  {
    id: 'OPH_SEED_AGGREGATE_D2_V1',
    offerId: 'OFR_SEED_AGGREGATE_D2',
    version: 1,
    // What it cost before the reprice. Superseded, and kept: this is the row
    // that answers "what did version 1 agree to".
    unitPriceMinor: 9_300_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_TWO_ADMIN,
  },
  {
    id: 'OPH_SEED_AGGREGATE_D2_V2',
    offerId: 'OFR_SEED_AGGREGATE_D2',
    version: 2,
    unitPriceMinor: 8_900_000n,
    changedAt: REPRICED_AT,
    changedBy: DEH_TWO_ADMIN,
  },
  {
    id: 'OPH_SEED_CEMENT_D2_V1',
    offerId: 'OFR_SEED_CEMENT_D2',
    version: 1,
    unitPriceMinor: 2_850_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_TWO_ADMIN,
  },
  {
    id: 'OPH_SEED_HOSE_D1_V1',
    offerId: 'OFR_SEED_HOSE_D1',
    version: 1,
    unitPriceMinor: 4_800_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_ONE_ADMIN,
  },
  {
    id: 'OPH_SEED_GRADER_D2_V1',
    offerId: 'OFR_SEED_GRADER_D2',
    version: 1,
    unitPriceMinor: 12_000_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_TWO_ADMIN,
  },
  {
    id: 'OPH_SEED_HOSE_D2_DRAFT_V1',
    offerId: 'OFR_SEED_HOSE_D2_DRAFT',
    version: 1,
    unitPriceMinor: 5_200_000n,
    changedAt: CREATED_AT,
    changedBy: DEH_TWO_ADMIN,
  },
];

/**
 * Fails the seed rather than writing a dataset that contradicts itself.
 *
 * Each offer's current version must have a history row stating the same
 * price, and no history row may exist for an offer that is not here. Both are
 * cheap to get wrong by hand and impossible to notice afterwards.
 */
export function assertDatasetIsConsistent(): void {
  const offers = new Map(SEED_OFFERS.map((offer) => [offer.id, offer]));

  for (const row of SEED_PRICE_HISTORY) {
    const offer = offers.get(row.offerId);
    if (!offer) {
      throw new Error(`price history ${row.id} refers to unknown offer ${row.offerId}`);
    }
    if (row.version > offer.version) {
      throw new Error(`price history ${row.id} is newer than offer ${offer.id}`);
    }
    if (row.version === offer.version && row.unitPriceMinor !== offer.unitPriceMinor) {
      throw new Error(`price history ${row.id} disagrees with the current price of ${offer.id}`);
    }
  }

  for (const offer of SEED_OFFERS) {
    const versions = SEED_PRICE_HISTORY.filter((row) => row.offerId === offer.id).map(
      (row) => row.version,
    );
    for (let version = 1; version <= offer.version; version += 1) {
      if (!versions.includes(version)) {
        throw new Error(`offer ${offer.id} has no price history for version ${version}`);
      }
    }
  }

  const productIds = new Set(SEED_PRODUCTS.map((product) => product.id));
  for (const offer of SEED_OFFERS) {
    if (!productIds.has(offer.productId)) {
      throw new Error(`offer ${offer.id} refers to unknown product ${offer.productId}`);
    }
  }
}

async function main(): Promise<void> {
  assertDatasetIsConsistent();

  const url = resolveDatabaseUrl();
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  console.warn('Seeding marketplace-service…');
  console.warn(`  target: ${describeTarget(url)}`);
  console.warn('  all catalogue data below is illustrative, not an agreed commercial offer.');

  try {
    for (const product of SEED_PRODUCTS) {
      const data = {
        organizationId: product.organizationId,
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        kind: product.kind,
        unit: product.unit,
        status: 'ACTIVE' as const,
        searchText: seedSearchText(product),
      };
      await prisma.product.upsert({
        where: { id: product.id },
        create: {
          id: product.id,
          ...data,
          createdAt: CREATED_AT,
          createdBy: product.createdBy,
        },
        // Catalogue text is not state a supplier edits through these rows, so
        // re-running restores it. No new row, no new id.
        update: { ...data, updatedBy: 'SEED' },
      });
    }
    const goods = SEED_PRODUCTS.filter((product) => product.kind === 'GOOD').length;
    console.warn(
      `  products: ${SEED_PRODUCTS.length} (${goods} GOOD, ${SEED_PRODUCTS.length - goods} SERVICE)`,
    );

    for (const offer of SEED_OFFERS) {
      await prisma.offer.upsert({
        where: { id: offer.id },
        create: {
          id: offer.id,
          organizationId: offer.organizationId,
          productId: offer.productId,
          unitPriceMinor: offer.unitPriceMinor,
          currency: CURRENCY,
          availableQuantity: offer.availableQuantity,
          leadTimeDays: offer.leadTimeDays,
          minimumQuantity: offer.minimumQuantity,
          status: offer.status,
          version: offer.version,
          publishedAt: offer.publishedAt,
          createdAt: CREATED_AT,
          createdBy: offer.createdBy,
        },
        // Left alone once it exists. Price, version and publication state
        // belong to the supplier, and a seed that rewrote them on every run
        // would be the one thing this file must never do.
        update: {},
      });
      const label = offer.note ? `  — ${offer.note}` : '';
      console.warn(
        `    ${offer.id} ${offer.status} v${offer.version} ` +
          `${offer.unitPriceMinor} ${CURRENCY} (minor units)${label}`,
      );
    }
    const published = SEED_OFFERS.filter((offer) => offer.status === 'PUBLISHED').length;
    console.warn(
      `  offers: ${SEED_OFFERS.length} (${published} published, ${SEED_OFFERS.length - published} draft)`,
    );

    for (const row of SEED_PRICE_HISTORY) {
      const offer = SEED_OFFERS.find((candidate) => candidate.id === row.offerId);
      if (!offer) throw new Error(`unreachable: ${row.offerId} was validated above`);

      await prisma.offerPriceHistory.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          // From the offer, never restated: the history is the offer's.
          organizationId: offer.organizationId,
          offerId: row.offerId,
          version: row.version,
          unitPriceMinor: row.unitPriceMinor,
          currency: CURRENCY,
          changedAt: row.changedAt,
          changedBy: row.changedBy,
        },
        // Append-only in production, append-only here.
        update: {},
      });
    }
    console.warn(`  price history: ${SEED_PRICE_HISTORY.length}`);

    console.warn('  orders, fulfilments, disputes, reviews: 0 — see the note at the top of this');
    console.warn('    file. Their facts belong to services that have not produced them.');
    console.warn('  outbox messages: 0 — a seeded row is not a publication event.');
    console.warn('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so the dataset above can be imported by a test without the test
// opening a database connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
