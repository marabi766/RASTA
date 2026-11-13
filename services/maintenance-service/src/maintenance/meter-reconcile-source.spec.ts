import { createHash } from 'node:crypto';
import { canonicalMeterCertificate } from '@rasta/contracts';
import { MeterUsageClient } from './meter-reconcile';

const row = {
  id: 'USG_A',
  organizationId: 'ORG_A',
  periodStart: '2026-11-01T10:00:00Z',
  periodEnd: '2026-11-01T11:00:00Z',
  hours: '2',
  kilometres: null,
  hourMeter: null,
  odometer: null,
};
function client(body: unknown, status = 200) {
  const issue = jest.fn(async () => 'internal-test-token');
  const fetch = jest.fn(
    async (_input: string | URL | Request) => new Response(JSON.stringify(body), { status }),
  );
  return {
    client: new MeterUsageClient({
      baseUrl: 'http://fleet-service.test',
      timeoutMs: 1000,
      tokens: { issue },
      fetch,
    }),
    issue,
    fetch,
  };
}
describe('fleet meter read boundary', () => {
  it('uses the internal meter projection with tenant-bound service identity and forwards the continuation', async () => {
    const c = client({ items: [row], nextCursor: null, hasMore: false });
    expect((await c.client.page('ORG_A', 'AST_A', 'next')).items).toEqual([row]);
    expect(c.fetch.mock.calls[0][0].toString()).toContain(
      '/v1/internal/usage-records?assetId=AST_A&limit=200&cursor=next',
    );
    expect(c.issue).toHaveBeenCalledWith(
      'maintenance-service',
      'fleet-service',
      'SERVICE',
      'ORG_A',
    );
  });
  it.each([
    { ...row, hours: '-2' },
    { ...row, hours: '1e3' },
    { ...row, hours: ' 5' },
    { ...row, hours: '5.' },
    { ...row, hours: '100000000' },
    { ...row, periodEnd: row.periodStart },
    { ...row, periodStart: undefined },
    { ...row, privateNotes: 'not in meter projection' },
  ])('refuses malformed or over-broad source fact %#', async (item) => {
    await expect(
      client({ items: [item], hasMore: false, nextCursor: null }).client.page('ORG_A', 'AST_A'),
    ).rejects.toThrow();
  });
  it('validates certificate asset, digest, uniqueness and canonical decimal/UTC facts', async () => {
    const body = { version: 1 as const, assetId: 'AST_A', snapshot: '1:2:', facts: [row] };
    const digest = createHash('sha256').update(canonicalMeterCertificate(body)).digest('hex');
    const c = { ...body, digest };
    expect(await client(c).client.certificate('ORG_A', 'AST_A')).toEqual(c);
    expect(
      (
        await client({
          ...c,
          facts: [{ ...row, hours: '02.00', periodEnd: '2026-11-01T12:00:00+01:00' }],
        }).client.certificate('ORG_A', 'AST_A')
      ).digest,
    ).toBe(digest);
    for (const bad of [
      { ...c, assetId: 'AST_B' },
      { ...c, digest: '0'.repeat(64) },
      { ...c, facts: [row, row] },
      { ...c, facts: [{ ...row, hours: '3' }] },
      { ...c, facts: [{ ...row, periodStart: null }] },
    ]) {
      await expect(client(bad).client.certificate('ORG_A', 'AST_A')).rejects.toThrow();
    }
    await expect(client({}, 503).client.certificate('ORG_A', 'AST_A')).rejects.toThrow(
      'SOURCE_READ_FAILED',
    );
  });
  it.each([
    { id: 'USG_OTHER' },
    { organizationId: 'ORG_B' },
    { hours: '3' },
    { kilometres: '1' },
    { hourMeter: '0' },
    { odometer: '0' },
    { periodStart: '2026-11-01T09:00:00Z' },
    { periodEnd: '2026-11-01T12:00:00Z' },
  ])('binds every canonical physical fact field %#', async (change) => {
    const body = { version: 1 as const, assetId: 'AST_A', snapshot: '1:2:', facts: [row] };
    const digest = createHash('sha256').update(canonicalMeterCertificate(body)).digest('hex');
    await expect(
      client({ ...body, digest, facts: [{ ...row, ...change }] }).client.certificate(
        'ORG_A',
        'AST_A',
      ),
    ).rejects.toThrow();
  });
  it('accepts a bounded manifest larger than the ordinary one-MiB page ceiling', async () => {
    const body = {
      version: 1 as const,
      assetId: 'AST_A',
      snapshot: '1:2:',
      facts: Array.from({ length: 6000 }, (_, i) => ({ ...row, id: `USG_${i}` })),
    };
    const c = {
      ...body,
      digest: createHash('sha256').update(canonicalMeterCertificate(body)).digest('hex'),
    };
    expect(Buffer.byteLength(JSON.stringify(c))).toBeGreaterThan(1024 * 1024);
    expect((await client(c).client.certificate('ORG_A', 'AST_A')).facts).toHaveLength(6000);
  });
  it('treats an upstream refusal as unknown, not an empty page', async () => {
    await expect(client({ code: 'NOT_FOUND' }, 404).client.page('ORG_A', 'AST_A')).rejects.toThrow(
      'SOURCE_READ_FAILED',
    );
  });
});
