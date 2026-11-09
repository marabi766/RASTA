import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import {
  cleanup,
  newOrderReference,
  newOrganizationId,
  newReturnRequestId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * The return-dispatch fence locks and then reads only under READ COMMITTED (FU-268, migration
 * 20261109120000_guards_read_committed). REPEATABLE READ and SERIALIZABLE read from before the
 * wait, so each guard refuses them once it holds the lock. Written by hand as the runtime role.
 */
describe('the return-dispatch fence holds under every isolation level (real database)', () => {
  let raw: PrismaClient;
  let owner: PrismaClient;
  const organizations: string[] = [];

  beforeAll(() => {
    raw = runtimeClient();
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await owner.$disconnect();
  });

  const org = () => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  type Raw = Pick<PrismaClient, '$executeRawUnsafe'>;

  const withdrawal = (tx: Raw, organizationId: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO return_dispatch_withdrawal (id, organization_id, return_request_id,
         reservation_id, withdrawn_at, withdrawn_by, correlation_id)
       VALUES ($1, $2, $3, $4, now(), 'marketplace-service', 'raw')`,
      `RDW_${ulid()}`,
      organizationId,
      newReturnRequestId(),
      `RDR_${ulid()}`,
    );

  // Refused by the BEFORE trigger, ahead of the row's own constraints: no warehouse is needed.
  const shipment = (tx: Raw, organizationId: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO return_shipment (id, organization_id, destination_warehouse_id,
         buyer_organization_id, return_request_id, order_id, line_count, status,
         command_key_hash, created_at, created_by, created_correlation_id, updated_at, version,
         dispatch_reservation_id)
       VALUES ($1, $2, 'WHS_NONE', $3, $4, $5, 1, 'IN_TRANSIT', $6, now(), 'USR-RAW', 'raw', now(), 1, $7)`,
      `RSP_${ulid()}`,
      organizationId,
      `${organizationId}-BUYER`,
      newReturnRequestId(),
      newOrderReference(),
      'f'.repeat(64),
      `RDR_${ulid()}`,
    );

  it('control: under READ COMMITTED a withdrawal is recorded', async () => {
    await expect(raw.$transaction((tx) => withdrawal(tx, org()))).resolves.toBe(1);
  });

  describe.each(['RepeatableRead', 'Serializable'] as const)('under %s', (isolationLevel) => {
    it('a withdrawal is refused', async () => {
      await expect(
        raw.$transaction((tx) => withdrawal(tx, org()), { isolationLevel }),
      ).rejects.toThrow(/A guard that locks and then reads runs only under READ COMMITTED/);
    });

    it('a shipment is refused', async () => {
      await expect(
        raw.$transaction((tx) => shipment(tx, org()), { isolationLevel }),
      ).rejects.toThrow(/A guard that locks and then reads runs only under READ COMMITTED/);
    });
  });

  it('no function of the schema takes an advisory lock but the gate', async () => {
    const rows = await owner.$queryRawUnsafe<{ proname: string }[]>(
      `SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = current_schema()::regnamespace
          AND p.prosrc ~* 'pg_(try_)?advisory_'
          AND p.proname <> 'read_committed_xact_lock'
        ORDER BY 1`,
    );
    expect(rows.map((row) => row.proname)).toEqual([]);
  });
});
