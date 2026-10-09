import {
  AssetSnapshotClient,
  InsurancePolicyClient,
  MaintenanceStateClient,
} from './replica-sources';

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

/**
 * The wire shape asset-service's `InsurancePolicyStandingService` answers with
 * (its integration spec asserts these exact bodies): a change to either side
 * breaks one of the two specs.
 */
describe('InsurancePolicyClient', () => {
  const counting = (organizationId: string, extra: object = {}) => ({
    transferred: false,
    assetId: 'AST_1',
    policyId: 'INS_1',
    organizationId,
    counts: true,
    coverage: 'COMPREHENSIVE',
    validFrom: '2026-02-01T00:00:00.000Z',
    validUntil: '2027-02-01T00:00:00.000Z',
    ownershipGeneration: 3,
    ...extra,
  });
  const moved = { transferred: true, assetId: 'AST_1', organizationId: 'ORG_B' };

  function policyClient(responses: Response[]) {
    const fetchImpl = jest.fn(async () => responses.shift() ?? json(500, {}));
    const client = new InsurancePolicyClient({
      from: 'fleet-service',
      baseUrl: 'http://asset.internal',
      timeoutMs: 500,
      tokens,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    return { client, fetchImpl };
  }

  beforeEach(() => tokens.issue.mockClear());

  it('returns the window and generation the source states, asked under the given organization', async () => {
    const { client, fetchImpl } = policyClient([json(200, counting('ORG_A'))]);

    await expect(client.verify('ORG_A', 'AST_1', 'INS_1')).resolves.toEqual({
      counts: true,
      organizationId: 'ORG_A',
      coverage: 'COMPREHENSIVE',
      validFrom: '2026-02-01T00:00:00.000Z',
      validUntil: '2027-02-01T00:00:00.000Z',
      ownershipGeneration: 3,
    });
    expect(tokens.issue).toHaveBeenCalledWith('fleet-service', 'asset-service', 'SERVICE', 'ORG_A');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      'http://asset.internal/v1/internal/assets/AST_1/insurance-policies/INS_1',
    );
  });

  it('returns the reason a policy does not count', async () => {
    const { client } = policyClient([
      json(200, {
        transferred: false,
        assetId: 'AST_1',
        policyId: 'INS_1',
        organizationId: 'ORG_A',
        counts: false,
        reason: 'NOT_FOLLOWING_VEHICLE',
      }),
    ]);
    await expect(client.verify('ORG_A', 'AST_1', 'INS_1')).resolves.toEqual({
      counts: false,
      reason: 'NOT_FOLLOWING_VEHICLE',
    });
  });

  it('reads an unknown policy as one that does not count', async () => {
    const { client } = policyClient([json(404, { code: 'NOT_FOUND', message: 'x' })]);
    await expect(client.verify('ORG_A', 'AST_1', 'INS_1')).resolves.toEqual({
      counts: false,
      reason: 'UNKNOWN_POLICY',
    });
  });

  it('follows a previous owner to the current one, once, asking as the current owner', async () => {
    const { client, fetchImpl } = policyClient([json(200, moved), json(200, counting('ORG_B'))]);

    await expect(client.verify('ORG_A', 'AST_1', 'INS_1')).resolves.toMatchObject({
      counts: true,
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

  it('treats a second transfer, and anything malformed or about another policy, as no answer', async () => {
    for (const responses of [
      [json(200, moved), json(200, moved)],
      [json(500, {})],
      [json(403, { code: 'FORBIDDEN' })],
      [json(404, { code: 'ROUTE_NOT_FOUND' })],
      [json(200, counting('ORG_A', { policyId: 'INS_OTHER' }))],
      [json(200, counting('ORG_A', { validUntil: 'not a date' }))],
      [json(200, counting('ORG_A', { ownershipGeneration: -1 }))],
      [json(200, { transferred: false, assetId: 'AST_1', counts: true })],
    ]) {
      await expect(
        policyClient(responses).client.verify('ORG_A', 'AST_1', 'INS_1'),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    }
  });
});
