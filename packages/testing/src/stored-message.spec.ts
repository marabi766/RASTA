import {
  ISO_INSTANT_SHAPE,
  expectStoredMessageWithout,
  storedMessageProblems,
} from './stored-message';

const clean = {
  eventId: '01J0000000000000000000000A',
  tenantId: 'org-1',
  occurredAt: '2026-10-29T10:20:50.001Z',
  payload: { scheduleId: 'SCH-1', changedFields: ['intervalHours'], itemVersion: 3 },
};

describe('storedMessageProblems', () => {
  it('passes a clean message, including a field that legitimately names a field', () => {
    expect(
      storedMessageProblems(clean, { anywhere: ['500.00'], inKeys: ['intervalHours'] }),
    ).toEqual([]);
  });

  it('does not search a strict instant, where a short number occurs by chance', () => {
    expect(storedMessageProblems(clean, { anywhere: ['50.00'] })).toEqual([]);
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
