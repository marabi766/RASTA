import { RastaError } from '@rasta/nest-common';
import {
  FLEET_SERVICE,
  MAINTENANCE_SERVICE,
  TransferClearanceClient,
  UNCONFIGURED_TRANSFER_CLEARANCE,
} from './transfer-clearance';

/**
 * The question asset-service asks before a transfer (ADR-062), with the owners
 * replaced by a scripted `fetch`. The owners' side, and the fence itself, are
 * proved against PostgreSQL in fleet-service and maintenance-service.
 */

const ORG = 'ORG-DEH-0001';
const ASSET = 'AST_01JASSET0000000000000001';
const FENCE = 'TRF_01JTRANSFER000000000000001';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function client(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const issued: unknown[][] = [];
  const instance = new TransferClearanceClient({
    baseUrls: { [FLEET_SERVICE]: 'http://fleet:3104/', [MAINTENANCE_SERVICE]: 'http://mnt:3105' },
    timeoutMs: 200,
    fenceTtlSeconds: 600,
    tokens: {
      issue: async (...args: unknown[]) => {
        issued.push(args);
        return 'signed-token';
      },
    } as never,
    fetch: (async (url: string, init: RequestInit) => {
      const request: Sent = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      };
      sent.push(request);
      if (init.signal?.aborted) throw new Error('aborted');
      return respond(request);
    }) as never,
  });
  return { instance, sent, issued };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fleetClear = {
  assetId: ASSET,
  fenceId: FENCE,
  clear: true,
  fencedUntil: '2026-09-26T12:10:00.000Z',
  openAssignments: 0,
};

const maintenanceClear = {
  assetId: ASSET,
  fenceId: FENCE,
  clear: true,
  fencedUntil: '2026-09-26T12:10:00.000Z',
  openRequests: 0,
  openRepairOrders: 0,
};

describe('TransferClearanceClient', () => {
  it('asks the owner under a token signed with the owning organization, never a header', async () => {
    const { instance, sent, issued } = client(() => json(200, fleetClear));

    await expect(instance.ask(FLEET_SERVICE, ORG, ASSET, FENCE)).resolves.toEqual({ clear: true });

    expect(issued).toEqual([['asset-service', 'fleet-service', 'SERVICE', ORG]]);
    expect(sent[0]).toMatchObject({
      url: `http://fleet:3104/v1/internal/assets/${ASSET}/transfer-clearance`,
      method: 'POST',
    });
    expect(sent[0]!.headers['x-internal-token']).toBe('signed-token');
    expect(JSON.parse(sent[0]!.body!)).toEqual({ fenceId: FENCE, ttlSeconds: 600 });
    expect(Object.keys(sent[0]!.headers)).not.toContain('x-organization-id');
  });

  it('reports open work with the counts that are above zero', async () => {
    const { instance } = client(() =>
      json(200, { ...maintenanceClear, clear: false, fencedUntil: null, openRequests: 1 }),
    );

    await expect(instance.ask(MAINTENANCE_SERVICE, ORG, ASSET, FENCE)).resolves.toEqual({
      clear: false,
      open: { openRequests: 1 },
    });
  });

  it.each([
    ['a 5xx', () => json(503, { code: 'INTERNAL_ERROR', message: 'x' })],
    ['a 403 from a misconfigured allowlist', () => json(403, { code: 'FORBIDDEN', message: 'x' })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body of the wrong shape', () => json(200, { clear: true })],
    ['an answer about another machine', () => json(200, { ...fleetClear, assetId: 'AST_OTHER' })],
    ['an answer about another transfer', () => json(200, { ...fleetClear, fenceId: 'TRF_OTHER' })],
    ['"clear" with open work', () => json(200, { ...fleetClear, openAssignments: 1 })],
    ['"clear" without a fence', () => json(200, { ...fleetClear, fencedUntil: null })],
    ['"not clear" with nothing open', () => json(200, { ...fleetClear, clear: false })],
    ['a route-level 404', () => json(404, { code: 'NOT_FOUND', message: 'Cannot POST /v1/x' })],
    ['a 404 with no platform body', () => new Response('', { status: 404 })],
    ['a 409 from something else', () => new Response('conflict', { status: 409 })],
  ])('fails closed on %s', async (_label, respond) => {
    const { instance } = client(respond);

    await expect(instance.ask(FLEET_SERVICE, ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('fails closed on a transport error, without quoting it', async () => {
    const { instance } = client(() => {
      throw new Error('connect ECONNREFUSED http://fleet:3104 token=signed-token');
    });

    const error = await instance.ask(FLEET_SERVICE, ORG, ASSET, FENCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toMatch(/ECONNREFUSED|signed-token|fleet:3104/);
  });

  it('fails closed on a timeout', async () => {
    const { instance } = client(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(200, fleetClear)), 400)),
    );

    await expect(instance.ask(FLEET_SERVICE, ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('turns the owner’s own "not here" and "another transfer" into a conflict to retry', async () => {
    const notHere = client(() => json(404, { code: 'NOT_FOUND', message: 'Asset not found' }));
    await expect(notHere.instance.ask(FLEET_SERVICE, ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });

    const busy = client(() =>
      json(409, { code: 'INVALID_STATE_TRANSITION', message: 'Another transfer…' }),
    );
    await expect(busy.instance.ask(MAINTENANCE_SERVICE, ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('releases by fence id and never throws, whatever the owner says', async () => {
    const { instance, sent } = client(() => {
      throw new Error('down');
    });

    await expect(instance.release(MAINTENANCE_SERVICE, ORG, ASSET, FENCE)).resolves.toBeUndefined();
    expect(sent[0]).toMatchObject({
      url: `http://mnt:3105/v1/internal/assets/${ASSET}/transfer-clearance/${FENCE}`,
      method: 'DELETE',
    });
  });

  it('refuses everything when no clearance was configured', async () => {
    await expect(
      UNCONFIGURED_TRANSFER_CLEARANCE.ask(FLEET_SERVICE, ORG, ASSET, FENCE),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});
