import { corsOrigins, DEFAULT_PORT, loadAuditEnv, SERVICE_NAME } from './env';

describe('audit-service configuration', () => {
  it('falls back to the documented port when neither PORT nor PORT_AUDIT is set', () => {
    // 3115 is what `.env.example` (`PORT_AUDIT`), `AUDIT_SERVICE_URL` and the
    // service map in CLAUDE.md all name. Pinned so a future edit cannot quietly
    // move the service to a port the gateway does not route to.
    const env = loadAuditEnv({});

    expect(env.PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3115');
    expect(env.SERVICE_NAME).toBe(SERVICE_NAME);
  });

  it('prefers PORT over PORT_AUDIT, because a container sets only PORT', () => {
    expect(loadAuditEnv({ PORT: '4000', PORT_AUDIT: '3115' }).PORT).toBe(4000);
    expect(loadAuditEnv({ PORT_AUDIT: '3115' }).PORT).toBe(3115);
  });

  it('does not require a database url, because it opens no database', () => {
    // The negative control for the scaffold's honesty. `rasta_audit` exists and
    // `DATABASE_URL_AUDIT` is registered in CI, but this process never connects
    // — so demanding the variable would refuse to start over a dependency it
    // does not use. AUD-001 merges `databaseEnvSchema` and this test changes
    // with it.
    expect(() => loadAuditEnv({})).not.toThrow();
    expect(loadAuditEnv({})).not.toHaveProperty('DATABASE_URL');
  });

  it('rejects an out-of-range port instead of coercing it', () => {
    expect(() => loadAuditEnv({ PORT: '70000' })).toThrow();
    expect(() => loadAuditEnv({ PORT: 'not-a-port' })).toThrow();
  });

  it('reads cors origins as a trimmed, empty-free list', () => {
    expect(corsOrigins(loadAuditEnv({ CORS_ORIGINS: '' }))).toEqual([]);
    expect(corsOrigins(loadAuditEnv({ CORS_ORIGINS: 'https://a.test, https://b.test ,' }))).toEqual(
      ['https://a.test', 'https://b.test'],
    );
  });

  it('falls back to the gateway origin list when the service has none of its own', () => {
    const env = loadAuditEnv({ GATEWAY_CORS_ORIGINS: 'https://portal.test' });
    expect(corsOrigins(env)).toEqual(['https://portal.test']);
  });
});
