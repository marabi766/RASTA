import { createHash } from 'node:crypto';
import { canonicalMeterCertificate, METER_CERTIFICATE_LIMIT } from '@rasta/contracts';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { MeterCertificateService } from '../src/fleet/meter-certificate';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/** Real PostgreSQL locks: no injected repository/page or transaction implementation. */
describe('fleet source certificate snapshot', () => {
  const org = tenants();
  let assetId: string;
  const prisma = newPrisma();
  const service = new MeterCertificateService(prisma);
  const certificate = (callerService = 'maintenance-service', requestedAsset = assetId) =>
    runWithContext(
      createSystemContext({ organizationId: org.a, callerService, correlationId: 'snapshot-test' }),
      async () => service.certificate({ assetId: requestedAsset }),
    );
  beforeEach(() => {
    assetId = id('AST');
  });
  afterEach(async () => {
    await cleanup(prisma, [org.a, org.b]);
  });
  afterAll(async () => {
    await prisma.stop();
  });

  it('takes one snapshot: tail/backdated commits after the marker appear exactly once only in the next certificate', async () => {
    const baseline = id('USG');
    const fact = (recordId: string, organizationId: string, end: string) => ({
      id: recordId,
      organizationId,
      assetId,
      recordedBy: 'ITEST',
      hours: '2.50',
      periodStart: new Date(new Date(end).getTime() - 60 * 60 * 1000),
      periodEnd: new Date(end),
    });
    await asActor({ organizationId: org.a }, () =>
      prisma.client.usageRecord.create({
        data: fact(baseline, org.a, '2026-01-03T00:00:00Z'),
      }),
    );
    let locked!: () => void;
    let release!: () => void;
    const atLock = new Promise<void>((r) => {
      locked = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const tail = id('USG');
    const backdated = id('USG');
    const writer = asActor({ organizationId: org.b }, () =>
      prisma.transaction(
        async (tx) => {
          await tx.$executeRaw`LOCK TABLE usage_record IN ACCESS EXCLUSIVE MODE`;
          locked();
          await barrier;
          await tx.usageRecord.createMany({
            data: [
              fact(tail, org.b, '2026-01-04T00:00:00Z'),
              fact(backdated, org.b, '2026-01-02T00:00:00Z'),
            ],
          });
        },
        { timeoutMs: 15_000 },
      ),
    );
    await atLock;
    const pending = certificate();
    try {
      const until = Date.now() + 5000;
      for (;;) {
        const [row] = await prisma.client.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE 'SELECT%usage_record%') AS waiting`;
        if (row.waiting) break;
        if (Date.now() > until) throw new Error('certificate never reached the real table lock');
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      release();
    }
    await writer;
    const first = await pending;
    expect(first.facts.map((r) => r.id)).toEqual([baseline]);
    const next = await certificate();
    expect(next.facts.map((r) => r.id).sort()).toEqual([baseline, tail, backdated].sort());
    expect(next.digest).toBe(
      createHash('sha256').update(canonicalMeterCertificate(next)).digest('hex'),
    );
    expect(next.facts.find((r) => r.id === tail)!.organizationId).toBe(org.b);
    expect(next.facts.every((r) => Object.keys(r).length === 8)).toBe(true);
  });
  it('refuses oversized history instead of issuing a truncated proof', async () => {
    await asActor({ organizationId: org.a }, () =>
      prisma.client.usageRecord.createMany({
        data: Array.from({ length: METER_CERTIFICATE_LIMIT + 1 }, () => ({
          id: id('USG'),
          assetId,
          organizationId: org.a,
          recordedBy: 'ITEST',
          hours: '1',
          periodStart: new Date('2026-01-01T00:00:00Z'),
          periodEnd: new Date('2026-01-02T00:00:00Z'),
        })),
      }),
    );
    await expect(certificate()).rejects.toThrow();
  });
  it('refuses a user and every other service before reading cross-owner facts', async () => {
    const emptyAsset = id('AST'); // Admission must refuse even when history is otherwise valid/empty.
    await expect(certificate('economic-service', emptyAsset)).rejects.toThrow();
    await expect(
      asActor({ organizationId: org.b }, () => service.certificate({ assetId: emptyAsset })),
    ).rejects.toThrow();
  });
});
