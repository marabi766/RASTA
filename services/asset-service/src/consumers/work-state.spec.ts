import { AssetWorkStateClient, statusFromWorkState } from './work-state';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(routes: { fleet: Response | Error; maintenance: Response | Error }) {
  const pick = (r: Response | Error) => async () => {
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return new AssetWorkStateClient({
    from: 'asset-service',
    fleet: {
      baseUrl: 'http://fleet.internal',
      timeoutMs: 500,
      tokens: { issue: async () => 'signed' },
      fetch: pick(routes.fleet) as unknown as typeof fetch,
    },
    maintenance: {
      baseUrl: 'http://maintenance.internal',
      timeoutMs: 500,
      tokens: { issue: async () => 'signed' },
      fetch: pick(routes.maintenance) as unknown as typeof fetch,
    },
  });
}

const fleetOk = (active: boolean) => json(200, { assetId: 'AST_1', activeAssignment: active });
const maintenanceOk = (inMaintenance: boolean) => json(200, { assetId: 'AST_1', inMaintenance });

describe('statusFromWorkState', () => {
  it('a repair in progress wins over an assignment, an assignment over nothing', () => {
    expect(statusFromWorkState({ inMaintenance: true, activeAssignment: true })).toBe(
      'IN_MAINTENANCE',
    );
    expect(statusFromWorkState({ inMaintenance: false, activeAssignment: true })).toBe('ASSIGNED');
    expect(statusFromWorkState({ inMaintenance: false, activeAssignment: false })).toBe('ACTIVE');
  });
});

describe('AssetWorkStateClient', () => {
  it('returns both owners’ answers', async () => {
    await expect(
      client({ fleet: fleetOk(true), maintenance: maintenanceOk(false) }).read('ORG_A', 'AST_1'),
    ).resolves.toEqual({ activeAssignment: true, inMaintenance: false });
  });

  it('fails closed when either owner gives no answer', async () => {
    await expect(
      client({ fleet: new Error('down'), maintenance: maintenanceOk(false) }).read(
        'ORG_A',
        'AST_1',
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(
      client({ fleet: fleetOk(false), maintenance: json(500, {}) }).read('ORG_A', 'AST_1'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(
      client({ fleet: json(404, { code: 'NOT_FOUND' }), maintenance: maintenanceOk(false) }).read(
        'ORG_A',
        'AST_1',
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(
      client({
        fleet: fleetOk(false),
        maintenance: json(200, { assetId: 'AST_OTHER', inMaintenance: false }),
      }).read('ORG_A', 'AST_1'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});
