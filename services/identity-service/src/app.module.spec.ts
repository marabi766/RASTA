import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { RefusalAuditExceptionFilter } from './security-events/refusal-audit.filter';
import { SECURITY_EVENT_RELAY } from './security-events/security-event.relay';

/**
 * The composition root's refusal-audit wiring (AUD-004 Phase C1): the refusal
 * filter replaces the bare platform filter, and both relays share one
 * lifecycle — started on init, stopped on shutdown.
 */

type Provider = { provide?: unknown; useClass?: unknown };

const providers = (): Provider[] =>
  (Reflect.getMetadata('providers', AppModule) as Provider[]).filter(
    (provider) => typeof provider === 'object',
  );

function relay() {
  return { start: jest.fn(), stop: jest.fn(async () => undefined) };
}

function store() {
  return {
    pendingCount: jest.fn(async () => 0),
    activeLeaseCount: jest.fn(async () => 0),
    oldestPendingAgeSeconds: jest.fn(async () => 0),
    aggregationBacklog: jest.fn(async () => ({
      openWindows: 0,
      closedBacklog: 0,
      closedBacklogAgeSeconds: 0,
    })),
  };
}

describe('AppModule refusal-audit wiring', () => {
  it('registers the refusal filter as the only global exception filter', () => {
    const filters = providers().filter((provider) => provider.provide === APP_FILTER);
    expect(filters).toEqual([{ provide: APP_FILTER, useClass: RefusalAuditExceptionFilter }]);
    expect(filters.some((provider) => provider.useClass === AllExceptionsFilter)).toBe(false);
  });

  it('provides the refusal relay under its own token, apart from the domain relay', () => {
    expect(providers().some((provider) => provider.provide === SECURITY_EVENT_RELAY)).toBe(true);
  });

  it('starts both relays on init and stops both on shutdown', async () => {
    const domain = relay();
    const security = relay();
    const module = new AppModule(
      domain as never,
      store() as never,
      security as never,
      store() as never,
    );

    module.onModuleInit();
    expect(domain.start).toHaveBeenCalledTimes(1);
    expect(security.start).toHaveBeenCalledTimes(1);

    await module.onApplicationShutdown();
    expect(domain.stop).toHaveBeenCalledTimes(1);
    expect(security.stop).toHaveBeenCalledTimes(1);
  });
});
