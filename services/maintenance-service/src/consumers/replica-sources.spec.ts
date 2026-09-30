import { AssetSnapshotClient } from './replica-sources';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const full = (organizationId: string) => ({
  transferred: false,
  assetId: 'AST_1',
  organizationId,
  status: 'ACTIVE',
  name: 'لودر',
  type: 'LOADER',
  assetTag: null,
  transferGeneration: 1,
});

function client(responses: Response[]) {
  const issue = jest.fn(async () => 'signed');
  const fetchImpl = jest.fn(async () => responses.shift() ?? json(500, {}));
  return {
    issue,
    fetchImpl,
    client: new AssetSnapshotClient({
      from: 'maintenance-service',
      baseUrl: 'http://asset.internal',
      timeoutMs: 500,
      tokens: { issue },
      fetch: fetchImpl as unknown as typeof fetch,
    }),
  };
}

describe('AssetSnapshotClient', () => {
  it('returns the owner’s snapshot', async () => {
    const { client: c, issue } = client([json(200, full('ORG_A'))]);
    await expect(c.snapshot('ORG_A', 'AST_1')).resolves.toMatchObject({ organizationId: 'ORG_A' });
    expect(issue).toHaveBeenCalledWith('maintenance-service', 'asset-service', 'SERVICE', 'ORG_A');
  });

  it('follows a previous owner to the current one, once', async () => {
    const {
      client: c,
      fetchImpl,
      issue,
    } = client([
      json(200, {
        transferred: true,
        assetId: 'AST_1',
        organizationId: 'ORG_B',
        transferGeneration: 2,
      }),
      json(200, full('ORG_B')),
    ]);
    await expect(c.snapshot('ORG_A', 'AST_1')).resolves.toMatchObject({ organizationId: 'ORG_B' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenLastCalledWith(
      'maintenance-service',
      'asset-service',
      'SERVICE',
      'ORG_B',
    );
  });

  it('reads NOT_FOUND as "not known" and everything else that is not a 200 about this asset as no answer', async () => {
    await expect(
      client([json(404, { code: 'NOT_FOUND' })]).client.snapshot('ORG_A', 'AST_1'),
    ).resolves.toBeNull();
    for (const bad of [
      json(404, { message: 'route' }),
      json(403, { code: 'FORBIDDEN' }),
      json(500, {}),
      json(200, { ...full('ORG_A'), assetId: 'AST_OTHER' }),
    ]) {
      await expect(client([bad]).client.snapshot('ORG_A', 'AST_1')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    }
  });
});
