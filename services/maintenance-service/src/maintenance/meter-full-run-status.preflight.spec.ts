export {};

const disconnect = jest.fn();
const construct = jest.fn();
const status = jest.fn();
const stop = jest.fn();
const facts = {
  role: 'rasta_maintenance',
  sessionRole: 'rasta_maintenance',
  database: 'synthetic',
  timeZone: 'UTC',
  superuser: false,
  createDb: false,
  createRole: false,
  bypassRls: false,
  replication: false,
  ownsDatabase: false,
  ownedSchemas: [],
  ownsRelationIn: [],
  createOnDatabase: false,
  createOnSchemas: [],
  memberOf: [],
};
// Load the REAL shared source deliberately: workspace imports otherwise use dist.
// Only the synthetic DB transport and subsequent application work are replaced.
jest.mock('@rasta/nest-common', () =>
  jest.requireActual('../../../../packages/nest-common/src/database/runtime-role'),
);
jest.mock('../config/env', () => ({
  SERVICE_NAME: 'maintenance-service',
  loadMaintenanceEnv: () => ({ DATABASE_URL: 'synthetic-unit-url' }),
}));
jest.mock('../generated/prisma', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRawUnsafe: async () => [facts],
    $disconnect: disconnect,
  })),
}));
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => {
    construct();
    return { onModuleInit: async () => undefined, stop };
  }),
}));
jest.mock('./meter-full-run', () => ({
  MeterFullRun: jest.fn().mockImplementation(() => ({ status })),
}));

describe('status CLI with real shared preflight cleanup', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let output: jest.SpyInstance;
  let diagnostic: jest.SpyInstance;
  let exit: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env = { METER_RECONCILE_OPERATOR_ID: 'USR_STATUS' };
    process.argv = ['node', 'cli', '--run-id', 'RUN_STATUS'];
    disconnect.mockResolvedValue(undefined);
    status.mockResolvedValue(null);
    stop.mockResolvedValue({ drained: true });
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    diagnostic = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = originalEnv;
    process.argv = originalArgv;
  });
  const run = async (): Promise<void> => {
    await jest.isolateModulesAsync(async () => {
      await import('./meter-full-run-status.cli');
    });
    await jest.advanceTimersByTimeAsync(0);
  };
  it('prints success only after both clients confirm closure', async () => {
    let close!: () => void;
    disconnect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        close = resolve;
      }),
    );
    await run();
    expect(construct).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    close();
    await jest.advanceTimersByTimeAsync(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith('null\n');
    expect(diagnostic).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['reject', 'sync throw', 'pending then reject', 'pending then resolve'])(
    'refuses %s before service construction, status, or output',
    async (mode) => {
      const secret = new Error('postgresql://private:secret@db.invalid/db');
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      disconnect.mockImplementation(() => {
        if (mode === 'reject') return Promise.reject(secret);
        if (mode === 'sync throw') throw secret;
        return new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
      });
      await run();
      if (mode.startsWith('pending')) {
        expect(exit).not.toHaveBeenCalled();
        expect(construct).not.toHaveBeenCalled();
        await jest.runAllTimersAsync();
        if (mode.endsWith('reject')) reject(secret);
        else resolve();
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(construct).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringMatching(/^command refused \(code runtime-role-unverified\);/),
      );
      expect(diagnostic.mock.calls.flat().join('')).not.toMatch(/private|secret|db\.invalid/);
      expect(exit.mock.calls).toEqual([[2]]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
