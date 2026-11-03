import { runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  RFQ_EVIDENCE_CALLER,
  RfqEvidenceService,
  assertRfqEvidenceCaller,
} from './rfq-evidence.service';
import { MAX_CHAIN_LINKS, type RfqEvidenceRepository } from './rfq-evidence.repository';
import { genesisReceipt } from './rfq-evidence';

/**
 * The second layer behind `@AllowService('procurement-service')`: the guard decides who may reach the
 * handler, this decides — at the point where the tenant is read — that the caller is procurement-service
 * acting for a tenant. Proven here on the context itself, because over HTTP the decorator answers first.
 */
const context = (overrides: Partial<RequestContext>): RequestContext => ({
  correlationId: 'COR_1',
  requestId: 'REQ_1',
  roles: [],
  organizationIds: [],
  authType: 'SERVICE',
  startedAt: Date.now(),
  callerService: 'procurement-service',
  organizationId: 'ORG_BUYER',
  ...overrides,
});

describe('assertRfqEvidenceCaller', () => {
  it('names procurement-service as the one caller', () => {
    expect(RFQ_EVIDENCE_CALLER).toBe('procurement-service');
  });

  it('returns the organization procurement-service acts for', () => {
    expect(runWithContext(context({}), () => assertRfqEvidenceCaller())).toBe('ORG_BUYER');
  });

  it.each([
    [
      'any other service, the tender chain’s reader included',
      { callerService: 'construction-service' },
    ],
    ['a service with no name', { callerService: undefined }],
    [
      'a person, whatever the role',
      { authType: 'USER' as const, callerService: undefined, roles: ['SYSTEM_ADMIN'] },
    ],
    ['an anonymous request', { authType: 'ANONYMOUS' as const, callerService: undefined }],
    ['procurement-service signed for no tenant', { organizationId: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => runWithContext(context(overrides), () => assertRfqEvidenceCaller())).toThrow(
      /reserved for procurement-service acting for a tenant/,
    );
  });
});

describe('RfqEvidenceService.chainOf', () => {
  const link = (seq: number) => ({
    seq,
    quotationId: 'QUO_1',
    revision: 1,
    receivedAt: new Date('2026-11-02T10:00:00.000Z'),
    ciphertextSha256: 'a'.repeat(64),
    contentCommitment: 'b'.repeat(64),
    previousReceipt: 'c'.repeat(64),
    receipt: String(seq).padStart(64, '0'),
  });

  it('reads under the caller’s organization and the RFQ, never a wider scope', async () => {
    const calls: [string, string][] = [];
    const service = new RfqEvidenceService({
      chainOf: async (organizationId: string, rfqId: string) => {
        calls.push([organizationId, rfqId]);
        return [];
      },
    } as unknown as RfqEvidenceRepository);

    const view = await runWithContext(context({}), () => service.chainOf('RFQ_1'));

    expect(calls).toEqual([['ORG_BUYER', 'RFQ_1']]);
    expect(view).toEqual({
      rfqId: 'RFQ_1',
      genesis: genesisReceipt('RFQ_1'),
      head: genesisReceipt('RFQ_1'),
      links: [],
    });
  });

  it('does not read at all for a caller it refuses', async () => {
    const chainOf = jest.fn();
    const service = new RfqEvidenceService({ chainOf } as unknown as RfqEvidenceRepository);

    await expect(
      runWithContext(context({ callerService: 'construction-service' }), () =>
        service.chainOf('RFQ_1'),
      ),
    ).rejects.toThrow(/reserved for procurement-service/);
    expect(chainOf).not.toHaveBeenCalled();
  });

  it('answers the newest receipt as the head, in order', async () => {
    const service = new RfqEvidenceService({
      chainOf: async () => [link(1), link(2)],
    } as unknown as RfqEvidenceRepository);

    const view = await runWithContext(context({}), () => service.chainOf('RFQ_1'));

    expect(view.head).toBe(link(2).receipt);
    expect(view.links.map((l) => l.seq)).toEqual([1, 2]);
    expect(view.links[0]!.receivedAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('refuses a chain longer than it will return, rather than cutting it to a wrong head', async () => {
    const service = new RfqEvidenceService({
      chainOf: async () => Array.from({ length: MAX_CHAIN_LINKS + 1 }, (_, i) => link(i + 1)),
    } as unknown as RfqEvidenceRepository);

    await expect(runWithContext(context({}), () => service.chainOf('RFQ_1'))).rejects.toThrow(
      /longer than this service will return/,
    );
  });
});
