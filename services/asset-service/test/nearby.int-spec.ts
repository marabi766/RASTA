import { zodPipe } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { nearbyQuerySchema } from '../src/asset/dto';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * `GET /v1/assets/nearby` against real PostGIS.
 *
 * The radius search is raw SQL, so it is outside the Prisma tenant extension
 * and outside anything a mocked repository could prove. Two properties need a
 * real database to mean anything:
 *
 *   1. `availableOnly` selects a **status set**, and the difference between
 *      the two sets is only visible against rows that actually exist.
 *   2. Tenant scoping is passed by hand into the SQL. A mock returns whatever
 *      it was told to; only the database can show that a neighbouring
 *      dehyari's machines stay invisible.
 *
 * The parameter used `z.coerce.boolean()`, under which every non-empty string
 * is true, so `?availableOnly=false` narrowed the search to dispatchable
 * assets — the opposite of the request. The failure was invisible in exactly
 * the way that matters: the response was a shorter list of real assets, not an
 * error, so "where are my machines" quietly stopped showing the ones in for
 * maintenance.
 */
describe('nearby search', () => {
  let prisma: PrismaService;
  let service: AssetService;

  const pipe = zodPipe(nearbyQuerySchema);
  const org = tenants();
  // Yazd, and a point ~40 km away — comfortably outside the 5 km radius used
  // below, so "out of range" is a distance rather than a rounding accident.
  const HERE = { latitude: 31.8974, longitude: 54.3569 };

  /** One asset with a current location, written the way production writes it. */
  async function place(
    organizationId: string,
    status: string,
    at: { latitude: number; longitude: number } = HERE,
  ): Promise<string> {
    const assetId = id('AST');

    await prisma.client.$executeRawUnsafe(
      `INSERT INTO asset
         (id, organization_id, name, type, status,
          created_at, updated_at, created_by, updated_by)
       VALUES ($1, $2, $3, 'LOADER'::"AssetType", $4::"OperationalStatus",
               now(), now(), 'USR-ITEST', 'USR-ITEST')`,
      assetId,
      organizationId,
      `itest ${status}`,
      status,
    );

    // `point` is `Unsupported("geography(Point,4326)")`, so Prisma cannot write
    // it — the same reason the search itself is raw SQL.
    await prisma.client.$executeRawUnsafe(
      `INSERT INTO asset_location
         (id, asset_id, organization_id, point, source, is_current, recorded_at, recorded_by)
       VALUES ($1, $2, $3,
               ST_SetSRID(ST_MakePoint($4::float8, $5::float8), 4326)::geography,
               'MANUAL'::"LocationSource", true, now(), $6)`,
      id('ALOC'),
      assetId,
      organizationId,
      at.longitude,
      at.latitude,
      'USR-ITEST',
    );

    return assetId;
  }

  /**
   * A request, from the raw query string inwards.
   *
   * `availableOnly` is passed as the **string** a client actually sends and
   * parsed by the real pipe the controller uses, not handed to the service as
   * a boolean. That is the whole point: by the time a caller has written
   * `availableOnly: false` in TypeScript, the defect has already been parsed
   * away and the test proves nothing about it.
   */
  const search = (organizationId: string, availableOnly?: string) =>
    asActor({ organizationId }, () =>
      service.nearby(
        pipe.transform(
          {
            latitude: String(HERE.latitude),
            longitude: String(HERE.longitude),
            radiusMeters: '5000',
            limit: '50',
            ...(availableOnly === undefined ? {} : { availableOnly }),
          },
          { type: 'query' },
        ),
      ),
    );

  let active: string;
  let idle: string;
  let inMaintenance: string;
  let outOfService: string;
  let neighbours: string;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    service = new AssetService(new AssetRepository(prisma));

    active = await place(org.a, 'ACTIVE');
    idle = await place(org.a, 'IDLE');
    inMaintenance = await place(org.a, 'IN_MAINTENANCE');
    outOfService = await place(org.a, 'OUT_OF_SERVICE');
    neighbours = await place(org.b, 'ACTIVE');
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset_location WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM asset WHERE organization_id = ANY($1::text[])`,
      [org.a, org.b],
    );
    await prisma.onModuleDestroy();
  });

  it('returns every status in range when the flag is omitted', async () => {
    const found = (await search(org.a)).map((row) => row.id);

    expect(found).toEqual(expect.arrayContaining([active, idle, inMaintenance, outOfService]));
  });

  it('returns the same set for availableOnly=false as for omitting it', async () => {
    // The regression, at the level where it was visible to a user: under the
    // coercion this call returned the dispatchable subset, silently dropping
    // the machines in maintenance and out of service.
    const omitted = (await search(org.a)).map((row) => row.id).sort();
    const explicit = (await search(org.a, 'false')).map((row) => row.id).sort();

    expect(explicit).toEqual(omitted);
    expect(explicit).toEqual(expect.arrayContaining([inMaintenance, outOfService]));
  });

  it('returns only dispatchable statuses for availableOnly=true', async () => {
    const found = await search(org.a, 'true');

    expect(found.map((row) => row.id)).toEqual(expect.arrayContaining([active, idle]));
    expect(found.map((row) => row.id)).not.toEqual(expect.arrayContaining([inMaintenance]));
    expect(found.map((row) => row.id)).not.toEqual(expect.arrayContaining([outOfService]));
    for (const row of found) expect(['ACTIVE', 'IDLE']).toContain(row.status);
  });

  it('never returns another organization’s assets, under either flag', async () => {
    // The scoping is passed by hand into raw SQL, so it is exactly as good as
    // the caller remembering to pass it. Both branches build their own query;
    // both are checked.
    for (const flag of [undefined, 'false', 'true']) {
      const found = await search(org.a, flag);
      expect(found.map((row) => row.id)).not.toContain(neighbours);
    }

    // And from the other side: org B sees its own machine and none of org A's.
    const theirs = await search(org.b);
    expect(theirs.map((row) => row.id)).toEqual([neighbours]);
  });
});
