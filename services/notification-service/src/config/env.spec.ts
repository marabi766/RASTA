import {
  brokersOf,
  corsOrigins,
  DEFAULT_PORT,
  DISPATCHER_CONSUMER_GROUP,
  IDENTITY_SERVICE,
  loadNotificationEnv,
  NOTIFICATION_DLQ_TOPIC,
  SERVICE_NAME,
} from './env';

/** The minimum a running service needs; every test builds on it. */
const REQUIRED = {
  DATABASE_URL_NOTIFICATION: 'postgresql://rasta_notification:pw@localhost:5433/rasta_notification',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'unit_test_secret_that_is_long_enough_32',
  IDENTITY_SERVICE_URL: 'http://localhost:3101',
};

describe('notification-service configuration', () => {
  it('falls back to the documented port when neither PORT nor PORT_NOTIFICATION is set', () => {
    // 3113 is what `.env.example` (`PORT_NOTIFICATION`), `NOTIFICATION_SERVICE_URL`
    // and the service map in CLAUDE.md all name.
    const env = loadNotificationEnv(REQUIRED);
    expect(env.PORT).toBe(Number(DEFAULT_PORT));
    expect(DEFAULT_PORT).toBe('3113');
    expect(env.SERVICE_NAME).toBe(SERVICE_NAME);
  });

  it('prefers PORT over PORT_NOTIFICATION, because a container sets only PORT', () => {
    expect(loadNotificationEnv({ ...REQUIRED, PORT: '4000', PORT_NOTIFICATION: '3113' }).PORT).toBe(
      4000,
    );
    expect(loadNotificationEnv({ ...REQUIRED, PORT_NOTIFICATION: '3113' }).PORT).toBe(3113);
  });

  it('requires a database url now that it owns a schema, resolving it from DATABASE_URL_NOTIFICATION', () => {
    // The scaffold's negative control, inverted by NTF-001 exactly as its own
    // comment said it would be.
    const { DATABASE_URL_NOTIFICATION: _omitted, ...withoutDatabase } = REQUIRED;
    expect(() => loadNotificationEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(loadNotificationEnv(REQUIRED).DATABASE_URL).toBe(REQUIRED.DATABASE_URL_NOTIFICATION);
    expect(
      loadNotificationEnv({ ...REQUIRED, DATABASE_URL: 'postgresql://x:y@h:1/d' }).DATABASE_URL,
    ).toBe('postgresql://x:y@h:1/d');
  });

  it('requires the broker list, the identity url and the internal token secret', () => {
    for (const key of ['KAFKA_BROKERS', 'IDENTITY_SERVICE_URL', 'INTERNAL_TOKEN_SECRET'] as const) {
      const { [key]: _omitted, ...without } = REQUIRED;
      expect(() => loadNotificationEnv(without)).toThrow(new RegExp(key));
    }
  });

  it('refuses an identity url that is not http(s)', () => {
    expect(() =>
      loadNotificationEnv({ ...REQUIRED, IDENTITY_SERVICE_URL: 'identity:3101' }),
    ).toThrow();
  });

  it('names the dispatcher group and the dlq the platform already reserves', () => {
    const env = loadNotificationEnv(REQUIRED);
    expect(env.KAFKA_CONSUMER_GROUP).toBe(DISPATCHER_CONSUMER_GROUP);
    expect(DISPATCHER_CONSUMER_GROUP).toBe('notification-service.dispatcher');
    expect(NOTIFICATION_DLQ_TOPIC).toBe('rasta.notification.v1.dlq');
    expect(env.KAFKA_CLIENT_ID).toBe(SERVICE_NAME);
    expect(IDENTITY_SERVICE).toBe('identity-service');
  });

  it('applies the ADR-054 defaults for the tunables', () => {
    const env = loadNotificationEnv(REQUIRED);
    expect(env.NOTIFICATION_MAX_RECIPIENTS_PER_INTENT).toBe(500);
    expect(env.NOTIFICATION_RECIPIENT_CACHE_TTL_SECONDS).toBe(60);
    expect(env.NOTIFICATION_DEDUPE_RETENTION_DAYS).toBe(45);
    expect(env.NOTIFICATION_IDENTITY_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(env.NOTIFICATION_RESOLUTION_LEASE_SECONDS).toBe(60);
    expect(env.NOTIFICATION_RESOLUTION_BACKOFF_MAX_SECONDS).toBe(600);
  });

  it('bounds every tunable so a misconfiguration cannot disable a control', () => {
    expect(() =>
      loadNotificationEnv({ ...REQUIRED, NOTIFICATION_MAX_RECIPIENTS_PER_INTENT: '0' }),
    ).toThrow();
    expect(() =>
      loadNotificationEnv({ ...REQUIRED, NOTIFICATION_DEDUPE_RETENTION_DAYS: '0' }),
    ).toThrow();
    expect(() =>
      loadNotificationEnv({ ...REQUIRED, NOTIFICATION_RESOLUTION_LEASE_SECONDS: '5' }),
    ).toThrow();
    expect(() =>
      loadNotificationEnv({ ...REQUIRED, NOTIFICATION_RESOLUTION_BATCH_SIZE: '5000' }),
    ).toThrow();
  });

  it('has no email provider or sender setting: Q-37 is open', () => {
    // A key with a default would settle Q-37 silently (AGENTS.md § 9).
    const env = loadNotificationEnv(REQUIRED);
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/SMTP|MAIL|SENDER|FROM_ADDRESS/i);
    }
  });

  it('rejects an out-of-range port instead of coercing it', () => {
    expect(() => loadNotificationEnv({ ...REQUIRED, PORT: '70000' })).toThrow();
    expect(() => loadNotificationEnv({ ...REQUIRED, PORT: 'not-a-port' })).toThrow();
  });

  it('reads cors origins and brokers as trimmed, empty-free lists', () => {
    expect(corsOrigins(loadNotificationEnv({ ...REQUIRED, CORS_ORIGINS: '' }))).toEqual([]);
    expect(
      corsOrigins(
        loadNotificationEnv({ ...REQUIRED, CORS_ORIGINS: 'https://a.test, https://b.test ,' }),
      ),
    ).toEqual(['https://a.test', 'https://b.test']);
    expect(
      corsOrigins(
        loadNotificationEnv({ ...REQUIRED, GATEWAY_CORS_ORIGINS: 'https://portal.test' }),
      ),
    ).toEqual(['https://portal.test']);
    expect(
      brokersOf(loadNotificationEnv({ ...REQUIRED, KAFKA_BROKERS: 'a:9092, b:9092,' })),
    ).toEqual(['a:9092', 'b:9092']);
  });
});
