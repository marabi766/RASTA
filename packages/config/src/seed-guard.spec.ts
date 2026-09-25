import { DemoSeedRefusedError, assertDemoSeedAllowed, demoSeedRefusals } from './seed-guard';

/**
 * The demo-seed gate. Fail closed is the whole point: every case that is not
 * explicitly a development or test run with the opt-in typed must refuse.
 */
describe('assertDemoSeedAllowed', () => {
  const allowed = { NODE_ENV: 'development', RASTA_ALLOW_DEMO_SEED: 'true' };

  it.each([
    ['development', { ...allowed }],
    ['test', { ...allowed, NODE_ENV: 'test' }],
  ])('lets a %s run with the opt-in through', (_label, env) => {
    expect(() => assertDemoSeedAllowed('organization-service', env)).not.toThrow();
  });

  it.each([
    ['production', { ...allowed, NODE_ENV: 'production' }],
    ['staging', { ...allowed, NODE_ENV: 'staging' }],
    ['an unset NODE_ENV', { RASTA_ALLOW_DEMO_SEED: 'true' }],
    ['a blank NODE_ENV', { ...allowed, NODE_ENV: '  ' }],
    ['an unknown NODE_ENV', { ...allowed, NODE_ENV: 'dev' }],
    ['no opt-in', { NODE_ENV: 'development' }],
    ['an opt-in of "1"', { ...allowed, RASTA_ALLOW_DEMO_SEED: '1' }],
    ['an opt-in of "TRUE"', { ...allowed, RASTA_ALLOW_DEMO_SEED: 'TRUE' }],
    ['an opt-in of "yes"', { ...allowed, RASTA_ALLOW_DEMO_SEED: 'yes' }],
    ['production even with the opt-in', { NODE_ENV: 'production', RASTA_ALLOW_DEMO_SEED: 'true' }],
  ])('refuses %s', (_label, env) => {
    expect(() => assertDemoSeedAllowed('organization-service', env)).toThrow(DemoSeedRefusedError);
  });

  it('names every failed condition, not only the first', () => {
    expect(demoSeedRefusals({ NODE_ENV: 'production' })).toEqual([
      'NODE_ENV is not a development or test environment',
      'RASTA_ALLOW_DEMO_SEED is not "true"',
    ]);
  });

  it('never echoes a value it read', () => {
    // A refusal lands in terminals and CI logs; the value it rejected could be
    // anything an operator pasted into the variable.
    const error = (() => {
      try {
        assertDemoSeedAllowed('identity-service', {
          NODE_ENV: 'prod-eu-secret-marker',
          RASTA_ALLOW_DEMO_SEED: 'opt-in-secret-marker',
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected a refusal');
    })();

    expect(error.message).not.toContain('secret-marker');
    expect(error.message).toContain('identity-service');
    expect(error.message).toContain('Nothing was written');
  });

  it('reads process.env by default', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.RASTA_ALLOW_DEMO_SEED = 'true';
      expect(() => assertDemoSeedAllowed('asset-service')).toThrow(DemoSeedRefusedError);
    } finally {
      process.env = saved;
    }
  });
});
