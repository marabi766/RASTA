import { UnprocessableEventError } from '@rasta/nest-common';
import { MaintenanceFactsConsumer } from '../src/maintenance/maintenance-facts.consumer';
import { MAINTENANCE_FACTS_CONSUMER } from '../src/maintenance/maintenance-fact';
import {
  cleanup,
  clearCoverage,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  ownerClient,
  plantCoverage,
  wire,
  type Wiring,
} from './helpers';

/**
 * The projection's coverage start (ADR-071 § 6, Q-154, D-082) against a real PostgreSQL: written
 * once when the consumer has started, never by a delivery, never moved, stamped by the database.
 */

let w: Wiring;
const owner = ownerClient();
const organizations: string[] = [];
const events: string[] = [];
const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** A stand-in for the Kafka consumer: `start()` is what the projection waits on. */
function fakeEventConsumer(start: () => Promise<void> = async () => undefined) {
  const calls: string[] = [];
  return {
    calls,
    consumer: {
      start: async () => {
        calls.push('start');
        await start();
      },
      stop: async () => void calls.push('stop'),
      stopAfterFailedStart: async () => void calls.push('stopAfterFailedStart'),
      isRunning: () => true,
    },
  };
}
const projection = (consumer: unknown) =>
  new MaintenanceFactsConsumer(() => consumer as never, w.prisma, w.facts, silent);
const rows = () =>
  owner.$queryRaw<{ consumer_name: string; covered_from: Date }[]>`
    SELECT consumer_name, covered_from FROM projection_coverage ORDER BY consumer_name`;

beforeAll(() => {
  w = wire();
});
beforeEach(() => clearCoverage());
afterAll(async () => {
  await cleanup(organizations, events);
  await clearCoverage();
  await Promise.all([w.close(), owner.$disconnect()]);
});

describe('recording the coverage start', () => {
  it('a started consumer records exactly one row, stamped by the database clock, after start() resolved', async () => {
    const [{ now: before }] = await owner.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const { consumer, calls } = fakeEventConsumer();
    await projection(consumer).start();
    const [{ now: after }] = await owner.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const held = await rows();
    expect(calls).toEqual(['start']);
    expect(held).toHaveLength(1);
    expect(held[0]?.consumer_name).toBe(MAINTENANCE_FACTS_CONSUMER);
    expect(held[0]?.covered_from.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(held[0]?.covered_from.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('restarts, second replicas and concurrent starts change nothing: the first instant stands', async () => {
    await projection(fakeEventConsumer().consumer).start();
    const [first] = await rows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await projection(fakeEventConsumer().consumer).start();
    await Promise.all(
      Array.from({ length: 5 }, () => projection(fakeEventConsumer().consumer).start()),
    );
    expect(await rows()).toEqual([first]);
  });

  it('a consumer that fails to start records nothing: "never ran" stays NO_DATA', async () => {
    const { consumer } = fakeEventConsumer(async () => {
      throw new Error('topic missing');
    });
    await expect(projection(consumer).start()).rejects.toThrow('topic missing');
    expect(await rows()).toEqual([]);
  });

  it('a coverage write that fails stops the consumer again and records nothing', async () => {
    const { consumer, calls } = fakeEventConsumer();
    const broken = new MaintenanceFactsConsumer(
      () => consumer as never,
      w.prisma,
      {
        recordCoverageStart: async () => {
          throw new Error('database unavailable');
        },
      } as never,
      silent,
    );
    await expect(broken.start()).rejects.toThrow('database unavailable');
    expect(calls).toEqual(['start', 'stopAfterFailedStart']);
    expect(await rows()).toEqual([]);
  });

  it('deliveries never create or advance coverage: applied, duplicate and rolled-back (contradicting) events', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const completion = newCompletion(organizationId);
    const first = maintenanceCompleted(completion);
    const contradicting = maintenanceCompleted({ ...completion, assetId: 'AST_DIFFERENT' });
    events.push(first.eventId, contradicting.eventId);

    await w.consumer.handle(first);
    await w.consumer.handle(first);
    await expect(w.consumer.handle(contradicting)).rejects.toBeInstanceOf(UnprocessableEventError);
    await w.consumer.handle(first);
    expect(await rows()).toEqual([]);

    // With coverage already recorded, the same deliveries leave its instant exactly as it was.
    await plantCoverage(new Date('2026-03-01T00:00:00.000Z'));
    const [planted] = await rows();
    await w.consumer.handle(first);
    await expect(w.consumer.handle(contradicting)).rejects.toBeInstanceOf(UnprocessableEventError);
    expect(await rows()).toEqual([planted]);
  });
});

describe('the coverage table guards', () => {
  it('stamps covered_from from the database, ignoring a supplied or backdated instant', async () => {
    await owner.$executeRaw`INSERT INTO projection_coverage (consumer_name, covered_from)
      VALUES (${MAINTENANCE_FACTS_CONSUMER}, ${new Date('2000-01-01T00:00:00Z')})`;
    const [held] = await rows();
    expect(held?.covered_from.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it.each([
    ['UPDATE', "UPDATE projection_coverage SET covered_from = '2000-01-01'"],
    ['DELETE', 'DELETE FROM projection_coverage'],
    ['TRUNCATE', 'TRUNCATE projection_coverage'],
  ])('refuses %s even to the table owner: the start is never moved or erased', async (_op, sql) => {
    await w.facts.recordCoverageStart(MAINTENANCE_FACTS_CONSUMER);
    const [held] = await rows();
    await expect(owner.$executeRawUnsafe(sql)).rejects.toThrow(
      /ck_projection_coverage_append_only/,
    );
    expect(await rows()).toEqual([held]);
  });

  it('refuses a blank consumer name', async () => {
    await expect(
      owner.$executeRawUnsafe("INSERT INTO projection_coverage (consumer_name) VALUES ('  ')"),
    ).rejects.toThrow(/ck_projection_coverage_name/);
  });
});
