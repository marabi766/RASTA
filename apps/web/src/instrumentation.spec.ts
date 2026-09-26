/**
 * @jest-environment node
 */
import { register } from './instrumentation';

/**
 * A production server does not come up half-configured (ADR-059): the check
 * runs at start, not at the first request that happens to need the value.
 */

const COMPLETE = {
  API_GATEWAY_URL: 'http://gateway:3000',
  OIDC_ISSUER_URL: 'http://keycloak:8080/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'https://portal.example',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_REDIS_URL: 'redis://redis:6379',
};

const saved = { ...process.env };

function environment(values: Record<string, string | undefined>): void {
  for (const key of [...Object.keys(COMPLETE), 'NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE']) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

let exit: jest.SpyInstance;
beforeEach(() => {
  exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.env = { ...saved };
  exit.mockRestore();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('register', () => {
  it('refuses to start a production server without WEB_REDIS_URL', async () => {
    environment({
      ...COMPLETE,
      WEB_REDIS_URL: undefined,
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
    });
    await expect(register()).rejects.toThrow(/WEB_REDIS_URL/);
    // Stops, rather than staying up answering 500 to everything.
    await tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('refuses to start a production server missing anything else', async () => {
    environment({
      ...COMPLETE,
      WEB_SESSION_SECRET: undefined,
      NODE_ENV: 'production',
      NEXT_RUNTIME: 'nodejs',
    });
    await expect(register()).rejects.toThrow(/WEB_SESSION_SECRET/);
    await tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts a complete production server', async () => {
    environment({ ...COMPLETE, NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs' });
    await expect(register()).resolves.toBeUndefined();
    await tick();
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ['a development server', { NODE_ENV: 'development', NEXT_RUNTIME: 'nodejs' }],
    [
      'a production build',
      { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', NEXT_PHASE: 'phase-production-build' },
    ],
    ['the edge runtime', { NODE_ENV: 'production', NEXT_RUNTIME: 'edge' }],
  ])('does not check %s', async (_label, values) => {
    environment(values);
    await expect(register()).resolves.toBeUndefined();
    await tick();
    expect(exit).not.toHaveBeenCalled();
  });
});
