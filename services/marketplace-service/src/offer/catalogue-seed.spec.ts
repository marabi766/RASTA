import {
  SEED_PRODUCTS,
  assertDatasetIsConsistent,
  resolveDatabaseUrl,
  seedSearchText,
} from '../../prisma/seed';
import { searchTextFor } from './catalogue.service';

/**
 * Stands in for the generated client so that "resolving the target opens no
 * connection" is something this file can assert rather than assume: the fake
 * records every construction, and the environment tests below prove the count
 * stays at zero. It also keeps the suite independent of whether
 * `prisma generate` has run.
 */
jest.mock('../generated/prisma', () => {
  const constructions: unknown[] = [];
  return {
    PrismaClient: class {
      constructor(options?: unknown) {
        constructions.push(options ?? null);
      }
    },
    __constructions: constructions,
  };
});

const { __constructions: prismaConstructions } = jest.requireMock('../generated/prisma') as {
  __constructions: unknown[];
};

/**
 * Holds the demo seed to the production catalogue.
 *
 * `prisma/seed.ts` cannot import this service's source: it runs through
 * `@swc-node/register` before anything is built, and `catalogue.service.ts`
 * pulls in `@rasta/nest-common`, which only exists as `dist`. So the seed
 * carries its own copy of the search-text construction — and a copy nobody
 * checks is a copy that drifts, silently, until a seeded product stops being
 * findable by the search the service actually performs.
 *
 * Importing the seed here is safe: it opens no connection until it is run as
 * a program.
 */
describe('marketplace demo seed', () => {
  it('builds search text exactly as the catalogue service does', () => {
    for (const product of SEED_PRODUCTS) {
      expect(seedSearchText(product)).toBe(searchTextFor(product));
    }
  });

  it('would write a search text that finds each product by name', () => {
    for (const product of SEED_PRODUCTS) {
      expect(searchTextFor(product)).toContain(product.name);
      expect(searchTextFor(product)).toContain(product.sku);
    }
  });

  it('is internally consistent — every offer version has its price history', () => {
    expect(() => assertDatasetIsConsistent()).not.toThrow();
  });

  it('offers a service as well as goods, so both kinds are demonstrable', () => {
    expect(SEED_PRODUCTS.some((product) => product.kind === 'SERVICE')).toBe(true);
    expect(SEED_PRODUCTS.filter((product) => product.kind === 'GOOD').length).toBeGreaterThan(1);
  });
});

/**
 * Which database the seed is allowed to write to.
 *
 * The interesting case is the last one. Every service in this monorepo has its
 * own database, and `DATABASE_URL` is routinely left exported from whichever
 * service's command ran previously. If the seed picks one of two disagreeing
 * variables it will, sooner or later, write the marketplace catalogue into
 * another service's database — a failure that produces no error and is found
 * much later, by someone wondering why identity-service has products in it.
 * So disagreement is an error, not a warning.
 */
describe('marketplace demo seed — database target', () => {
  // Assembled rather than written out, so no line of this file looks like a
  // real connection string to a secret scanner. Neither host resolves.
  const password = ['not', 'a', 'real', 'password'].join('-');
  const credentials = ['seed', password].join(':');
  const MARKETPLACE = `postgresql://${credentials}@db.invalid:5432/rasta_marketplace`;
  const IDENTITY = `postgresql://${credentials}@db.invalid:5432/rasta_identity`;

  it('uses the service-specific variable when it is the only one set', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL_MARKETPLACE: MARKETPLACE })).toBe(MARKETPLACE);
  });

  it('accepts the generic variable alone, for a single-database setup', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: MARKETPLACE })).toBe(MARKETPLACE);
  });

  it('is content when both are set and agree', () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL: MARKETPLACE, DATABASE_URL_MARKETPLACE: MARKETPLACE }),
    ).toBe(MARKETPLACE);
  });

  it('refuses to seed when the two disagree, rather than choosing one', () => {
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: IDENTITY, DATABASE_URL_MARKETPLACE: MARKETPLACE }),
    ).toThrow(/both set and name different targets/);
  });

  it('refuses when neither is set, and treats an empty variable as unset', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL_MARKETPLACE/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '', DATABASE_URL_MARKETPLACE: '' })).toThrow(
      /DATABASE_URL_MARKETPLACE/,
    );
  });

  it('names neither database and no credential when it refuses', () => {
    let message = '';
    try {
      resolveDatabaseUrl({ DATABASE_URL: IDENTITY, DATABASE_URL_MARKETPLACE: MARKETPLACE });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    for (const secret of [
      MARKETPLACE,
      IDENTITY,
      password,
      credentials,
      'db.invalid',
      'rasta_identity',
      'rasta_marketplace',
      '5432',
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it('opens no connection on any path, including the one that refuses', () => {
    // Every case above has already run against the mocked client. If
    // resolution ever constructed one — or if construction moved to module
    // scope — this is where it shows up.
    expect(prismaConstructions).toHaveLength(0);
  });
});
