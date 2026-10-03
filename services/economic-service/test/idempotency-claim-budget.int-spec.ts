import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import { CLAIM_WAIT_MS, IdempotencyStore } from '../src/shared/idempotency';
import { apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * A claim waits on another transaction's lock on its key only within its
 * budget (#196 review), against the real database: the two claim-side
 * statements that can wait — the insert, and the removal of an expired row —
 * each meet a competing transaction the test holds open, and each answers the
 * retryable in-flight 409 with `Retry-After` after about {@link CLAIM_WAIT_MS},
 * never a hang. Once the holder lets go, the same claim goes through.
 */
describe('an Idempotency-Key claim bounded by its budget (real database)', () => {
  let harness: ApiHarness;
  let store: IdempotencyStore;

  const org = apiTenant('CLAIM-BUDGET');
  const ENDPOINT = 'POST /v1/claim-budget-test';
  let counter = 0;
  const newKey = () => `claim-budget-${Date.now()}-${(counter += 1)}`;

  beforeAll(async () => {
    harness = await startApi();
    store = harness.app.get(IdempotencyStore);
  });

  afterAll(async () => {
    await runUnscoped('remove the claim-budget test rows', () =>
      harness.prisma.client.$executeRawUnsafe(
        `DELETE FROM idempotency_key WHERE organization_id = $1`,
        org,
      ),
    );
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(createSystemContext({ correlationId: 'claim-budget', organizationId: org }), fn);

  /**
   * A competing transaction that runs `sql` and then stays open until
   * `finish` is called — committing it, or rolling it back.
   */
  function holdOpen(sql: string, params: unknown[]) {
    let signal!: () => void;
    const ready = new Promise<void>((resolve) => (signal = resolve));
    let settle!: (outcome: 'commit' | 'rollback') => void;
    const decided = new Promise<'commit' | 'rollback'>((resolve) => (settle = resolve));
    const done = runUnscoped('a competing transaction the test holds open', () =>
      harness.prisma.client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(sql, ...params);
          signal();
          if ((await decided) === 'rollback') throw new Error('rolled back by the test');
        },
        { timeout: 30_000 },
      ),
    ).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'rolled back by the test')) throw error;
    });
    return { ready, finish: settle, done };
  }

  async function refusedWithinBudget(claim: () => Promise<unknown>): Promise<void> {
    const started = Date.now();
    await expect(claim()).rejects.toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(CLAIM_WAIT_MS - 1_000);
    expect(waited).toBeLessThan(CLAIM_WAIT_MS + 2_500);
  }

  it('bounds the insert that waits behind an uncommitted competing insert of the same key', async () => {
    const key = newKey();
    const body = { case: 'insert' };
    const competitor = holdOpen(
      `INSERT INTO idempotency_key (key, organization_id, endpoint, request_hash, state, expires_at)
       VALUES ($1, $2, $3, 'competitor', 'IN_PROGRESS', now() + interval '1 hour')`,
      [key, org, ENDPOINT],
    );
    await competitor.ready;

    await refusedWithinBudget(() => asTenant(() => store.claim(ENDPOINT, key, body)));

    // The competitor rolls back: the key was never taken, and the claim goes through.
    competitor.finish('rollback');
    await competitor.done;
    await expect(asTenant(() => store.claim(ENDPOINT, key, body))).resolves.toMatchObject({
      kind: 'PROCEED',
    });
  }, 30_000);

  it('bounds the removal of an expired row that a cleanup is still holding', async () => {
    const key = newKey();
    const body = { case: 'expired' };
    await runUnscoped('seed an expired claim', () =>
      harness.prisma.client.$executeRawUnsafe(
        `INSERT INTO idempotency_key
           (key, organization_id, endpoint, request_hash, state, created_at, expires_at)
         VALUES ($1, $2, $3, 'expired', 'IN_PROGRESS',
                 now() - interval '1 hour', now() - interval '1 second')`,
        key,
        org,
        ENDPOINT,
      ),
    );
    const cleanupHolder = holdOpen(
      `SELECT 1 FROM idempotency_key
       WHERE organization_id = $2 AND endpoint = $3 AND key = $1 FOR UPDATE`,
      [key, org, ENDPOINT],
    );
    await cleanupHolder.ready;

    await refusedWithinBudget(() => asTenant(() => store.claim(ENDPOINT, key, body)));

    // The cleanup lets go: the expired row is removed and the claim goes through.
    cleanupHolder.finish('commit');
    await cleanupHolder.done;
    await expect(asTenant(() => store.claim(ENDPOINT, key, body))).resolves.toMatchObject({
      kind: 'PROCEED',
    });
  }, 30_000);
});
