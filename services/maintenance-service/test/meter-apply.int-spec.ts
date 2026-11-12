import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { EventEnvelope, MeterCertificate } from '@rasta/contracts';
import { MeterReconcile, type MeterUsageSource } from '../src/maintenance/meter-reconcile';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { DueAnnouncerService } from '../src/maintenance/due-announcer.service';
import { UsageConsumer } from '../src/consumers/usage.consumer';
import { asActor, cleanup, id, newPrisma, seedAsset, seedMeter, tenants, waitFor } from './helpers';

describe('actual LEDGER apply and fleet transactional outbox handoff', () => {
  const org = tenants();
  const prisma = newPrisma();
  const repository = new MaintenanceRepository(prisma);
  const announcer = new DueAnnouncerService(repository);
  const consumer = new UsageConsumer(null, repository, announcer);
  let fleet: ChildProcess;
  let fleetUrl: string;
  let receiver: Server;
  let deliveryUrl: string;
  const delivered: EventEnvelope[] = [];
  beforeAll(async () => {
    // Separate process, own DB, production source write + relay. No service imports.
    const cwd = resolve(__dirname, '../../fleet-service');
    fleet = fork(resolve(cwd, 'test/meter-handoff.fixture.ts'), [], {
      cwd,
      execArgv: ['-r', '@swc-node/register'],
      silent: true,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL_FLEET },
    });
    let diagnostic = '';
    fleet.stderr?.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    fleetUrl = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fleet startup timeout: ${diagnostic}`)),
        15000,
      );
      fleet.once('message', (message: { url: string }) => {
        clearTimeout(timer);
        resolveReady(message.url);
      });
      fleet.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(diagnostic));
      });
    });
    receiver = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as EventEnvelope;
        await asActor({ organizationId: envelope.tenantId! }, () => consumer.handle(envelope));
        delivered.push(envelope);
        res.end('ok');
      })().catch(() => {
        res.statusCode = 500;
        res.end('refused');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('missing receiver port');
    deliveryUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (fleet?.connected) {
      const exited = new Promise<void>((r) => fleet.once('exit', () => r()));
      fleet.disconnect();
      await exited;
    }
    if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });
  afterEach(async () => {
    await request('reset', { organizationId: org.a });
    await request('reset', { organizationId: org.b });
  });
  async function request<T>(path: string, body: object): Promise<T> {
    const response = await fetch(`${fleetUrl}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ organizationId: org.a, deliveryUrl, ...body }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as T;
  }
  async function machine(organizationId = org.a): Promise<string> {
    const assetId = id('AST');
    await seedAsset(prisma, assetId, organizationId);
    await seedMeter(prisma, assetId, organizationId, '100');
    await request('prepare', { organizationId, assetId });
    return assetId;
  }
  async function record(
    assetId: string,
    start = 10,
    quantities: object = { hourMeter: '100', odometer: '200' },
  ): Promise<void> {
    await request('record', {
      assetId,
      record: {
        assetId,
        hours: '0',
        kilometres: '0',
        periodStart: `2026-11-01T${String(start).padStart(2, '0')}:00:00Z`,
        periodEnd: `2026-11-01T${String(start + 1).padStart(2, '0')}:00:00Z`,
        source: 'MANUAL',
        ...quantities,
      },
    });
  }
  const certificate = (assetId: string) => request<MeterCertificate>('certificate', { assetId });
  async function relay(): Promise<void> {
    expect((await request<{ pending: number }>('relay', {})).pending).toBe(0);
  }
  function command(c?: MeterCertificate) {
    const source: MeterUsageSource = {
      certificate: async (_org, assetId) => c ?? certificate(assetId),
      page: async () => {
        throw new Error('must not fall back to pages');
      },
    };
    return new MeterReconcile(prisma, source, undefined, 'USR_ITEST');
  }
  const apply = (assetId: string, c?: MeterCertificate) =>
    command(c).reportAsset(org.a, assetId, new Date(), true);
  async function expectMeter(assetId: string, value: string, source = 'LEDGER'): Promise<void> {
    const meter = await repository.findMeter(assetId);
    expect(meter!.meterSource).toBe(source);
    expect(meter!.hourMeter.toString()).toBe(value);
  }

  it('covered spill migrates 102 to 100, commits before announcement, and repeated apply is idempotent', async () => {
    const assetId = await machine();
    await record(assetId);
    await record(assetId, 9, { hours: '2' });
    await relay();
    await expectMeter(assetId, '102', 'LEGACY');
    const scheduleId = id('MSC');
    await asActor({ organizationId: org.a }, () =>
      prisma.client.maintenanceSchedule.create({
        data: {
          id: scheduleId,
          assetId,
          organizationId: org.a,
          title: 'apply test',
          intervalHours: '50',
          lastServicedHourMeter: '0',
          leadHours: '0',
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );
    const spy = jest.spyOn(announcer, 'announceForAsset').mockImplementation(async (asset, now) => {
      await expectMeter(asset, '100'); // Independent connection must see committed LEDGER.
      return new DueAnnouncerService(repository).announceForAsset(asset, now);
    });
    try {
      const run = () =>
        new MeterReconcile(
          prisma,
          {
            certificate: async () => certificate(assetId),
            page: async () => {
              throw new Error('no pages');
            },
          },
          announcer,
          'USR_ITEST',
        ).reportAsset(org.a, assetId, new Date(), true);
      expect(await run()).toMatchObject({
        outcome: 'APPLIED',
        sourceComplete: true,
        L: { hours: '100.00', kilometres: '200.00' },
      });
      expect((await repository.findMeter(assetId))!.odometer.toString()).toBe('200');
      expect(await run()).toMatchObject({ outcome: 'APPLIED', M: { hours: '100.00' } });
      expect(
        await prisma.client.outboxMessage.count({
          where: { organizationId: org.a, aggregateId: scheduleId },
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'post-snapshot tail/backdated commits via relay exactly once; live first=%s',
    async (liveFirst) => {
      const assetId = await machine();
      await record(assetId);
      await relay();
      const c = await certificate(assetId);
      await record(assetId, 11, { hours: '2' });
      await record(assetId, 9, { hours: '2' });
      if (liveFirst) {
        await relay();
        expect(await apply(assetId, c)).toMatchObject({
          outcome: 'REFUSED',
          sourceComplete: false,
          refusal: 'SOURCE_LEDGER_MISMATCH',
        });
        await expectMeter(assetId, '104', 'LEGACY');
        expect(await apply(assetId)).toMatchObject({ outcome: 'APPLIED', L: { hours: '102.00' } });
      } else {
        expect(await apply(assetId, c)).toMatchObject({
          outcome: 'APPLIED',
          L: { hours: '100.00' },
        });
        await relay();
      }
      for (const envelope of delivered.filter(
        (e) => (e.payload as { assetId: string }).assetId === assetId,
      ))
        expect(await asActor({ organizationId: org.a }, () => consumer.handle(envelope))).toBe(
          'SKIPPED',
        );
      await expectMeter(assetId, '102');
      expect((await repository.findMeter(assetId))!.recordCount).toBe(3);
    },
  );

  it('dry-run → event → apply uses the fresh under-lock value, and reports are tenant-partitioned', async () => {
    const assetId = await machine();
    const other = await machine(org.b);
    await record(assetId);
    await relay();
    expect(await command().reportAsset(org.a, assetId)).toMatchObject({
      L: { hours: '100.00' },
      sourceComplete: false,
    });
    await record(assetId, 11, { hours: '2' });
    await relay();
    expect(await apply(assetId)).toMatchObject({ L: { hours: '102.00' } });
    expect(await apply(other)).toMatchObject({
      refusal: 'ASSET_NOT_IN_TENANT',
      sourceComplete: false,
    });
    const report = await command().report(org.a);
    expect(report.assets.map((a) => a.assetId)).not.toContain(other);
    expect(report.sourceComplete).toBe(false); // No global inventory claim.
  });

  async function holdMeter(assetId: string) {
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const locked = new Promise<void>((r) => {
      ready = r;
    });
    const holding = prisma.transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT asset_id FROM asset_usage_meter WHERE asset_id = ${assetId} FOR UPDATE`;
        ready();
        await gate;
      },
      { timeoutMs: 20000 },
    );
    await locked;
    return async () => {
      release();
      await holding;
    };
  }
  async function waiting(fragment: string, count = 1): Promise<void> {
    await waitFor(
      'real PostgreSQL lock queue',
      async () => {
        const [row] = await prisma.client.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
        return row.n >= count;
      },
      5000,
      10,
    );
  }
  it.each([false, true])(
    'r3 after-insert/before-lock, live first=%s: 102 never 104',
    async (liveFirst) => {
      const assetId = await machine();
      await record(assetId);
      await relay();
      const old = await certificate(assetId);
      await record(assetId, 11, { hours: '2' });
      const current = await certificate(assetId);
      const unlock = await holdMeter(assetId);
      const pending: Promise<unknown>[] = [];
      let cutover!: ReturnType<typeof apply>;
      try {
        if (liveFirst) {
          pending.push(relay());
          await waiting('SELECT meter_source'); // Live fact inserted, meter lock not acquired.
          cutover = apply(assetId, current);
          pending.push(cutover);
          await waiting('INSERT INTO asset_usage_entry'); // Apply waits before meter lock.
        } else {
          cutover = apply(assetId, old);
          pending.push(cutover);
          await waiting('SELECT meter_source');
          pending.push(relay());
          await waiting('SELECT meter_source', 2); // Both inserts finished; apply wins the queue.
        }
      } finally {
        await unlock();
        await Promise.all(pending);
      }
      expect(await cutover).toMatchObject({ outcome: 'APPLIED', sourceComplete: true });
      await expectMeter(assetId, '102');
    },
  );
  it('refuses unavailable, conflicting or incomplete certificates without changing LEGACY', async () => {
    const assetId = await machine();
    await record(assetId);
    const c = await certificate(assetId);
    await asActor({ organizationId: org.a }, () =>
      prisma.client.assetUsageEntry.create({
        data: {
          usageRecordId: c.facts[0].id,
          assetId,
          organizationId: org.a,
          hours: '0',
          kilometres: '0',
          hourMeter: '100',
        },
      }),
    );
    expect(await apply(assetId, c)).toMatchObject({
      sourceComplete: false,
      refusal: 'ENTRY_CONFLICT',
    });
    const source = {
      certificate: async () => {
        throw new Error('unavailable');
      },
      page: jest.fn(),
    };
    expect(
      await new MeterReconcile(prisma, source, undefined, 'USR_ITEST').reportAsset(
        org.a,
        assetId,
        new Date(),
        true,
      ),
    ).toMatchObject({ refusal: 'SOURCE_READ_FAILED', sourceComplete: false });
    expect(source.page).not.toHaveBeenCalled();
    await expectMeter(assetId, '100', 'LEGACY');
  });
  it('distinguishes a lost commit response from refusal and preserves a confirmed commit when announcement fails', async () => {
    const assetId = await machine();
    await record(assetId);
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw new Error('response lost after commit');
    });
    try {
      expect(await apply(assetId)).toMatchObject({
        outcome: 'UNCONFIRMED',
        sourceComplete: false,
        refusal: 'APPLY_UNCONFIRMED',
      });
    } finally {
      lost.mockRestore();
    }
    await expectMeter(assetId, '100');
    const failed = { announceForAsset: jest.fn().mockRejectedValue(new Error('unavailable')) };
    const run = new MeterReconcile(
      prisma,
      { certificate: async () => certificate(assetId), page: jest.fn() },
      failed,
      'USR_ITEST',
    );
    expect(await run.reportAsset(org.a, assetId, new Date(), true)).toMatchObject({
      outcome: 'APPLIED',
      sourceComplete: true,
      refusal: 'ANNOUNCEMENT_UNCONFIRMED',
    });
    await expectMeter(assetId, '100');
    await relay();
  });
});
