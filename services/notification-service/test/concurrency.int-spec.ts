import { ulid } from 'ulid';
import {
  cleanup,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  rowsFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The properties a single-threaded test cannot prove (PROJECT_MEMORY § 30).
 *
 * The dedupe decision and the claim are both "first writer wins" rules
 * enforced by the database — a primary-key upsert and `FOR UPDATE SKIP
 * LOCKED`. Fifty concurrent ingests of one fact must produce one intent;
 * fifty concurrent claims of one batch must hand every intent to exactly one
 * worker. Both are asserted with `Promise.all`, not in sequence.
 */
describe('concurrency', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  it('50 concurrent distinct events about one fact produce exactly one intent', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const policyId = `POL_${ulid()}`;

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 20 })),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'SKIPPED')).toHaveLength(49);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(1);
    expect(rows.dedupe).toHaveLength(1);
    expect(rows.dedupe[0]!.seenCount).toBe(50);
    expect(rows.dedupe[0]!.intentId).toBe(rows.intents[0]!.id);
  }, 120_000);

  it('50 concurrent workers claim a batch of 30 intents with no overlap', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    for (let i = 0; i < 30; i += 1) {
      await deliver(
        w,
        insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
    }

    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => w.repository.claimPending(`worker-${i}`, 3, 60)),
    );
    // The claim is cross-tenant by construction, so an earlier test's leftover
    // intent may ride along; the property under test is counted on this
    // organization's rows only.
    const ids = claims
      .flat()
      .filter((intent) => intent.organizationId === organizationId)
      .map((intent) => intent.id);

    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(claims.filter((claim) => claim.length > 0).length).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('concurrent ticks over one backlog dispatch every intent exactly once', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const user = newUserId();
    w.recipients.answers.set(organizationId, [{ userId: user, role: 'FLEET_MANAGER' }]);
    for (let i = 0; i < 20; i += 1) {
      await deliver(
        w,
        insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
    }

    const processed = await Promise.all(Array.from({ length: 8 }, () => w.worker.tick()));
    // At least this organization's twenty; the claim is cross-tenant, so
    // another suite's leftovers may add to the sum but never to the rows below.
    expect(processed.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(20);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents.every((intent) => intent.status === 'DISPATCHED')).toBe(true);
    expect(rows.deliveries).toHaveLength(20);
    expect(rows.inApp).toHaveLength(20);
    expect(new Set(rows.inApp.map((row) => row.intentId)).size).toBe(20);
  }, 120_000);
});
