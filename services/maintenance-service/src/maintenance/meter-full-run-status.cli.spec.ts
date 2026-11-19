const preflight = jest.fn();
const connect = jest.fn();
const stop = jest.fn();
const status = jest.fn();
const construct = jest.fn();
const order: string[] = [];

jest.mock('@rasta/nest-common', () => ({ preflightRuntimeRole: preflight }));
jest.mock('../config/env', () => ({
  SERVICE_NAME: 'maintenance-service',
  loadMaintenanceEnv: () => ({ DATABASE_URL: 'synthetic-unit-url' }),
}));
jest.mock('../generated/prisma', () => ({ PrismaClient: jest.fn() }));
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => {
    construct();
    return { onModuleInit: connect, stop };
  }),
}));
jest.mock('./meter-full-run', () => ({
  MeterFullRun: jest.fn().mockImplementation(() => ({ status })),
}));
jest.mock('@nestjs/common', () => ({ Logger: { overrideLogger: jest.fn() } }));

describe('standalone full-run status lifecycle', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let output: jest.SpyInstance;
  let diagnostic: jest.SpyInstance;
  let exit: jest.SpyInstance;
  beforeEach(() => {
    process.env = { METER_RECONCILE_OPERATOR_ID: 'USR_STATUS' };
    process.argv = ['node', 'cli', '--run-id', 'RUN_STATUS'];
    order.length = 0;
    preflight.mockImplementation(async () => {
      order.push('preflight');
    });
    connect.mockImplementation(async () => {
      order.push('connect');
    });
    status.mockImplementation(async () => {
      order.push('status');
      return null;
    });
    stop.mockImplementation(async () => {
      order.push('stop');
      return { drained: true };
    });
    output = jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      order.push('output');
      return true;
    });
    diagnostic = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.argv = originalArgv;
  });
  const run = async (): Promise<void> => {
    await jest.isolateModulesAsync(async () => {
      await import('./meter-full-run-status.cli');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  it('calls only status once with the configured operator, then drains before JSON output', async () => {
    await run();
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith('RUN_STATUS', 'USR_STATUS');
    expect(order).toEqual(['preflight', 'connect', 'status', 'stop', 'output']);
    expect(output).toHaveBeenCalledWith('null\n');
    expect(diagnostic).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('accepts the largest approved status, including maximum JSON escaping', async () => {
    const value = {
      runId: 'r'.repeat(64),
      inventoryDigest: 'a'.repeat(64),
      sourceBoundary: '"'.repeat(256),
      assetCount: 20_000,
      refusedCount: 20_000,
    };
    status.mockResolvedValueOnce(value);
    await run();
    expect(output).toHaveBeenCalledWith(`${JSON.stringify(value)}\n`);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it('drains but refuses oversized stored output without printing any part', async () => {
    status.mockResolvedValueOnce({ sourceBoundary: 'x'.repeat(1025) });
    await run();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
  });
  it.each(['arguments', 'operator', 'owner credentials'])(
    'refuses %s before any DB construction',
    async (failure) => {
      if (failure === 'arguments') process.argv.push('--activate');
      if (failure === 'operator') delete process.env.METER_RECONCILE_OPERATOR_ID;
      if (failure === 'owner credentials')
        process.env.DATABASE_URL_MAINTENANCE_MIGRATOR = 'withheld';
      await run();
      expect(preflight).not.toHaveBeenCalled();
      expect(construct).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(2);
    },
  );
  it.each(['connect', 'status', 'drain-reject', 'drain-incomplete'])(
    'drains and withholds all output on %s failure',
    async (failure) => {
      const error = new Error('SECRET_FOREIGN_DIAGNOSTIC');
      if (failure === 'connect') connect.mockRejectedValueOnce(error);
      if (failure === 'status') status.mockRejectedValueOnce(error);
      if (failure === 'drain-reject') stop.mockRejectedValueOnce(error);
      if (failure === 'drain-incomplete') stop.mockResolvedValueOnce({ drained: false });
      await run();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(output).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringMatching(/^command failed \(code unknown\); diagnostics withheld;/),
      );
      expect(diagnostic.mock.calls.flat().join('')).not.toContain('SECRET_FOREIGN_DIAGNOSTIC');
      expect(exit).toHaveBeenCalledWith(2);
    },
  );
});
