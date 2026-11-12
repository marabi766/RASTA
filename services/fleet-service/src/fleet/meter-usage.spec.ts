import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { listMeterUsageQuerySchema, listUsageQuerySchema, recordUsageSchema } from './dto';
import { FleetRepository } from './fleet.repository';
import { MeterUsageService } from './meter-usage';

const assetId = 'AST_01K00000000000000000000000';
const context: RequestContext = {
  correlationId: 'meter-test',
  requestId: 'meter-test',
  organizationId: 'ORG_TEST',
  organizationIds: [],
  roles: ['SERVICE'],
  authType: 'SERVICE',
  callerService: 'maintenance-service',
  startedAt: 0,
};
const row = {
  id: 'USG_first',
  organizationId: 'ORG_TEST',
  periodStart: new Date('2026-01-01T00:00:00.000Z'),
  periodEnd: new Date('2026-01-01T01:00:00.000Z'),
  hours: '1.00',
  kilometres: null,
  hourMeter: '9999999999.99',
  odometer: null,
};

describe('meter usage boundary and cursor', () => {
  const listMeterUsage = jest.fn(async () => [row, { ...row, id: 'USG_second' }]);
  const hasMeterUsageCursor = jest.fn(async () => true);
  const service = new MeterUsageService({
    listMeterUsage,
    hasMeterUsageCursor,
  } as unknown as FleetRepository);
  const read = (cursor?: string, overrides: Partial<RequestContext> = {}, asset = assetId) =>
    runWithContext({ ...context, ...overrides }, () =>
      service.list({ assetId: asset, limit: 1, ...(cursor === undefined ? {} : { cursor }) }),
    );

  it('bounds page sizes and rejects unknown, repeated, empty or missing fields', () => {
    for (const query of [
      {},
      { assetId, limit: 0 },
      { assetId, limit: 201 },
      { assetId, limit: 1.5 },
      { assetId, cursor: '' },
      { assetId, extra: 'x' },
      { assetId: [assetId] },
    ]) {
      expect(listMeterUsageQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(listMeterUsageQuerySchema.parse({ assetId }).limit).toBe(25);
  });

  it.each([
    { authType: 'USER' as const, callerService: undefined },
    { callerService: 'economic-service' },
    { callerService: undefined },
  ])('refuses unauthorized context before SQL: %j', async (overrides) => {
    await expect(read(undefined, overrides)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listMeterUsage).not.toHaveBeenCalled();
  });

  it('refuses to emit a cursor it cannot decode', async () => {
    listMeterUsage.mockResolvedValueOnce([{ ...row, id: 'invalid/id' }, row]);
    await expect(read()).rejects.toBeDefined();
  });

  it('validates an asset-bound cursor and resumes at the exact tuple', async () => {
    const first = await read();
    expect(first).toMatchObject({
      hasMore: true,
      items: [expect.objectContaining({ hours: '1.00' })],
    });
    await read(first.nextCursor!);
    expect(listMeterUsage).toHaveBeenLastCalledWith(assetId, 1, { end: row.periodEnd, id: row.id });
    listMeterUsage.mockClear();
    await expect(
      read(first.nextCursor!, {}, 'AST_01K00000000000000000000001'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(listMeterUsage).not.toHaveBeenCalled();
  });

  it('refuses malformed, oversized and noncanonical cursors before SQL', async () => {
    for (const bad of [
      '',
      'garbage',
      'a'.repeat(513),
      'bad.cursor',
      'abcd=',
      Buffer.from(JSON.stringify([assetId, 'not-a-date', row.id])).toString('base64url'),
    ]) {
      await expect(read(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(hasMeterUsageCursor).not.toHaveBeenCalled();
    expect(listMeterUsage).not.toHaveBeenCalled();
  });

  it('refuses a structurally valid cursor whose tuple is not a real row before scanning', async () => {
    hasMeterUsageCursor.mockResolvedValueOnce(false);
    const changed = Buffer.from(
      JSON.stringify([assetId, row.periodEnd.toISOString(), 'USG_changed']),
    ).toString('base64url');
    await expect(read(changed)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(hasMeterUsageCursor).toHaveBeenCalledWith(assetId, {
      end: row.periodEnd,
      id: 'USG_changed',
    });
    expect(listMeterUsage).not.toHaveBeenCalled();
  });
});

describe('exact reference query validation', () => {
  it.each(['abcdefgh', 'a'.repeat(128), '  exact reference  ', 'éééééééé'])(
    'matches write validation without rewriting %j',
    (reference) => {
      expect(listUsageQuerySchema.parse({ clientReference: reference }).clientReference).toBe(
        recordUsageSchema.shape.clientReference.parse(reference),
      );
    },
  );
  it.each(['short', 'x'.repeat(129), '', 'bad\u202Ereference', ['abcdefgh']])(
    'refuses invalid reference %j on both entry points',
    (reference) => {
      expect(listUsageQuerySchema.safeParse({ clientReference: reference }).success).toBe(false);
      expect(recordUsageSchema.shape.clientReference.safeParse(reference).success).toBe(false);
    },
  );
});
