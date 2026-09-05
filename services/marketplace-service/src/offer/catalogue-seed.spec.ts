import { SEED_PRODUCTS, assertDatasetIsConsistent, seedSearchText } from '../../prisma/seed';
import { searchTextFor } from './catalogue.service';

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
