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
  it('treats an upstream refusal as unknown, not an empty page', async () => {
    await expect(client({ code: 'NOT_FOUND' }, 404).client.page('ORG_A', 'AST_A')).rejects.toThrow(
      'SOURCE_READ_FAILED',
    );
  });
});
