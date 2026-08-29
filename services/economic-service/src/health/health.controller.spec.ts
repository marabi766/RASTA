import { HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { KafkaEventPublisher } from '../outbox/kafka.publisher';

/**
 * The readiness contract, and the distinction it is built around.
 *
 * **The database is the only hard dependency.** Every request in this service
 * either reads a balance or writes a journal, so without PostgreSQL the
 * service can do nothing and must be taken out of rotation. Kafka being down
 * delays event publication and loses no financial state — the outbox retains
 * what has not gone out (ADR-021) — so it is reported as *degraded*, and the
 * service keeps serving.
 *
 * Getting that backwards in either direction is an outage: reporting unready
 * on a broker hiccup takes a healthy service offline, and reporting ready
 * without a database sends every request to a failure. The distinction only
 * exists in the branches below, which is why they are asserted here rather
 * than inferred from a happy-path probe.
 */
describe('HealthController', () => {
  function build(database: boolean, kafka: boolean) {
    const prisma = { isHealthy: async () => database } as unknown as PrismaService;
    const publisher = { isHealthy: async () => kafka } as unknown as KafkaEventPublisher;
    const statuses: number[] = [];
    const response = { status: (code: number) => statuses.push(code) };

    return {
      controller: new HealthController(prisma, publisher),
      // The controller writes the status through `@Res({ passthrough: true })`,
      // so the code it chose is only observable here.
      // JUSTIFIED-ANY: only `status` is called on the response, and typing the
      // whole express Response would add nothing this assertion can use.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: response as any,
      statuses,
    };
  }

  it('is ready when both dependencies answer', async () => {
    const { controller, response, statuses } = build(true, true);

    const body = await controller.ready(response);

    expect(statuses).toEqual([HttpStatus.OK]);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: true, kafka: true });
    expect(body.degraded).toEqual([]);
  });

  it('stays ready with Kafka down, and names it as degraded', async () => {
    const { controller, response, statuses } = build(true, false);

    const body = await controller.ready(response);

    // Degraded, not unready. Taking the service out of rotation here would
    // convert a delayed event into a full outage, and the outbox means nothing
    // is lost in the meantime.
    expect(statuses).toEqual([HttpStatus.OK]);
    expect(body.status).toBe('ok');
    expect(body.degraded).toEqual(['kafka']);
  });

  it('is unready without a database, whatever the broker says', async () => {
    for (const kafka of [true, false]) {
      const { controller, response, statuses } = build(false, kafka);

      const body = await controller.ready(response);

      expect(statuses).toEqual([HttpStatus.SERVICE_UNAVAILABLE]);
      expect(body.status).toBe('unavailable');
      expect(body.checks.database).toBe(false);
      // Nothing is "degraded" when the service is unready — degraded is a
      // statement about a service that is still serving.
      expect(body.degraded).toEqual([]);
    }
  });

  it('reports starting until the database answers', async () => {
    const starting = build(false, true);
    expect((await starting.controller.startup(starting.response)).status).toBe('starting');
    expect(starting.statuses).toEqual([HttpStatus.SERVICE_UNAVAILABLE]);

    const started = build(true, true);
    expect((await started.controller.startup(started.response)).status).toBe('ok');
    expect(started.statuses).toEqual([HttpStatus.OK]);
  });

  it('answers liveness without asking any dependency', () => {
    // Liveness must not depend on anything: a probe that fails when the
    // database is briefly unreachable restarts a process that was fine, and
    // restarting it does not bring the database back.
    const prisma = {
      isHealthy: async () => {
        throw new Error('liveness must not reach the database');
      },
    } as unknown as PrismaService;
    const publisher = {} as unknown as KafkaEventPublisher;

    const body = new HealthController(prisma, publisher).live();

    expect(body.status).toBe('ok');
    expect(body.service).toBe('economic-service');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports the build it is running, and no business data', () => {
    const controller = new HealthController(
      {} as unknown as PrismaService,
      {} as unknown as KafkaEventPublisher,
    );

    const body = controller.version();

    expect(body.service).toBe('economic-service');
    expect(body.node).toBe(process.version);
    // Unknown rather than invented when the build did not stamp them: a
    // version string that is a guess is worse than one that says so.
    expect(typeof body.commit).toBe('string');
    expect(typeof body.builtAt).toBe('string');
  });
});
