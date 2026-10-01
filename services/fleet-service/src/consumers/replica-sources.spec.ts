import { AssetSnapshotClient, MaintenanceStateClient } from './replica-sources';

const tokens = { issue: jest.fn(async () => 'signed') };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const full = (organizationId: string, extra: object = {}) => ({
  transferred: false,
  assetId: 'AST_1',
  organizationId,
  status: 'ACTIVE',
  name: 'لودر',
  type: 'LOADER',
  assetTag: null,
  transferGeneration: 1,
  ...extra,
});

function snapshotClient(responses: Response[]) {
  const fetchImpl = jest.fn(async () => responses.shift() ?? json(500, {}));
  const client = new AssetSnapshotClient({
    from: 'fleet-service',
    baseUrl: 'http://asset.internal',
    timeoutMs: 500,
    tokens,
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe('AssetSnapshotClient', () => {
  beforeEach(() => tokens.issue.mockClear());

  it('returns the owner’s snapshot, asked under the organization it was given', async () => {
    const { client } = snapshotClient([json(200, full('ORG_A'))]);
    await expect(client.snapshot('ORG_A', 'AST_1')).resolves.toMatchObject({
      organizationId: 'ORG_A',
      status: 'ACTIVE',
    });
    expect(tokens.issue).toHaveBeenCalledWith('fleet-service', 'asset-service', 'SERVICE', 'ORG_A');
  });

  it('follows a previous owner to the current one, once, asking as the current owner', async () => {
    const { client, fetchImpl } = snapshotClient([
      json(200, {
        transferred: true,
        assetId: 'AST_1',
        organizationId: 'ORG_B',
        transferGeneration: 2,
      }),
      json(200, full('ORG_B')),
    ]);
    await expect(client.snapshot('ORG_A', 'AST_1')).resolves.toMatchObject({
      organizationId: 'ORG_B',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(tokens.issue).toHaveBeenLastCalledWith(
      'fleet-service',
      'asset-service',
      'SERVICE',
      'ORG_B',
    );
  });

  it('gives up on a second hop', async () => {
    const moved = {
      transferred: true,
      assetId: 'AST_1',
      organizationId: 'ORG_B',
      transferGeneration: 2,
    };
    const { client } = snapshotClient([json(200, moved), json(200, moved)]);
    await expect(client.snapshot('ORG_A', 'AST_1')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('reads asset-service’s own NOT_FOUND as "not known", and nothing else as an answer', async () => {
    await expect(
      snapshotClient([
        json(404, { code: 'NOT_FOUND', message: 'Asset not found' }),
      ]).client.snapshot('ORG_A', 'AST_1'),
    ).resolves.toBeNull();

    for (const bad of [
      json(404, { message: 'route not found' }),
      json(403, { code: 'FORBIDDEN' }),
      json(500, {}),
      json(200, { transferred: false }),
      json(200, full('ORG_A', { assetId: 'AST_OTHER' })),
      new Response('<html>', { status: 200 }),
    ]) {
      await expect(snapshotClient([bad]).client.snapshot('ORG_A', 'AST_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }
  });
});

describe('MaintenanceStateClient', () => {
  const client = (response: Response) =>
    new MaintenanceStateClient({
      from: 'fleet-service',
      baseUrl: 'http://maintenance.internal',
      timeoutMs: 500,
      tokens,
      fetch: (async () => response) as unknown as typeof fetch,
    });

  it('returns the flag from a well-formed 200 about this asset', async () => {
    await expect(
      client(json(200, { assetId: 'AST_1', inMaintenance: true })).inMaintenance('ORG_A', 'AST_1'),
    ).resolves.toBe(true);
  });

  it('treats anything else as no answer', async () => {
    for (const bad of [
      json(404, { code: 'NOT_FOUND' }),
      json(500, {}),
      json(200, { assetId: 'AST_OTHER', inMaintenance: false }),
      json(200, { assetId: 'AST_1' }),
    ]) {
      await expect(client(bad).inMaintenance('ORG_A', 'AST_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }
  });
});
