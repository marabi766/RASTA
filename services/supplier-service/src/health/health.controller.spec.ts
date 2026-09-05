import { HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { KafkaEventPublisher } from '../outbox/kafka.publisher';

/**
 * The probes, and the one distinction that matters operationally.
 *
 * Readiness must fail on the dependencies without which every request fails,
 * and must **not** fail on the ones a degradation covers. Getting that backwards
 * turns a broker incident into a supplier-directory outage — and the outbox
 * exists precisely so a broker outage costs nothing but freshness.
 */

function controller(database: boolean, kafka: boolean): HealthController {
  return new HealthController(
    { isHealthy: async () => database } as unknown as PrismaService,
    { isHealthy: async () => kafka } as unknown as KafkaEventPublisher,
  );
}

function response() {
  const captured = { status: 0 };
  return {
    captured,
    res: { status: (code: number) => ((captured.status = code), undefined) } as unknown as never,
  };
}

describe('liveness', () => {
  it('depends on nothing external', async () => {
    // If this failed on a dependency, one flaky database would restart every
    // replica of every service behind it.
    const body = controller(false, false).live();

    expect(body.status).toBe('ok');
    expect(body.service).toBe('supplier-service');
  });
});

describe('readiness', () => {
  it('is ready with a healthy database and broker', async () => {
    const { captured, res } = response();
    const body = await controller(true, true).ready(res);

    expect(captured.status).toBe(HttpStatus.OK);
    expect(body.status).toBe('ok');
    expect(body.degraded).toEqual([]);
  });

  it('is unavailable without a database', async () => {
    const { captured, res } = response();
    const body = await controller(false, true).ready(res);

    expect(captured.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.status).toBe('unavailable');
  });

  it('stays ready with an unreachable broker, and says it is degraded', async () => {
    // A broker outage stops nothing: the decision is still made, the row is
    // still written and the event is still durably queued. Failing readiness
    // would take a working service out of rotation (ADR-021).
    const { captured, res } = response();
    const body = await controller(true, false).ready(res);

    expect(captured.status).toBe(HttpStatus.OK);
    expect(body.degraded).toEqual(['kafka']);
    expect(body.checks.kafka).toBe(false);
  });

  it('does not report a broker degradation while it is already unavailable', async () => {
    // One failure, one signal. Listing both would make an operator chase the
    // broker while the database is the thing that is down.
    const { res } = response();
    const body = await controller(false, false).ready(res);

    expect(body.degraded).toEqual([]);
  });

  it('states that nothing is decided without a human, whatever else it reports', async () => {
    // An operator reading this during an incident should not have to work out
    // from elsewhere whether a degraded broker has loosened anything.
    const { res } = response();

    expect((await controller(true, false).ready(res)).decisionsRequireAHuman).toBe(true);
  });
});

describe('startup', () => {
  it('waits on the database and nothing else', async () => {
    const { captured, res } = response();

    expect((await controller(true, false).startup(res)).status).toBe('ok');
    expect(captured.status).toBe(HttpStatus.OK);

    const second = response();
    expect((await controller(false, true).startup(second.res)).status).toBe('starting');
    expect(second.captured.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

describe('version', () => {
  it('carries build identification and no business data', async () => {
    const body = controller(true, true).version();

    expect(body.service).toBe('supplier-service');
    expect(Object.keys(body).sort()).toEqual(
      ['builtAt', 'commit', 'node', 'service', 'version'].sort(),
    );
  });
});
