import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { observerKafkaSettings } from './kafka-observer.ts';

/** The E2E harness's Kafka settings (review of #131, finding 6), without a broker. */
describe('observerKafkaSettings', () => {
  const root = '/repo';
  const files = (contents: Record<string, string>) => ({
    exists: (path: string) => path in contents,
    read: (path: string) => contents[path] ?? '',
  });
  const example = '/repo/infrastructure/docker/kafka/bootstrap.env.example';
  const local = '/repo/infrastructure/docker/kafka/bootstrap.env';
  const ca = '/repo/infrastructure/docker/kafka/.tls/ca.pem';
  const bootstrap = [
    'KAFKA_SASL_PASSWORD_ADMIN=admin-secret',
    'KAFKA_SASL_PASSWORD_OPS_REPLAY=replay-secret',
    'KAFKA_SASL_PASSWORD_ITEST_OBSERVER=observer-from-example',
  ].join('\n');

  it('reads only the observer’s password from the bootstrap example, and trusts the exported CA', () => {
    const settings = observerKafkaSettings({}, files({ [example]: bootstrap, [ca]: 'PEM' }), root);
    assert.deepEqual(settings, { password: 'observer-from-example', caFile: ca });
    assert.ok(!JSON.stringify(settings).includes('admin-secret'));
    assert.ok(!JSON.stringify(settings).includes('replay-secret'));
  });

  it('prefers the environment, then the local bootstrap.env, over the example', () => {
    const disk = files({
      [example]: bootstrap,
      [local]: 'KAFKA_SASL_PASSWORD_ITEST_OBSERVER="observer-local"',
    });
    assert.equal(observerKafkaSettings({}, disk, root).password, 'observer-local');
    assert.equal(
      observerKafkaSettings({ KAFKA_SASL_PASSWORD_ITEST_OBSERVER: 'from-env' }, disk, root)
        .password,
      'from-env',
    );
  });

  it('takes a configured CA, resolving a relative one as the repository .env writes it', () => {
    const settings = observerKafkaSettings(
      { KAFKA_SSL_CA_FILE: '../../infrastructure/docker/kafka/.tls/ca.pem' },
      files({}),
      root,
    );
    assert.equal(settings.caFile, ca);
  });

  it('is PLAINTEXT with KAFKA_SSL=false, or when no CA exists', () => {
    assert.equal(
      observerKafkaSettings({ KAFKA_SSL: 'false' }, files({ [ca]: 'PEM' }), root).caFile,
      undefined,
    );
    assert.equal(observerKafkaSettings({}, files({}), root).caFile, undefined);
  });
});
