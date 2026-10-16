import 'reflect-metadata';
import {
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  type EventConsumer,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { AppModule, ENV } from './app.module';
import { MembershipExpiryScanner } from './identity/membership-expiry.scanner';
import { KeycloakProjectionConsumer } from './keycloak/keycloak-projection.consumer';
import { SECURITY_EVENT_RELAY } from './security-events/security-event.relay';

/**
 * D-052 in identity-service: both relays, the purge, the membership expiry
 * scanner and the Keycloak projection consumer stop together, by one deadline
 * inside SHUTDOWN_TIMEOUT_MS. Before, the relays stopped in
 * `onApplicationShutdown`, after the consumer's own unbounded
 * `onModuleDestroy`, and the scanner only cleared its timer. This reads the
 * wiring without a database or a broker: AppModule's own factory, called with
 * stand-ins for what it injects. The whole close is
 * `test/outbox-shutdown.int-spec.ts`.
 */
interface FactoryProvider {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function outboxShutdownProvider(): FactoryProvider {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  const found = providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === OutboxShutdown,
  );
  if (!found) throw new Error('AppModule provides no OutboxShutdown');
  return found;
}

describe('AppModule shutdown wiring (D-052)', () => {
  it('stops both relays, the purge, the scanner and the projection consumer by one deadline', async () => {
    const provider = outboxShutdownProvider();
    const inject = provider.inject ?? [];
    const stops = new Map<unknown, (OutboxStopOptions | undefined)[]>();
    const args = inject.map((token) =>
      token === ENV
        ? { SHUTDOWN_TIMEOUT_MS: 25_000 }
        : {
            stop: async (options?: OutboxStopOptions) => {
              stops.set(token, [...(stops.get(token) ?? []), options]);
            },
          },
    );
    const shutdown = provider.useFactory(...args) as OutboxShutdown;

    const before = Date.now();
    await shutdown.stop();
    await shutdown.stop();

    expect(inject).toEqual(
      expect.arrayContaining([
        OutboxRelay,
        OutboxPurgeScheduler,
        SECURITY_EVENT_RELAY,
        MembershipExpiryScanner,
        KeycloakProjectionConsumer,
        ENV,
      ]),
    );
    // Every one stopped once — a later stop joins the first.
    expect(stops.size).toBe(inject.length - 1);
    for (const calls of stops.values()) expect(calls).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    // SHUTDOWN_TIMEOUT_MS less the 2 s reserve.
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('the projection consumer passes the deadline to its EventConsumer; a later stop joins it', async () => {
    const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const projection = new KeycloakProjectionConsumer(
      () => ({ start: async () => undefined, stop: consumerStop }) as unknown as EventConsumer,
      {} as never,
    );
    await projection.onModuleInit();

    await projection.stop({ deadlineAt: 1234 });
    await projection.onApplicationShutdown();

    expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
  });

  it('Keycloak sync off, the projection consumer has nothing to stop', async () => {
    const projection = new KeycloakProjectionConsumer(null, {} as never);
    await projection.onModuleInit();
    await expect(projection.stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
  });

  it('AppModule stops nothing on its own in onApplicationShutdown: it joins OutboxShutdown', async () => {
    const relayStop = jest.fn(async () => undefined);
    const outboxStop = jest.fn(async () => undefined);
    const module = Object.create(AppModule.prototype) as AppModule;
    Object.assign(module, {
      relay: { stop: relayStop },
      securityRelay: { stop: relayStop },
      outboxShutdown: { stop: outboxStop },
    });

    await module.onApplicationShutdown();

    expect(outboxStop).toHaveBeenCalledTimes(1);
    expect(relayStop).not.toHaveBeenCalled();
  });
});
