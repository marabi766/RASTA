import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { cleanup, databaseUrl, newOrganizationId } from './helpers';

/**
 * What the database keeps whatever a future write path forgets (ADR-068, migration
 * `init_contract`): the price is positive, the parties are two organizations, what a
 * contract was made from never changes, a contract is never erased — and the runtime role
 * cannot lift any of it (D-045). Every statement is raw SQL through the **runtime** role,
 * with no tenant guard in between, because it is the database that is under test.
 */
describe('the contract table’s own guarantees', () => {
  let runtime: PrismaClient;
  const organizations: string[] = [];

  async function insert(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; org: string }> {
    const org = (overrides.organization_id as string | undefined) ?? newOrganizationId();
    organizations.push(org);
    // One instant for every column that carries one, as the service writes them.
    const at = new Date();
    const row: Record<string, unknown> = {
      id: `CTR_${ulid()}`,
      organization_id: org,
      tender_id: `TND_${ulid()}`,
      project_id: `PRJ_${ulid()}`,
      winning_bid_id: `BID_${ulid()}`,
      contractor_organization_id: newOrganizationId(),
      amount_minor: 1_000_000n,
      matrix_digest: 'c'.repeat(64),
      awarded_by: 'USR_x',
      awarded_at: at,
      status_changed_at: at,
      status_changed_by: 'service:contract-service',
      source_event_id: ulid(),
      created_at: at,
      created_by: 'service:contract-service',
      created_correlation_id: ulid(),
      updated_at: at,
      ...overrides,
    };
    const columns = Object.keys(row);
    await runtime.$executeRawUnsafe(
      `INSERT INTO "contract" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns
        .map((_, i) => `$${i + 1}`)
        .join(', ')})`,
      ...columns.map((c) => row[c]),
    );
    return { id: row.id as string, org };
  }

  /** The SQLSTATE or message of a refusal — the guarantee, not the driver's wording. */
  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    return String((error as Error).message);
  };

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await cleanup(organizations);
    await runtime.$disconnect();
  });

  describe('the row’s invariants', () => {
    it('accepts a well-formed draft', async () => {
      await expect(insert()).resolves.toBeDefined();
    });

    it.each([
      ['a zero price', { amount_minor: 0n }, 'ck_contract_amount_positive'],
      ['a negative price', { amount_minor: -5n }, 'ck_contract_amount_positive'],
      [
        'a contract with oneself',
        { contractor_organization_id: 'SAME' },
        'ck_contract_parties_distinct',
      ],
      ['a digest that is not SHA-256 hex', { matrix_digest: 'ABC' }, 'ck_contract_matrix_digest'],
      ['a blank tender', { tender_id: '  ' }, 'ck_contract_text_not_blank'],
      ['a blank winning bid', { winning_bid_id: '' }, 'ck_contract_text_not_blank'],
      ['an unnamed awarding person', { awarded_by: ' ' }, 'ck_contract_actor_recorded'],
      ['no source event', { source_event_id: '' }, 'ck_contract_actor_recorded'],
      ['version 0', { version: 0 }, 'ck_contract_version_positive'],
      [
        'a status that predates the contract',
        { status_changed_at: new Date('2001-01-01T00:00:00Z') },
        'ck_contract_timestamps_ordered',
      ],
    ])('refuses %s', async (_label, change, constraint) => {
      const org = newOrganizationId();
      const overrides: Record<string, unknown> = change;
      const resolved =
        overrides.contractor_organization_id === 'SAME'
          ? { ...overrides, organization_id: org, contractor_organization_id: org }
          : overrides;
      const message = await refusal(insert(resolved));
      expect(message).toContain(constraint);
    });

    it('refuses a second contract for one tender of one organization', async () => {
      const first = await insert();
      const [row] = await runtime.$queryRawUnsafe<{ tender_id: string }[]>(
        'SELECT tender_id FROM "contract" WHERE id = $1',
        first.id,
      );
      const message = await refusal(
        insert({ organization_id: first.org, tender_id: row!.tender_id }),
      );
      // 23505 unique_violation, on (organization_id, tender_id) — the consumer's last backstop.
      expect(message).toContain('23505');
      expect(message).toMatch(/\(organization_id, tender_id\)/);
    });

    it('refuses an amount beyond bigint rather than rounding it', async () => {
      const message = await refusal(insert({ amount_minor: '9223372036854775808' }));
      expect(message.toLowerCase()).toMatch(/out of range|overflow|bigint|numeric/);
    });
  });

  describe('what a contract was made from never changes, and a contract is never erased', () => {
    it.each([
      ['amount_minor', 2_000_000n],
      ['contractor_organization_id', 'ORG_someoneelse'],
      ['winning_bid_id', 'BID_other'],
      ['tender_id', 'TND_other'],
      ['organization_id', 'ORG_other'],
      ['matrix_digest', 'd'.repeat(64)],
      ['created_by', 'USR_forged'],
    ])('refuses to change %s', async (column, value) => {
      const { id } = await insert();
      const message = await refusal(
        runtime.$executeRawUnsafe(
          `UPDATE "contract" SET "${column}" = $1 WHERE id = $2`,
          value,
          id,
        ),
      );
      expect(message).toContain('ck_contract_origin_immutable');
    });

    it('lets the status and version move along a declared transition, which is all a change may touch', async () => {
      const { id } = await insert();
      const changed = await runtime.$executeRawUnsafe(
        `UPDATE "contract" SET "status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "version" = "version" + 1, "updated_at" = now(), "status_changed_at" = now() WHERE id = $1`,
        id,
      );
      expect(changed).toBe(1);
    });

    it('refuses to delete a contract', async () => {
      const { id } = await insert();
      const message = await refusal(
        runtime.$executeRawUnsafe('DELETE FROM "contract" WHERE id = $1', id),
      );
      expect(message).toContain('ck_contract_not_erasable');
    });

    it('refuses to truncate the table', async () => {
      await insert();
      await refusal(runtime.$executeRawUnsafe('TRUNCATE TABLE "contract"'));
    });
  });

  describe('the runtime role cannot lift a guard (D-045)', () => {
    it('cannot disable the trigger, drop it, or alter the table', async () => {
      await refusal(
        runtime.$executeRawUnsafe('ALTER TABLE "contract" DISABLE TRIGGER "tg_contract_guard"'),
      );
      await refusal(runtime.$executeRawUnsafe('DROP TRIGGER "tg_contract_guard" ON "contract"'));
      await refusal(runtime.$executeRawUnsafe('ALTER TABLE "contract" ADD COLUMN d045_probe int'));
      await refusal(runtime.$executeRawUnsafe('CREATE TABLE "d045_probe" (id int)'));
    });

    it('owns nothing, and is not a superuser or a member of the migrator', async () => {
      const [facts] = await runtime.$queryRawUnsafe<
        { owned: bigint; is_super: boolean; can_create: boolean; in_migrator: boolean }[]
      >(
        `SELECT (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned,
                r.rolsuper AS is_super,
                has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create,
                pg_has_role(r.oid, 'rasta_contract_migrator', 'MEMBER') AS in_migrator
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(facts).toEqual({ owned: 0n, is_super: false, can_create: false, in_migrator: false });
    });
  });

  describe('time is stored with its zone (D-048)', () => {
    it('every instant column of this service’s tables is timestamptz', async () => {
      const columns = await runtime.$queryRawUnsafe<
        { table_name: string; column_name: string; data_type: string }[]
      >(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('contract', 'outbox_message')
            AND (column_name LIKE '%\\_at' OR data_type LIKE 'timestamp%')`,
      );
      // contract: awarded_at, status_changed_at, created_at, updated_at; outbox_message:
      // created_at, published_at, claim_expires_at, next_attempt_at.
      expect(columns).toHaveLength(8);
      for (const column of columns) {
        expect([column.table_name, column.column_name, column.data_type]).toEqual([
          column.table_name,
          column.column_name,
          'timestamp with time zone',
        ]);
      }
    });

    it('keeps money as bigint, never a float or numeric', async () => {
      const [column] = await runtime.$queryRawUnsafe<{ data_type: string }[]>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'contract' AND column_name = 'amount_minor'`,
      );
      expect(column?.data_type).toBe('bigint');
    });
  });
});
