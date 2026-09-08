import { corsOrigins, DEFAULT_PORT, loadNotificationEnv, SERVICE_NAME } from './env';

describe('notification-service configuration', () => {
  it('falls back to the documented port when neither PORT nor PORT_NOTIFICATION is set', () => {
    // 3113 is what `.env.example` (`PORT_NOTIFICATION`), `NOTIFICATION_SERVICE_URL` and the
    // service map in CLAUDE.md all name. Pinned so a future edit cannot quietly
    // move the service to a port the gateway does not route to.
    const env = loadNotificationEnv({});

    expect(env.PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3113');
    expect(env.SERVICE_NAME).toBe(SERVICE_NAME);
  });

  it('prefers PORT over PORT_NOTIFICATION, because a container sets only PORT', () => {
    expect(loadNotificationEnv({ PORT: '4000', PORT_NOTIFICATION: '3113' }).PORT).toBe(4000);
    expect(loadNotificationEnv({ PORT_NOTIFICATION: '3113' }).PORT).toBe(3113);
  });

  it('does not require a database url, because it opens no database', () => {
    // The negative control for the scaffold's honesty. `rasta_notification` exists and
    // `DATABASE_URL_NOTIFICATION` is registered in CI, but this process never connects
    // — so demanding the variable would refuse to start over a dependency it
    // does not use. NTF-001 merges `databaseEnvSchema` and this test changes
    // with it.
    expect(() => loadNotificationEnv({})).not.toThrow();
    expect(loadNotificationEnv({})).not.toHaveProperty('DATABASE_URL');
  });

  it('rejects an out-of-range port instead of coercing it', () => {
    expect(() => loadNotificationEnv({ PORT: '70000' })).toThrow();
    expect(() => loadNotificationEnv({ PORT: 'not-a-port' })).toThrow();
  });

  it('reads cors origins as a trimmed, empty-free list', () => {
    expect(corsOrigins(loadNotificationEnv({ CORS_ORIGINS: '' }))).toEqual([]);
    expect(
      corsOrigins(loadNotificationEnv({ CORS_ORIGINS: 'https://a.test, https://b.test ,' })),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('falls back to the gateway origin list when the service has none of its own', () => {
    const env = loadNotificationEnv({ GATEWAY_CORS_ORIGINS: 'https://portal.test' });
    expect(corsOrigins(env)).toEqual(['https://portal.test']);
  });
});
