import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { databaseUrl, ownerDatabaseUrl, plantPaymentIntent, tenants } from './helpers';

/**
 * A payment intent's terms never change once written, and it is never erased (FU-230, migration
 * 20261109130000_payment_intent_terms_fixed). Written by hand as the runtime role, around the
 * service: only the lifecycle moves, `transaction_id` and `provider_reference` are written once.
 */
jest.setTimeout(60_000);

const FIXED = /A payment intent's amount, currency, wallet and terms never change once written/;
const ONCE =
  /A payment intent's transaction and provider reference are written once, then never change/;
const ERASED = /A payment intent is never erased \(DELETE refused\)/;

describe('a payment intent’s terms are fixed once written (real database)', () => {
  let runtime: PrismaClient;
  let owner: PrismaClient;
  const org = tenants();

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterAll(async () => {
    await plantPaymentIntent(
      'DELETE FROM payment_intent WHERE organization_id LIKE $1',
      `${org.a}%`,
    );
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  /** A CREATED intent, as the service writes one; its id. */
  const created = async () => {
    const id = `PAY_${ulid()}`;
    await runtime.$executeRawUnsafe(
      `INSERT INTO payment_intent (id, organization_id, wallet_id, provider, amount_minor, currency,
         idempotency_key, request_hash, correlation_id, created_by, created_by_issuer, created_by_subject)
       VALUES ($1, $2, $3, 'mock', 1000, 'IRR', $4, $5, 'itest', 'USR-ITEST', 'http://itest.invalid', 'SUB-ITEST')`,
      id,
      org.a,
      `WLT_${ulid()}`,
      `KEY-${id}`,
      'a'.repeat(64),
    );
    return id;
  };

  const update = (id: string, set: string, ...params: unknown[]) =>
    runtime.$executeRawUnsafe(`UPDATE payment_intent SET ${set} WHERE id = $1`, id, ...params);

  it('control: the whole lifecycle moves, each step once', async () => {
    const id = await created();
    await update(id, `status = 'AUTHORIZED', authorized_at = now(), provider_reference = 'PSP-1'`);
    await update(id, `failure_reason = 'CAPTURED_NOT_CREDITED'`);
    await update(
      id,
      `status = 'CAPTURED', captured_at = now(), transaction_id = $2, failure_reason = NULL`,
      `TXN_${ulid()}`,
    );
    await update(id, `failure_reason = 'REFUND_REQUESTED'`);
    await update(id, `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`);
    // Writing a written-once column again with the same value changes nothing, so it is no rewrite.
    await update(id, `provider_reference = 'PSP-1'`);
    const [row] = await owner.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status::text AS status FROM payment_intent WHERE id = $1',
      id,
    );
    expect(row!.status).toBe('REFUNDED');
  });

  it('control: a failure is recorded', async () => {
    const id = await created();
    await expect(
      update(id, `status = 'FAILED', failed_at = now(), failure_reason = 'DECLINED'`),
    ).resolves.toBe(1);
  });

  // The four the brief names first, then every other term.
  it.each([
    ['amount_minor', `amount_minor = 999999`],
    ['currency', `currency = 'USD'`],
    ['wallet_id', `wallet_id = 'WLT_SOMEONE_ELSES'`],
    ['organization_id', `organization_id = organization_id || '-X'`],
    ['provider', `provider = 'other'`],
    ['simulated', `simulated = false`],
    ['idempotency_key', `idempotency_key = 'KEY-OTHER'`],
    ['request_hash', `request_hash = NULL`],
    ['correlation_id', `correlation_id = 'other'`],
    ['created_at', `created_at = created_at - interval '1 day'`],
    ['created_by', `created_by = 'USR-OTHER'`],
    ['the creator identity', `created_by_issuer = NULL, created_by_subject = NULL`],
    ['id', `id = id || 'X'`],
  ])('a change of %s is refused, whatever the status', async (_column, set) => {
    const id = await created();
    await expect(update(id, set)).rejects.toThrow(FIXED);
    // Beside a lifecycle step, all the same.
    await expect(
      update(id, `status = 'AUTHORIZED', authorized_at = now(), ${set}`),
    ).rejects.toThrow(FIXED);
  });

  it.each([
    ['transaction_id', `transaction_id = 'TXN_OTHER'`, `transaction_id = NULL`],
    ['provider_reference', `provider_reference = 'PSP-OTHER'`, `provider_reference = NULL`],
  ])('%s, once written, is never rewritten or erased', async (_column, rewrite, erase) => {
    const id = await created();
    await update(
      id,
      `status = 'CAPTURED', authorized_at = now(), captured_at = now(), provider_reference = 'PSP-1',
       transaction_id = $2`,
      `TXN_${ulid()}`,
    );
    await expect(update(id, rewrite)).rejects.toThrow(ONCE);
    await expect(update(id, erase)).rejects.toThrow(ONCE);
  });

  it('the transaction it funds is named only as it is captured', async () => {
    const id = await created();
    await expect(update(id, `transaction_id = $2`, `TXN_${ulid()}`)).rejects.toThrow(
      /names the transaction it funds only as it is captured/,
    );
    await update(id, `status = 'AUTHORIZED', authorized_at = now()`);
    await expect(update(id, `transaction_id = $2`, `TXN_${ulid()}`)).rejects.toThrow(
      /names the transaction it funds only as it is captured/,
    );
  });

  it('a payment intent is never deleted', async () => {
    const id = await created();
    await expect(
      runtime.$executeRawUnsafe('DELETE FROM payment_intent WHERE id = $1', id),
    ).rejects.toThrow(ERASED);
  });

  it('nor truncated: the statement trigger stands, enabled, on the table', async () => {
    const [row] = await owner.$queryRawUnsafe<{ def: string; enabled: string }[]>(
      `SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled::text AS enabled
         FROM pg_trigger t
        WHERE t.tgrelid = 'payment_intent'::regclass AND t.tgname = 'trg_payment_intent_no_truncate'`,
    );
    expect(row?.def).toMatch(
      /BEFORE TRUNCATE ON \S*payment_intent FOR EACH STATEMENT EXECUTE FUNCTION \S*reject_payment_intent_rewrite\(\)/,
    );
    expect(row?.enabled).toBe('O');
  });
});
