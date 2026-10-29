import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  ISO_INSTANT_SHAPE,
  arrayOf,
  envelopeShape,
  expectStoredMessageWithout,
  optional,
  storedMessageProblems,
} from './stored-message';

const clean = {
  eventId: '01J0000000000000000000000A',
  tenantId: 'org-1',
  occurredAt: '2026-10-29T10:20:50.001Z',
  payload: { scheduleId: 'SCH-1', changedFields: ['intervalHours'], itemVersion: 3 },
};

const cleanShape = {
  eventId: 'string',
  tenantId: 'string',
  occurredAt: 'instant',
  payload: { scheduleId: 'string', changedFields: arrayOf('string'), itemVersion: 'number' },
} as const;

describe('storedMessageProblems', () => {
  it('passes a clean message, including a field that legitimately names a field', () => {
    expect(
      storedMessageProblems(clean, { anywhere: ['500.00'], inKeys: ['intervalHours'] }),
    ).toEqual([]);
  });

  it('does not search an instant where the shape designates one, where a short number occurs by chance', () => {
    expect(storedMessageProblems(clean, { anywhere: ['50.00'], shape: cleanShape })).toEqual([]);
  });

  it('searches a strict-looking instant anywhere else: no shape, or a field the shape calls a string', () => {
    expect(storedMessageProblems(clean, { anywhere: ['50.00'] })).toHaveLength(1);
    const elsewhere = { ...clean, payload: { ...clean.payload, note: clean.occurredAt } };
    const shape = { ...cleanShape, payload: { ...cleanShape.payload, note: 'string' as const } };
    expect(storedMessageProblems(elsewhere, { anywhere: ['50.00'], shape })).toHaveLength(1);
    // And a designated field must hold an instant: anything else is a problem, not an exemption.
    const bad = { ...clean, occurredAt: `${clean.occurredAt} intervalHours=500.00` };
    expect(storedMessageProblems(bad, { anywhere: ['500.00'], shape: cleanShape })).toHaveLength(2);
  });

  it('finds a marker appended to an id, to an instant, and inside an array', () => {
    const appended = (path: 'scheduleId' | 'at' | 'list') => {
      const payload: Record<string, unknown> = {
        scheduleId: 'SCH-1',
        at: clean.occurredAt,
        list: ['a'],
      };
      payload[path] =
        path === 'list'
          ? ['a', 'x intervalHours=500.00']
          : `${String(payload[path])} intervalHours=500.00`;
      return storedMessageProblems({ ...clean, payload }, { anywhere: ['500.00'] });
    };
    expect(appended('scheduleId')).toHaveLength(1);
    expect(appended('at')).toHaveLength(1);
    expect(appended('list')).toHaveLength(1);
  });

  it('finds a marker carried as a property name, at any depth', () => {
    const top = { ...clean, 'Very identifiable name': true };
    const deep = {
      ...clean,
      payload: { ...clean.payload, nested: { 'a very identifiable name': 1 } },
    };
    expect(storedMessageProblems(top, { anywhere: ['Very identifiable name'] })).toHaveLength(1);
    expect(storedMessageProblems(deep, { anywhere: ['Very identifiable name'] })).toHaveLength(1);
  });

  it('finds a number leaf, and a key-only marker only in keys', () => {
    expect(storedMessageProblems({ x: 35.689197 }, { anywhere: ['35.689197'] })).toHaveLength(1);
    expect(
      storedMessageProblems({ intervalHours: '1' }, { inKeys: ['intervalHours'] }),
    ).toHaveLength(1);
  });

  it('refuses a key outside the allowed top-level set', () => {
    const rules = { anywhere: ['zzz'], topLevelKeys: Object.keys(clean) };
    expect(storedMessageProblems(clean, rules)).toEqual([]);
    expect(storedMessageProblems({ ...clean, extra: 1 }, rules)).toEqual(['top-level key "extra"']);
  });

  it('fails closed: no markers, not an object, nothing to walk', () => {
    expect(storedMessageProblems(clean, {})).toContain('no markers to look for');
    expect(storedMessageProblems('text', { anywhere: ['x'] })).toContain(
      'the stored message is not an object',
    );
    expect(storedMessageProblems({}, { anywhere: ['x'] })).toContain(
      'the stored message has no leaves',
    );
  });

  it('throws one error from expectStoredMessageWithout', () => {
    expect(() => expectStoredMessageWithout({ a: 'secret' }, { anywhere: ['secret'] })).toThrow(
      /value "secret" at \$\.a/,
    );
  });

  it('knows the strict instant shape', () => {
    expect(ISO_INSTANT_SHAPE.test('2026-10-29T10:20:50Z')).toBe(true);
    expect(ISO_INSTANT_SHAPE.test('2026-10-29T10:20:50.001Z intervalHours=500.00')).toBe(false);
  });
});

describe('storedMessageProblems: the whole shape, at every depth', () => {
  const mutate = <T extends object>(base: T, change: (copy: any) => void): T => {
    const copy = structuredClone(base);
    change(copy);
    return copy;
  };
  const rules = { anywhere: ['zzz'], shape: cleanShape };

  it('passes the exact shape and names every departure from it', () => {
    expect(storedMessageProblems(clean, rules)).toEqual([]);
    expect(
      storedMessageProblems(
        mutate(clean, (m) => (m.payload.extra = 1)),
        rules,
      ),
    ).toEqual(['unknown key "extra" at $.payload']);
    expect(
      storedMessageProblems(
        mutate(clean, (m) => delete m.payload.scheduleId),
        rules,
      ),
    ).toEqual(['missing key "scheduleId" at $.payload']);
    expect(
      storedMessageProblems(
        mutate(clean, (m) => (m.payload.itemVersion = '3')),
        rules,
      ),
    ).toEqual(['value "3" at $.payload.itemVersion is not "number"']);
    expect(
      storedMessageProblems(
        mutate(clean, (m) => (m.payload = [])),
        rules,
      )[0],
    ).toBe('array at $.payload where the shape has none');
    expect(
      storedMessageProblems(
        mutate(clean, (m) => (m.eventId = {})),
        rules,
      )[0],
    ).toBe('object at $.eventId where the shape has none');
    expect(
      storedMessageProblems(
        mutate(clean, (m) => (m.payload.changedFields = [1])),
        rules,
      ),
    ).toEqual(['value 1 at $.payload.changedFields[0] is not "string"']);
  });

  it('lets an Optional key be absent, but not wrong', () => {
    const shape = { a: optional('string'), b: ['string', 'null'] } as const;
    const r = { anywhere: ['zzz'], shape };
    expect(storedMessageProblems({ b: null }, r)).toEqual([]);
    expect(storedMessageProblems({ a: 'x', b: 'y' }, r)).toEqual([]);
    expect(storedMessageProblems({ a: 5, b: 'y' }, r)).toHaveLength(1);
    expect(storedMessageProblems({ a: 'x' }, r)).toEqual(['missing key "b" at $']);
  });

  it('keeps envelopeShape in step with eventEnvelopeSchema, key for key', () => {
    expect(Object.keys(envelopeShape('string')).sort()).toEqual(
      Object.keys(eventEnvelopeSchema.shape).sort(),
    );
  });
});

describe('storedMessageProblems: envelope data nested under an allowed key (PR #486 r2 N1)', () => {
  const maintenance = {
    eventId: '01J0000000000000000000000A',
    eventName: 'MAINTENANCE_SCHEDULE_CHANGED',
    eventVersion: 1,
    occurredAt: '2026-10-29T10:20:50.001Z',
    producer: 'maintenance-service',
    producerVersion: '0.0.0',
    aggregateType: 'MaintenanceSchedule',
    aggregateId: 'AST-1',
    tenantId: 'org-1',
    correlationId: '01J0000000000000000000000A',
    actor: { type: 'USER', id: 'USR-1' },
    payload: { changedFields: ['intervalHours', 'leadHours'], changedAt: '2026-10-29T10:20:50Z' },
  };
  const maintenanceRules = {
    anywhere: ['500.00', '50.00'],
    numbers: ['500.00', '50.00'],
    inKeys: ['intervalHours', 'leadHours', 'lastServicedHourMeter'],
    shape: envelopeShape({ changedFields: arrayOf('string'), changedAt: 'instant' }),
  };
  const inventory = {
    ...maintenance,
    eventName: 'WAREHOUSE_CREATED',
    payload: { warehouseId: 'WH-1', createdAt: '2026-10-29T10:20:50.001Z' },
  };
  const inventoryRules = {
    anywhere: ['Very identifiable name', '35.689197', '51.388974'],
    numbers: [35.689197, 51.388974],
    near: { values: [35.689197, 51.388974], within: 0.5 },
    shape: envelopeShape({ warehouseId: 'string', createdAt: 'instant' }),
  };
  const mutate = (base: typeof maintenance, change: (copy: any) => void) => {
    const copy = structuredClone(base);
    change(copy);
    return copy;
  };

  it('accept the real shapes', () => {
    expect(storedMessageProblems(maintenance, maintenanceRules)).toEqual([]);
    expect(storedMessageProblems(inventory, inventoryRules)).toEqual([]);
  });

  it.each([
    ['maintenance actor.extra = 500', (m: any) => (m.actor.extra = 500)],
    ['maintenance actor.extra = "500"', (m: any) => (m.actor.extra = '500')],
    ['maintenance actor.extra = 50', (m: any) => (m.actor.extra = 50)],
    [
      'maintenance actor.interval = { Hours: 500 }',
      (m: any) => (m.actor.interval = { Hours: 500 }),
    ],
    [
      'actor.interval = { Hours: 7 } (no marker at all)',
      (m: any) => (m.actor.interval = { Hours: 7 }),
    ],
    ['actor.extra = [[ "x" ]]', (m: any) => (m.actor.extra = [['x']])],
    ['actor.type is an object', (m: any) => (m.actor.type = { Hours: 500 })],
    ['payload gains a nested key', (m: any) => (m.payload.note = { Hours: 7 })],
    ['payload gains a nested array', (m: any) => (m.payload.note = [[true]])],
    ['a new top-level metadata object', (m: any) => (m.metadata = { x: { y: 1 } })],
    ['an extra key beside changedFields', (m: any) => (m.payload['x intervalHours'] = true)],
  ])('refuse: %s', (_name, change) => {
    expect(
      storedMessageProblems(mutate(maintenance, change), maintenanceRules).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    [
      'inventory actor["Very identifiable"] = { name: true }',
      (m: any) => (m.actor['Very identifiable'] = { name: true }),
    ],
    ['a rounded coordinate string in nested arrays', (m: any) => (m.actor.x = [['35.69']])],
    [
      'a rounded coordinate string in nested arrays, in the payload',
      (m: any) => (m.payload.x = [['35.7']]),
    ],
    ['a rounded coordinate number in an unknown key', (m: any) => (m.actor.lat = 35.7)],
    ['a rounded coordinate as the id', (m: any) => (m.actor.id = '51.4')],
    ['the name carried in the actor id', (m: any) => (m.actor.id = 'USR-1 very identifiable NAME')],
  ])('refuse: %s', (_name, change) => {
    expect(
      storedMessageProblems(mutate(inventory as never, change), inventoryRules).length,
    ).toBeGreaterThan(0);
  });

  it('name a marker split across nested keys by the key that does not belong there', () => {
    const split = mutate(maintenance, (m) => (m.actor.interval = { Hours: 500 }));
    expect(storedMessageProblems(split, maintenanceRules)).toEqual(
      expect.arrayContaining(['unknown key "interval" at $.actor']),
    );
  });
});

describe('storedMessageProblems: numbers by exact decimal value', () => {
  const found = (leaf: unknown, marker: number | string = '500.00') =>
    storedMessageProblems({ x: leaf }, { numbers: [marker] }).length;

  it.each([
    500,
    '500',
    '500.00',
    '0500.000',
    '+500',
    '5e2',
    '5E+2',
    '50e1',
    '.5e3',
    5e2,
    'intervalHours=500',
    'interval 500.0 hours',
    '[500,501]',
    '(500)',
  ])('finds 500.00 written as %j', (leaf) => {
    expect(found(leaf)).toBe(1);
  });

  it.each([
    500.01,
    '500.01',
    '5000',
    '50',
    '-500',
    '5e3',
    '500x',
    'a500',
    'x-500.00-y',
    '1.500',
    '2026-10-29T10:20:50.500Z',
  ])('does not find 500.00 in %j', (leaf) => {
    expect(found(leaf)).toBe(0);
  });

  it('takes the marker as a value too, and finds it as a key', () => {
    expect(found('500.00', 500)).toBe(1);
    expect(found(35.689197, '35.689197')).toBe(1);
    expect(found('35.689197', 35.689197)).toBe(1);
    expect(storedMessageProblems({ '500': true }, { numbers: ['500.00'] })).toHaveLength(1);
  });

  it('compares exactly, with no floating point', () => {
    expect(found(0.1 + 0.2, 0.3)).toBe(0);
    expect(found('0.30000000000000004', '0.3')).toBe(0);
    expect(found('0.3', '0.30')).toBe(1);
    expect(found('1e-7', '0.0000001')).toBe(1);
    expect(found('123456789012345678901234567890', '1.2345678901234567890123456789e29')).toBe(1);
    expect(found('123456789012345678901234567891', '1.2345678901234567890123456789e29')).toBe(0);
    expect(found('0', '0.00')).toBe(1);
    expect(found('-0', '0')).toBe(1);
  });

  it('refuses a numeric marker that is no decimal, rather than matching nothing', () => {
    expect(storedMessageProblems({ x: 1 }, { numbers: ['abc'] })).toEqual([
      'numeric marker "abc" is no decimal',
    ]);
    expect(storedMessageProblems({ x: 1 }, { numbers: [Number.NaN] })).toHaveLength(1);
  });

  it('finds a number near a value, as a number or as text, and not one far away', () => {
    const near = { values: [35.689197], within: 0.5 };
    expect(storedMessageProblems({ x: 35.7 }, { near })).toHaveLength(1);
    expect(storedMessageProblems({ x: '35.7' }, { near })).toHaveLength(1);
    expect(storedMessageProblems({ x: 'lat=36.1' }, { near })).toHaveLength(1);
    expect(storedMessageProblems({ x: 36.5, y: '01J00AB', z: 3 }, { near })).toEqual([]);
  });
});
