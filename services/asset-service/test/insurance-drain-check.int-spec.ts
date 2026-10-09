import { ulid } from 'ulid';
import { checkOutboxDrained } from '../src/insurance/drain-check.command';
import { PrismaService } from '../src/prisma/prisma.service';
import { newPrisma, tenants } from './helpers';

/**
 * The outbox half of `insurance:drain-check` (#240 round 5), against the real
 * `outbox_message` table: a row with no `published_at` refuses the change, one
 * that has been published does not.
 *
 * The database is shared with other suites, whose unpublished rows must not
 * decide this test: the count is narrowed to this suite's own organization
 * (the command itself never narrows).
 */
describe('insurance:drain-check — outbox (#240 r5)', () => {
  const org = tenants();
  let prisma: PrismaService;

  const queue = async (organizationId: string): Promise<string> => {
    const id = ulid();
    await prisma.client.$executeRaw`
      INSERT INTO outbox_message (id, aggregate_type, aggregate_id, event_name, topic,
                                  partition_key, payload, headers, correlation_id, organization_id)
      VALUES (${id}, 'InsurancePolicy', ${id}, 'INSURANCE_RECORDED', 'rasta.insurance.v1',
              ${id}, '{}'::jsonb, '{}'::jsonb, ${id}, ${organizationId})`;
    return id;
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.client.$executeRaw`
      DELETE FROM outbox_message WHERE organization_id = ANY(${[org.a, org.b]}::text[])`;
    await prisma.onModuleDestroy();
  });

  it('reports drained when the organization has no unpublished row', async () => {
    await expect(checkOutboxDrained(prisma, org.b)).resolves.toEqual({
      unpublished: 0,
      drained: true,
    });
  });

  it('refuses while a row is unpublished, and counts only unpublished ones', async () => {
    const first = await queue(org.a);
    await queue(org.a);

    await expect(checkOutboxDrained(prisma, org.a)).resolves.toEqual({
      unpublished: 2,
      drained: false,
    });
    // Another organization's rows are not this one's.
    await expect(checkOutboxDrained(prisma, org.b)).resolves.toMatchObject({ drained: true });

    await prisma.client.$executeRaw`
      UPDATE outbox_message SET published_at = now() WHERE id = ${first}`;
    await expect(checkOutboxDrained(prisma, org.a)).resolves.toMatchObject({ unpublished: 1 });
  });

  it('with no narrowing it counts the whole table, so any unpublished row refuses', async () => {
    await queue(org.a);
    const whole = await checkOutboxDrained(prisma);
    expect(whole.drained).toBe(false);
    expect(whole.unpublished).toBeGreaterThanOrEqual(1);
  });
});
