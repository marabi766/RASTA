import { buildObjectKey, isWellFormedKey, keyBelongsTo, KEY_ROOT } from './object-key';

/**
 * Object keys, which are the path-traversal defence ADR-014 specifies.
 *
 * The defence is structural rather than filtering: nothing a client sends
 * contributes to the key, so there is no user input in the path to sanitise.
 * These tests exist to keep it that way — the failure mode is somebody later
 * "improving" key generation to include the filename.
 */

describe('generating a key', () => {
  it('contains nothing a client supplied', () => {
    const key = buildObjectKey('ORG-A', 'CONTRACT');

    // A filename never reaches this function; the assertion is that the shape
    // has no slot one could occupy.
    expect(key.split('/')).toHaveLength(4);
    expect(key.startsWith(`${KEY_ROOT}/ORG-A/CONTRACT/`)).toBe(true);
  });

  it('is unique per call', () => {
    const keys = new Set(
      Array.from({ length: 200 }, () => buildObjectKey('ORG-A', 'DAMAGE_PHOTO')),
    );
    // A collision would mean one upload overwriting another's object.
    expect(keys.size).toBe(200);
  });

  it('sorts in time order across milliseconds', async () => {
    // The ULID property that makes a bucket listing chronological without an
    // index. Deliberately asserted across a millisecond boundary rather than
    // back-to-back: within one millisecond the suffix is random and the order
    // among those keys is arbitrary. Asserting otherwise would be asserting
    // something ULID does not promise, and the test would fail intermittently.
    const first = buildObjectKey('ORG-A', 'CONTRACT');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = buildObjectKey('ORG-A', 'CONTRACT');

    expect([second, first].sort()).toEqual([first, second]);
  });

  it('is unguessable, so a key alone is not a capability', () => {
    // The random suffix matters as much as the ordering: an object key that
    // could be derived from an organization id and a timestamp would let
    // anyone holding bucket credentials enumerate documents.
    const suffixes = Array.from(
      { length: 50 },
      () => buildObjectKey('ORG-A', 'CONTRACT').split('/')[3],
    );
    expect(new Set(suffixes).size).toBe(50);
    for (const suffix of suffixes) expect(suffix).toHaveLength(26);
  });
});

describe('deciding whether a key belongs to an organization', () => {
  it('accepts the organization it was minted for', () => {
    expect(keyBelongsTo(buildObjectKey('ORG-A', 'CONTRACT'), 'ORG-A')).toBe(true);
  });

  it('refuses another organization', () => {
    expect(keyBelongsTo(buildObjectKey('ORG-A', 'CONTRACT'), 'ORG-B')).toBe(false);
  });

  it('does not let a prefix pass for the whole segment', () => {
    // The bug a `startsWith` check would have: `ORG-A` matching a key owned by
    // `ORG-ABC`, which is a cross-tenant read that looks like a match.
    const key = buildObjectKey('ORG-ABC', 'CONTRACT');
    expect(keyBelongsTo(key, 'ORG-A')).toBe(false);
    expect(keyBelongsTo(key, 'ORG-ABC')).toBe(true);
  });
});

describe('recognising a key this service could have issued', () => {
  it('accepts one it generated', () => {
    expect(isWellFormedKey(buildObjectKey('ORG-A', 'STATEMENT'))).toBe(true);
  });

  it('refuses traversal in any position', () => {
    for (const key of [
      'documents/ORG-A/CONTRACT/../../etc/passwd',
      'documents/../ORG-B/CONTRACT/01H',
      '../documents/ORG-A/CONTRACT/01H',
      'documents/ORG-A/../CONTRACT/01H',
    ]) {
      expect(isWellFormedKey(key)).toBe(false);
    }
  });

  it('refuses an absolute path or a Windows separator', () => {
    expect(isWellFormedKey('/documents/ORG-A/CONTRACT/01H')).toBe(false);
    expect(isWellFormedKey('documents\\ORG-A\\CONTRACT\\01H')).toBe(false);
  });

  it('refuses a key under a different root', () => {
    // Somebody pointing this service at another bucket prefix — backups, say —
    // by naming a key outside the one namespace it owns.
    expect(isWellFormedKey('backups/ORG-A/CONTRACT/01H')).toBe(false);
  });

  it('refuses empty segments and the wrong shape', () => {
    expect(isWellFormedKey('documents//CONTRACT/01H')).toBe(false);
    expect(isWellFormedKey('documents/ORG-A/CONTRACT')).toBe(false);
    expect(isWellFormedKey('documents/ORG-A/CONTRACT/01H/extra')).toBe(false);
    expect(isWellFormedKey('')).toBe(false);
    expect(isWellFormedKey('documents/ORG-A/CONTRACT/')).toBe(false);
  });

  it('refuses an absurdly long key', () => {
    expect(isWellFormedKey(`documents/ORG-A/CONTRACT/${'x'.repeat(600)}`)).toBe(false);
  });
});
