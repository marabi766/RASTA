import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Kafka, logLevel, type Admin, type Producer } from 'kafkajs';
import { ulid } from 'ulid';
import { kafkaClientConfig, kafkaConnectionFor, runUnscoped } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { brokers, cleanup, newPrisma, tenants, wire, asActor, unanswered } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';
import { recordCutoverIfMissing } from '../src/reward/evaluation-cutover';
import type { PrismaService } from '../src/prisma/prisma.service';

const withKafka = brokers() ? describe : describe.skip;
withKafka('economic committed effects survive a terminal consumer process restart', () => {
  const org = tenants();
  let prisma: PrismaService;
  let admin: Admin;
  const children = new Set<ChildProcess>();
  const producers: Producer[] = [];
  beforeAll(async () => {
    prisma = newPrisma();
    admin = new Kafka({
      ...kafkaClientConfig(kafkaConnectionFor('economic-service', 'restart-proof-offsets')),
      logLevel: logLevel.NOTHING,
    }).admin();
    await admin.connect();
    await runUnscoped('the restart proof records the operator cutover', () =>
      recordCutoverIfMissing(prisma.client, new Date('2021-01-01T00:00:00Z')),
    );
  });
  afterAll(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }),
    );
    await Promise.all(producers.map((producer) => producer.disconnect()));
    await admin?.disconnect();
    if (prisma) {
      await cleanup(prisma, [org.a, org.b, org.c]);
      await prisma.onModuleDestroy();
    }
  });

  function message(child: ChildProcess, type: string): Promise<{ calls?: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`child did not report ${type}`));
      }, 90_000);
      const listener = (value: { type?: string; calls?: number }): void => {
        if (value.type === type) {
          finish();
          resolve(value);
        }
      };
      const exited = (): void => {
        finish();
        reject(new Error(`child exited before ${type}`));
      };
      const finish = (): void => {
        clearTimeout(timer);
        child.off('message', listener);
        child.off('exit', exited);
      };
      child.on('message', listener);
      child.once('exit', exited);
    });
  }
  function start(input: object) {
    // The parent needs owner credentials for cleanup and producer credentials for source
    // fixtures. The restarted worker receives only its runtime DB and Kafka identity.
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.includes('MIGRATOR') &&
          !key.startsWith('POSTGRES_') &&
          !['KAFKA_SECRETS_DIR', 'KAFKA_ADMIN_SECRETS_DIR'].includes(key) &&
          (!key.startsWith('KAFKA_SASL_PASSWORD_') || key === 'KAFKA_SASL_PASSWORD_ECONOMIC') &&
          (!key.startsWith('DATABASE_URL_') || key === 'DATABASE_URL_ECONOMIC'),
      ),
    );
    const child = fork(join(__dirname, 'consumer-restart.fixture.ts'), [], {
      env: childEnv,
      execArgv: ['-r', '@swc-node/register'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    const ready = message(child, 'ready');
    const effect = message(child, 'effect');
    // A handler/startup failure must surface without echoing any source data or driver error.
    void effect.catch(() => undefined);
    child.send(input);
    return { child, ready, effect, exited: once(child, 'exit') };
  }

  it.each(['settlement-authority', 'statement-settlement', 'reward-trigger'] as const)(
    '%s: one durable effect after a real process exit and redelivery; the first effect required owner confirmation',
    async (kind) => {
      const id = ulid();
      const reference = `${kind === 'settlement-authority' ? 'MRQ' : kind === 'statement-settlement' ? 'STM' : 'USG'}_${id}`;
      const sources = new FakeSourceFacts();
      const now = new Date().toISOString();
      const base = { organizationId: org.a, assetId: `AST_${id}` };
      const fact =
        kind === 'settlement-authority'
          ? sources.approved({
              ...base,
              requestId: `MRQ_${id}`,
              workshopOrganizationId: org.b,
              totalCostMinor: '450000',
              currency: 'IRR',
              approvedBy: `USR_${id}`,
              approvedAt: now,
            })
          : kind === 'statement-settlement'
            ? {
                statementId: reference,
                contractId: `CTR_${id}`,
                status: 'APPROVED' as const,
                netMinor: '7350000',
                currency: 'IRR',
                payerOrganizationId: org.a,
                beneficiaryOrganizationId: org.b,
                approvedAt: now,
              }
            : sources.recorded(
                { ...base, usageRecordId: `USG_${id}`, hours: '7.5' },
                { recordedBy: `USR_${id}` },
              );
      if (kind === 'reward-trigger') {
        const wiring = wire(prisma);
        await asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
          wiring.rewards.createRule(
            {
              organizationId: org.a,
              triggerEvent: 'USAGE_RECORDED',
              rewardType: 'POINTS',
              points: 5,
              creditPerPointMinor: '2500',
              validFrom: '2021-01-01T00:00:00.000Z',
              status: 'ACTIVE',
            },
            unanswered(),
          ),
        );
      }
      const owner =
        kind === 'settlement-authority'
          ? 'maintenance-service'
          : kind === 'statement-settlement'
            ? 'contract-service'
            : 'fleet-service';
      const topic = `rasta.${owner.replace('-service', '')}.v1`;
      const payload =
        kind === 'settlement-authority'
          ? {
              ...base,
              requestId: reference,
              workshopOrganizationId: org.b,
              totalCostMinor: '450000',
              currency: 'IRR',
              approvedBy: `USR_${id}`,
              approvedAt: now,
            }
          : kind === 'statement-settlement'
            ? {
                statementId: reference,
                contractId: `CTR_${id}`,
                statementNumber: 1,
                organizationId: org.a,
                contractorOrganizationId: org.b,
                approvedAt: now,
              }
            : { ...base, usageRecordId: reference, hours: '7.5' };
      const event: EventEnvelope = {
        eventId: id,
        eventName:
          kind === 'settlement-authority'
            ? 'MAINTENANCE_APPROVED'
            : kind === 'statement-settlement'
              ? 'STATEMENT_APPROVED'
              : 'USAGE_RECORDED',
        eventVersion: 1,
        occurredAt: now,
        producer: owner,
        producerVersion: '0.1.0',
        aggregateType:
          kind === 'settlement-authority'
            ? 'MaintenanceRequest'
            : kind === 'statement-settlement'
              ? 'Contract'
              : 'UsageRecord',
        aggregateId: kind === 'statement-settlement' ? `CTR_${id}` : reference,
        tenantId: org.a,
        correlationId: `restart-${id}`,
        payload,
      };
      const group = `economic-service.restart-proof-${id}`;
      const input = { kind, topic, group, reference, fact, event };
      const first = start({ ...input, crash: true });
      await first.ready;
      const before = await admin.fetchOffsets({ groupId: group, topics: [topic] });
      const producer = new Kafka({
        ...kafkaClientConfig(kafkaConnectionFor(owner, `restart-publish-${id}`)),
        logLevel: logLevel.NOTHING,
      }).producer();
      producers.push(producer);
      await producer.connect();
      await producer.send({
        topic,
        messages: [{ key: event.aggregateId, value: JSON.stringify(event), partition: 0 }],
      });
      expect((await first.effect).calls).toBeGreaterThan(0);
      expect((await first.exited)[0]).toBe(1);
      expect(await admin.fetchOffsets({ groupId: group, topics: [topic] })).toEqual(before);
      const count = () =>
        runUnscoped('the recovery proof counts only its unique source effect', () =>
          kind === 'reward-trigger'
            ? prisma.client.reward.count({ where: { sourceReference: reference } })
            : prisma.client.transaction.count({ where: { sourceReference: reference } }),
        );
      expect(await count()).toBe(1);
      const second = start({ ...input, crash: false });
      await second.ready;
      await second.effect;
      expect(await count()).toBe(1);
      if (kind === 'reward-trigger') {
        const rewards = await runUnscoped(
          'the recovery proof reads its monetised reward and journal',
          () => prisma.client.reward.findMany({ where: { sourceReference: reference } }),
        );
        expect(rewards).toHaveLength(1);
        expect(rewards[0]!.creditAmountMinor).toBe(12_500n);
        expect(rewards[0]!.journalId).not.toBeNull();
        const entries = await runUnscoped(
          'the recovery proof checks the reward journal balance',
          () =>
            prisma.client.ledgerEntry.findMany({ where: { journalId: rewards[0]!.journalId! } }),
        );
        expect(entries).toHaveLength(2);
        expect(
          entries.reduce(
            (sum, entry) =>
              sum + (entry.direction === 'DEBIT' ? entry.amountMinor : -entry.amountMinor),
            0n,
          ),
        ).toBe(0n);
      }
      // After restart, a new claim still has to pass tenant and source-owner checks.
      // The owner has no such fact: production must dead-letter it before any effect.
      const unknownReference = `UNKNOWN_${id}`;
      const unknownPayload = {
        ...payload,
        ...(kind === 'settlement-authority'
          ? { requestId: unknownReference }
          : kind === 'statement-settlement'
            ? { statementId: unknownReference }
            : { usageRecordId: unknownReference }),
      };
      const probe = { ...event, eventId: ulid(), payload: unknownPayload };
      const refused = message(second.child, 'probe');
      await producer.send({
        topic,
        messages: [{ key: event.aggregateId, value: JSON.stringify(probe), partition: 0 }],
      });
      const refusedResult = await refused;
      expect(refusedResult.calls).toBeGreaterThan(0);
      const forged = message(second.child, 'probe');
      await producer.send({
        topic,
        messages: [
          {
            key: event.aggregateId,
            value: JSON.stringify({ ...probe, eventId: ulid(), tenantId: org.c }),
            partition: 0,
          },
        ],
      });
      expect((await forged).calls).toBe(refusedResult.calls);
      expect(
        await runUnscoped(
          'the recovery proof refuses unknown-owner and forged-tenant new effects',
          () =>
            kind === 'reward-trigger'
              ? prisma.client.reward.count({ where: { sourceReference: unknownReference } })
              : prisma.client.transaction.count({ where: { sourceReference: unknownReference } }),
        ),
      ).toBe(0);
      expect(await count()).toBe(1);
      second.child.kill('SIGTERM');
      expect((await second.exited)[0]).toBe(0);
      const after = await admin.fetchOffsets({ groupId: group, topics: [topic] });
      expect(
        BigInt(after[0]!.partitions.find((partition) => partition.partition === 0)!.offset),
      ).toBeGreaterThan(
        BigInt(before[0]!.partitions.find((partition) => partition.partition === 0)!.offset),
      );
    },
    180_000,
  );
});
