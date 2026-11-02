import { inspect } from 'node:util';
import {
  assertRedisDiagnosticsSafe,
  assertTemporalDiagnosticsSafe,
  protectRedisReadyCheck,
} from './sdk-diagnostics';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

test.each(['ioredis:redis', 'ioredis:*', '*', 'ior*', 'app,ioredis:redis', '*,-ioredis:*'])(
  'refuses credential-bearing tracing family %s',
  (debug) => {
    process.env.DEBUG = debug;
    expect(assertRedisDiagnosticsSafe).toThrow('REDIS_URL: SDK tracing refused (DEBUG)');
  },
);
test.each(['', 'app:*', '-ioredis:*', 'express,app'])('allows unrelated tracing %s', (debug) => {
  process.env.DEBUG = debug;
  expect(assertRedisDiagnosticsSafe).not.toThrow();
});
test.each(['GRPC_TRACE', 'GRPC_VERBOSITY'])(
  'refuses %s without disclosing its arbitrary value',
  (setting) => {
    process.env[setting] = 'private-sentinel-79 JZ97-another-secret';
    let failure;
    try {
      assertTemporalDiagnosticsSafe();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: 10, showHidden: true })).not.toMatch(/sentinel|JZ97/i);
  },
);
test('INFO/NOPERM is replaced while readiness and other error identities are retained', () => {
  const failure = new Error('NOPERM private-sentinel-79 JZ97-another-secret');
  const result = { loading: 0 };
  const redis = {
    info: jest.fn((callback: (error: Error, result: unknown) => void) => callback(failure, result)),
  };
  protectRedisReadyCheck(redis);
  const callback = jest.fn();
  redis.info(callback);
  const [safe, actualResult] = callback.mock.calls[0]!;
  expect(safe).not.toBe(failure);
  expect(safe.message).toContain('NOPERM');
  expect(inspect(safe, { depth: 10, showHidden: true })).not.toMatch(/sentinel|JZ97/i);
  expect(actualResult).toBe(result);
  failure.message = 'ordinary failure';
  redis.info(callback);
  expect(callback.mock.calls[1]![0]).toBe(failure);
});
