import { decodeCursor, encodeCursor, InvalidCursorError } from './notification.cursor';

describe('the notification page cursor', () => {
  const position = { createdAt: new Date('2026-09-17T10:00:00.123Z'), id: 'NTN_01J' };

  it('round-trips a position and is opaque', () => {
    const encoded = encodeCursor(position);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('NTN_01J');
    expect(decodeCursor(encoded)).toEqual(position);
  });

  it('carries no scope: only a time and an id are inside', () => {
    const decoded = JSON.parse(Buffer.from(encodeCursor(position), 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['c', 'i']);
  });

  it.each([
    ['not base64 at all', '!!!'],
    ['base64 of non-JSON', Buffer.from('hello').toString('base64url')],
    [
      'an unknown field',
      Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00Z', i: 'x', org: 'ORG_B' })).toString(
        'base64url',
      ),
    ],
    [
      'a missing id',
      Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00Z' })).toString('base64url'),
    ],
    ['a bad date', Buffer.from(JSON.stringify({ c: 'yesterday', i: 'x' })).toString('base64url')],
    [
      'an id outside the alphabet',
      Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00Z', i: "x' OR 1=1" })).toString(
        'base64url',
      ),
    ],
    [
      'an oversized id',
      Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00Z', i: 'x'.repeat(65) })).toString(
        'base64url',
      ),
    ],
    ['an empty string', ''],
  ])('refuses %s with one undetailed error', (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(raw)).toThrow('The cursor is not valid');
  });
});
