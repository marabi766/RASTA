import { decodeAuditCursor, encodeAuditCursor, InvalidCursorError } from './audit.cursor';

/**
 * Cursor integrity.
 *
 * Two properties are asserted, and only one of them is about round-tripping.
 * The other is the security one: whatever a client puts in a cursor, the value
 * that comes back out is a **position and nothing else**, so there is no field
 * a forged cursor could use to reach another tenant's rows.
 */

const POSITION = { occurredAt: new Date('2026-09-01T10:00:00.000Z'), id: '01JABCDEF0123456789XYZ' };

describe('encode/decode', () => {
  it('round-trips a position exactly', () => {
    const decoded = decodeAuditCursor(encodeAuditCursor(POSITION));
    expect(decoded.id).toBe(POSITION.id);
    expect(decoded.occurredAt.toISOString()).toBe(POSITION.occurredAt.toISOString());
  });

  it('produces an opaque value that is not the raw timestamp', () => {
    // Opaque so that clients page by echoing the value back rather than by
    // constructing one, which is what lets the ordering gain a field in AUD-003
    // without breaking a client that never knew what was inside.
    const encoded = encodeAuditCursor(POSITION);
    expect(encoded).not.toContain('2026-09-01');
    expect(encoded).not.toContain(POSITION.id);
  });

  it('is url-safe, so it survives being a query parameter', () => {
    expect(encodeAuditCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('a cursor carries a position and no scope', () => {
  it('exposes exactly two fields', () => {
    // The property that makes a forged cursor harmless: there is no
    // organization, role or filter inside one, so a cursor lifted from another
    // tenant's response can only move this caller's position within their own
    // already-scoped result set.
    expect(Object.keys(decodeAuditCursor(encodeAuditCursor(POSITION))).sort()).toEqual([
      'id',
      'occurredAt',
    ]);
  });

  it('refuses a cursor that tries to smuggle an organization in', () => {
    const forged = Buffer.from(
      JSON.stringify({ o: POSITION.occurredAt.toISOString(), i: POSITION.id, org: 'ORG-OTHER' }),
      'utf8',
    ).toString('base64url');

    // `.strict()` on the payload: an unknown field is refused rather than
    // ignored, so a forged cursor fails loudly instead of being half-honoured.
    expect(() => decodeAuditCursor(forged)).toThrow(InvalidCursorError);
  });
});

describe('every malformed cursor fails the same way', () => {
  const forge = (payload: unknown): string =>
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  it.each([
    ['not base64 at all', '!!!not-base64!!!'],
    ['base64 of something that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['an array instead of an object', forge([1, 2, 3])],
    ['a missing id', forge({ o: '2026-09-01T10:00:00.000Z' })],
    ['a missing timestamp', forge({ i: 'ABC' })],
    ['a timestamp with no offset', forge({ o: '2026-09-01T10:00:00', i: 'ABC' })],
    ['a timestamp that is not a date', forge({ o: 'yesterday', i: 'ABC' })],
    ['an empty id', forge({ o: '2026-09-01T10:00:00.000Z', i: '' })],
    [
      'an id outside the identifier alphabet',
      forge({ o: '2026-09-01T10:00:00.000Z', i: "a' OR 1=1" }),
    ],
    ['an id longer than the column', forge({ o: '2026-09-01T10:00:00.000Z', i: 'A'.repeat(65) })],
    ['a numeric id', forge({ o: '2026-09-01T10:00:00.000Z', i: 42 })],
  ])('refuses %s', (_label, raw) => {
    expect(() => decodeAuditCursor(raw)).toThrow(InvalidCursorError);
  });

  it('says nothing about which layer rejected it', () => {
    // "Not valid base64", "unknown field" and "bad date" would each tell
    // somebody probing the parameter how far in they reached.
    const messages = ['!!!', forge({ i: 'ABC' }), forge({ o: 'x', i: 'ABC' })].map((raw) => {
      try {
        decodeAuditCursor(raw);
        return 'NO_ERROR';
      } catch (error) {
        return (error as Error).message;
      }
    });

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('The cursor is not valid');
  });
});
