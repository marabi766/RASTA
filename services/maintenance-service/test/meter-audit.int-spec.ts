import { createHash } from 'node:crypto';
import { canonicalMeterCertificate, type EventEnvelope } from '@rasta/contracts';
import { MeterReconcile } from '../src/maintenance/meter-reconcile';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { cleanup, id, newPrisma, seedAsset, seedMeter, tenants } from './helpers';

describe('meter transition audit boundary', () => {
  const prisma = newPrisma();
  const org = tenants();
  const actor = 'USR_METER_OPERATOR';
  const repository = new MaintenanceRepository(prisma);
  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });
  async function fixture() {
    const assetId = id('AST');
    await seedAsset(prisma, assetId, org.a);
    await seedMeter(prisma, assetId, org.a, '100');
    const body = { version: 1 as const, assetId, snapshot: '1:2:', facts: [] };
    const certificate = {
      ...body,
      digest: createHash('sha256').update(canonicalMeterCertificate(body)).digest('hex'),
    };
    const source = { certificate: async () => certificate, page: jest.fn() };
    // Fourth argument is the configured operator, shared by CLI and direct apply.
    const command = new MeterReconcile(prisma, source, undefined, actor);
    const rows = () => prisma.client.outboxMessage.findMany({ where: { aggregateId: assetId } });
    return { assetId, source, command, rows, certificate };
  }
  it('no due schedules: one atomic downward transition, concurrent/timestamp replay adds none', async () => {
    const f = await fixture();
    const apply = () => f.command.reportAsset(org.a, f.assetId, new Date(), true);
    expect((await Promise.all([apply(), apply()])).map((r) => r.outcome)).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    await apply();
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    const event = rows[0].payload as unknown as EventEnvelope;
    expect(event).toMatchObject({
      eventName: 'MAINTENANCE_METER_RECONCILED',
      eventVersion: 1,
      tenantId: org.a,
      aggregateId: f.assetId,
      actor: { type: 'USER', id: actor },
      payload: {
        assetId: f.assetId,
        organizationId: org.a,
        operatorId: actor,
        before: { mode: 'LEGACY', hours: '100.00', kilometres: '0.00' },
        after: { mode: 'LEDGER', hours: '0.00', kilometres: '0.00' },
        certificateDigest: f.certificate.digest,
        snapshot: '1:2:',
        runId: expect.any(String),
      },
    });
    expect(event.correlationId).toBe((event.payload as { runId: string }).runId);
  });
  it('records metadata-only reconciliation after LEDGER cutover', async () => {
    const f = await fixture();
    await prisma.client.assetUsageMeter.update({
      where: { assetId: f.assetId },
      data: { meterSource: 'LEDGER', hourMeter: '0', odometer: '0', recordCount: 1 },
    });
    expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
      outcome: 'APPLIED',
    });
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as unknown as EventEnvelope).payload).toMatchObject({
      before: { mode: 'LEDGER', recordCount: 1 },
      after: { mode: 'LEDGER', recordCount: 0 },
    });
  });
  it('refuses an unauditable snapshot before mutation', async () => {
    const f = await fixture();
    f.certificate.snapshot = '1:2:' + Array(1100).fill('3').join(',');
    f.certificate.digest = createHash('sha256')
      .update(canonicalMeterCertificate(f.certificate))
      .digest('hex');
    expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
      outcome: 'REFUSED',
      refusal: 'SNAPSHOT_NOT_AUDITABLE',
    });
    expect(await f.rows()).toHaveLength(0);
    expect((await repository.findMeter(f.assetId))!.meterSource).toBe('LEGACY');
  });
  it('inventory apply uses the same audit boundary', async () => {
    const f = await fixture();
    const report = await f.command.report(org.a, new Date(), true);
    expect(report.assets.find((r) => r.assetId === f.assetId)).toMatchObject({
      outcome: 'APPLIED',
    });
    expect(await f.rows()).toHaveLength(1);
  });
  it('invalid post-lock audit state is a proven refusal, with no staged transition', async () => {
    const f = await fixture();
    await prisma.client.assetUsageMeter.update({
      where: { assetId: f.assetId },
      data: { lastUsageRecordId: 'x'.repeat(65) },
    });
    expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
      outcome: 'REFUSED',
      refusal: 'CUTOVER_AUDIT_INVALID',
    });
    expect(await f.rows()).toHaveLength(0);
    expect((await repository.findMeter(f.assetId))!.meterSource).toBe('LEGACY');
    expect((await repository.findMeter(f.assetId))!.hourMeter.toString()).toBe('100');
  });
  it('lost commit response replays without another transition', async () => {
    const f = await fixture();
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw new Error('lost commit response');
    });
    try {
      expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
        outcome: 'UNCONFIRMED',
      });
    } finally {
      lost.mockRestore();
    }
    expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
      outcome: 'APPLIED',
    });
    expect(await f.rows()).toHaveLength(1);
  });
  it('rollback after enqueue retains neither meter update nor outbox row', async () => {
    const f = await fixture();
    const transaction = prisma.transaction.bind(prisma);
    let inTransaction = 0;
    const rollback = jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn, options) =>
      transaction(async (tx) => {
        await fn(tx);
        inTransaction = await tx.outboxMessage.count({ where: { aggregateId: f.assetId } });
        throw new Error('forced rollback');
      }, options),
    );
    try {
      expect(await f.command.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
        outcome: 'UNCONFIRMED',
      });
    } finally {
      rollback.mockRestore();
    }
    expect(inTransaction).toBe(1);
    expect(await f.rows()).toHaveLength(0);
    expect((await repository.findMeter(f.assetId))!.meterSource).toBe('LEGACY');
    expect((await repository.findMeter(f.assetId))!.hourMeter.toString()).toBe('100');
  });
  it('missing operator refuses direct and inventory apply; another tenant cannot create audit evidence', async () => {
    const f = await fixture();
    const missing = new MeterReconcile(prisma, f.source);
    expect(await missing.reportAsset(org.a, f.assetId, new Date(), true)).toMatchObject({
      refusal: 'OPERATOR_ID_REQUIRED',
    });
    await expect(missing.report(org.a, new Date(), true)).rejects.toThrow('OPERATOR_ID_REQUIRED');
    expect(await f.command.reportAsset(org.b, f.assetId, new Date(), true)).toMatchObject({
      refusal: 'ASSET_NOT_IN_TENANT',
    });
    expect(await f.rows()).toHaveLength(0);
  });
});
