import { RastaError } from '@rasta/nest-common';
import {
  TransferRecordClient,
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  settleExpiredFence,
  type FenceStore,
  type TransferRecordSource,
} from './transfer-record';

/**
 * Resolving an expired transfer fence at its source (ADR-062 § 3b, review
 * #127 #2), with asset-service replaced by a scripted `fetch`. The endpoint
 * itself is proved against PostgreSQL in asset-service.
 */

const ORG = 'ORG-DEH-0001';
const ASSET = 'AST_01JASSET0000000000000001';
const FENCE = 'TRF_01JTRANSFER000000000000001';

function client(respond: () => Response | Promise<Response>) {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const issued: unknown[][] = [];
  const instance = new TransferRecordClient({
    baseUrl: 'http://asset:3103/',
    timeoutMs: 200,
    tokens: {
      issue: async (...args: unknown[]) => {
        issued.push(args);
        return 'signed-token';
      },
    } as never,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string> });
      return respond();
    }) as never,
  });
  return { instance, sent, issued };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TransferRecordClient', () => {
  it('asks under a token signed with the fence’s organization, and reads RECORDED', async () => {
    const { instance, sent, issued } = client(() =>
      json(200, { assetId: ASSET, transferId: FENCE, recorded: true }),
    );

    await expect(instance.resolve(ORG, ASSET, FENCE)).resolves.toBe('RECORDED');
    expect(issued).toEqual([['fleet-service', 'asset-service', 'SERVICE', ORG]]);
    expect(sent[0]!.url).toBe(`http://asset:3103/v1/internal/assets/${ASSET}/transfers/${FENCE}`);
    expect(sent[0]!.headers['x-internal-token']).toBe('signed-token');
    expect(Object.keys(sent[0]!.headers)).not.toContain('x-organization-id');
  });

  it('reads asset-service’s own NOT_FOUND as NOT_RECORDED', async () => {
    const { instance } = client(() =>
      json(404, { code: 'NOT_FOUND', message: 'AssetTransfer not found' }),
    );
    await expect(instance.resolve(ORG, ASSET, FENCE)).resolves.toBe('NOT_RECORDED');
  });

  it.each([
    ['a 5xx', () => json(503, { code: 'INTERNAL_ERROR', message: 'x' })],
    ['a 403', () => json(403, { code: 'FORBIDDEN', message: 'x' })],
    ['a route-level 404', () => json(404, { code: 'NOT_FOUND', message: 'Cannot GET /v1/x' })],
    ['a 404 with no body', () => new Response('', { status: 404 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['recorded: false', () => json(200, { assetId: ASSET, transferId: FENCE, recorded: false })],
    [
      'an answer about another transfer',
      () => json(200, { assetId: ASSET, transferId: 'TRF_X', recorded: true }),
    ],
    [
      'an answer about another machine',
      () => json(200, { assetId: 'AST_X', transferId: FENCE, recorded: true }),
    ],
  ])('gives no answer on %s', async (_label, respond) => {
    const { instance } = client(respond);
    await expect(instance.resolve(ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('gives no answer on a transport error, without quoting it', async () => {
    const { instance } = client(() => {
      throw new Error('connect ECONNREFUSED http://asset:3103 token=signed-token');
    });
    const error = await instance.resolve(ORG, ASSET, FENCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RastaError);
    expect(JSON.stringify(error)).not.toMatch(/ECONNREFUSED|signed-token|asset:3103/);
  });

  it('gives no answer after its deadline', async () => {
    const { instance } = client(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () => resolve(json(200, { assetId: ASSET, transferId: FENCE, recorded: true })),
            400,
          ),
        ),
    );
    await expect(instance.resolve(ORG, ASSET, FENCE)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('never answers when unconfigured', async () => {
    await expect(
      UNCONFIGURED_TRANSFER_RECORD_SOURCE.resolve(ORG, ASSET, FENCE),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});

describe('settleExpiredFence', () => {
  function store(fence: { fenceId: string; organizationId: string; expired: boolean } | null) {
    const cleared: string[] = [];
    const instance: FenceStore = {
      findTransferFence: async () => fence,
      clearExpiredFence: async (_assetId, fenceId) => {
        cleared.push(fenceId);
      },
    };
    return { instance, cleared };
  }
  const answering = (
    answer: 'RECORDED' | 'NOT_RECORDED',
  ): TransferRecordSource & { asked: unknown[][] } => {
    const asked: unknown[][] = [];
    return {
      asked,
      resolve: async (...args) => {
        asked.push(args);
        return answer;
      },
    };
  };

  it('asks nothing when there is no fence, or a live one', async () => {
    const source = answering('NOT_RECORDED');
    expect(await settleExpiredFence(store(null).instance, source, ASSET)).toBe('NONE');
    expect(
      await settleExpiredFence(
        store({ fenceId: FENCE, organizationId: ORG, expired: false }).instance,
        source,
        ASSET,
      ),
    ).toBe('LIVE');
    expect(source.asked).toEqual([]);
  });

  it('keeps the fence of a transfer that was recorded', async () => {
    const { instance, cleared } = store({ fenceId: FENCE, organizationId: ORG, expired: true });
    const source = answering('RECORDED');

    expect(await settleExpiredFence(instance, source, ASSET)).toBe('RECORDED');
    expect(source.asked).toEqual([[ORG, ASSET, FENCE]]);
    expect(cleared).toEqual([]);
  });

  it('clears exactly that fence when its transfer was not recorded', async () => {
    const { instance, cleared } = store({ fenceId: FENCE, organizationId: ORG, expired: true });

    expect(await settleExpiredFence(instance, answering('NOT_RECORDED'), ASSET)).toBe('CLEARED');
    expect(cleared).toEqual([FENCE]);
  });

  it('keeps the fence and fails when asset-service gives no answer', async () => {
    const { instance, cleared } = store({ fenceId: FENCE, organizationId: ORG, expired: true });

    await expect(
      settleExpiredFence(instance, UNCONFIGURED_TRANSFER_RECORD_SOURCE, ASSET),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(cleared).toEqual([]);
  });
});
