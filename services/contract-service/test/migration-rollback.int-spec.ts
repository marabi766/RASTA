import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import { person, startApi, type ApiHarness } from './api-helpers';
import { cleanup, seedDraft, wire, type Wiring } from './helpers';

/**
 * The migrations' rollbacks never destroy what is immutable (the precedent of #208 and #222). A
 * signature is the audit record of who accepted a contract, a cancellation reason is why it ended,
 * and an approval policy is who was allowed to sign for an employer: a `down.sql` that dropped
 * them would leave SIGNED and CANCELLED contracts with nothing behind them. So each stops, with a
 * message, once the data exists, and changes nothing.
 *
 * Each script is `LOCK TABLE …; DO $preflight_… $$ … $$;` and then the drops. The suite runs the
 * lock and the check — not the drops — against this database, in a transaction that is rolled back
 * whatever happens, with rows that exist. That the scripts are the exact inverse of their
 * migrations on an unused database (up → down → up) is `verify-migration-reversible.mjs contract`.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

function preflightOf(migration: string, name: string) {
  const text = readFileSync(join(MIGRATIONS, migration, 'down.sql'), 'utf8');
  const lock = /^LOCK TABLE [^;]+;/m.exec(text)?.[0];
  const check = new RegExp(`DO \\$${name}\\$[\\s\\S]*?\\$${name}\\$;`).exec(text)?.[0];
  expect(lock).toContain('ACCESS EXCLUSIVE');
  expect(check).toBeDefined();
  // Locked, then checked, and only then anything dropped.
  const firstDrop = text.search(/^(DROP|ALTER TABLE .* DROP|CREATE OR REPLACE)/m);
  expect(text.indexOf(lock!)).toBeLessThan(text.indexOf(check!));
  expect(text.indexOf(check!)).toBeLessThan(firstDrop);
  return { lock: lock!.replace(/;$/, ''), check: check!.replace(/;$/, '') };
}

describe('the migrations’ rollbacks refuse once their data exists', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const runPreflight = (migration: string, name: string) => {
    const { lock, check } = preflightOf(migration, name);
    return w.prisma.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(lock);
      await tx.$executeRawUnsafe(check);
    });
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  const sign = (id: string, token: string) =>
    request(api.app.getHttpServer())
      .post(`/v1/contracts/${id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `rollback-${ulid()}`)
      .send({});

  it('signing_policy: refuses while a policy exists, naming it, and touches nothing', async () => {
    const { id, employer } = await seedDraft(w, organizations);
    await sign(id, person(employer, ['ORGANIZATION_ADMIN'])).expect(200);

    await expect(runPreflight('20261005150000_signing_policy', 'preflight_policy')).rejects.toThrow(
      /down refused: \d+ approval polic\(ies\) and \d+ employer signature\(s\) name them; nothing was changed/,
    );
    const policies = await w.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "approval_policy" WHERE "organization_id" = $1`,
      employer,
    );
    const signatures = await w.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "contract_signature" WHERE "organization_id" = $1 AND "policy_id" IS NOT NULL`,
      employer,
    );
    expect([Number(policies[0]!.n), Number(signatures[0]!.n)]).toEqual([1, 1]);
  });

  it('contract_sign_cancel: refuses while a signature or a SIGNED or CANCELLED contract exists, and touches nothing', async () => {
    const signed = await seedDraft(w, organizations);
    await sign(signed.id, person(signed.employer, ['ORGANIZATION_ADMIN'])).expect(200);
    await sign(signed.id, person(signed.contractor, ['CONTRACTOR'])).expect(200);
    const cancelled = await seedDraft(w, organizations);
    await request(api.app.getHttpServer())
      .post(`/v1/contracts/${cancelled.id}/cancel`)
      .set('authorization', `Bearer ${person(cancelled.employer, ['ORGANIZATION_ADMIN'])}`)
      .set('idempotency-key', `rollback-${ulid()}`)
      .send({ reasonCode: 'OTHER', note: 'the terms were not agreed' })
      .expect(200);

    await expect(
      runPreflight('20261005140000_contract_sign_cancel', 'preflight_sign_cancel'),
    ).rejects.toThrow(
      /down refused: \d+ signature\(s\) and \d+ signed or cancelled contract\(s\) exist; nothing was changed/,
    );
    const rows = await w.prisma.client.$queryRawUnsafe<{ status: string; reason: string | null }[]>(
      `SELECT "status"::text AS status, "cancel_reason_code" AS reason FROM "contract"
        WHERE "organization_id" IN ($1, $2) ORDER BY "status"`,
      signed.employer,
      cancelled.employer,
    );
    expect(rows).toEqual([
      { status: 'CANCELLED', reason: 'OTHER' },
      { status: 'SIGNED', reason: null },
    ]);
  });
});
