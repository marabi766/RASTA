import {
  CredentialEnvironmentRefusedError,
  disownRefusal,
  refuseAlteredEnvironment,
  refusedBeforeSending,
} from './credential-environment';

/**
 * FU-249: the check every credential transport runs before it sends. The
 * transports' own probes (nest-common, apps/web, scripts) show the header is
 * never delivered; this pins each refusal of the check itself.
 */

/** A transport created in this (sandboxed) realm. */
const local: typeof fetch = async () => new Response(null);
/** `Object.prototype` of the realm Node's fetch was created in: jest's host. */
const HOST_OBJECT_PROTOTYPE = Object.getPrototypeOf(Object.getPrototypeOf(fetch)) as object;
const SLOT = Symbol.for('undici.globalDispatcher.1');

function withKey<T>(target: object, key: PropertyKey, run: () => T): T {
  // Defined like a polluting assignment would: enumerable, writable.
  Object.defineProperty(target, key, {
    value: {},
    enumerable: true,
    writable: true,
    configurable: true,
  });
  try {
    return run();
  } finally {
    delete (target as Record<PropertyKey, unknown>)[key];
  }
}

const reasonOf = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialEnvironmentRefusedError);
    expect((error as Error).message).toBe(
      'Credential send refused: the runtime environment was altered',
    );
    return (error as CredentialEnvironmentRefusedError).reason;
  }
  return 'sent';
};

describe('refuseAlteredEnvironment', () => {
  it('lets an unaltered runtime send, through the host fetch or a local double', () => {
    expect(reasonOf(() => refuseAlteredEnvironment(fetch))).toBe('sent');
    expect(reasonOf(() => refuseAlteredEnvironment(local))).toBe('sent');
  });

  it.each(['dispatcher', 'body', 'window', Symbol.iterator, Symbol('x')])(
    'refuses a %p on this realm’s Object.prototype',
    (key) => {
      expect(
        withKey(Object.prototype, key, () => reasonOf(() => refuseAlteredEnvironment(local))),
      ).toBe('prototype');
    },
  );

  it('refuses a key on the Object.prototype of the realm the transport comes from', () => {
    // This realm stays clean: only the host's — the one Node's fetch reads — is polluted.
    expect(Object.prototype).not.toBe(HOST_OBJECT_PROTOTYPE);
    expect(
      withKey(HOST_OBJECT_PROTOTYPE, 'dispatcher', () =>
        reasonOf(() => refuseAlteredEnvironment(fetch)),
      ),
    ).toBe('prototype');
  });

  it('refuses a transport whose realm cannot be told', () => {
    const { proxy, revoke } = Proxy.revocable(local, {});
    revoke();
    expect(reasonOf(() => refuseAlteredEnvironment(proxy))).toBe('prototype');
    expect(reasonOf(() => refuseAlteredEnvironment(Object.setPrototypeOf(() => 1, null)))).toBe(
      'prototype',
    );
  });

  it.each([
    ['replaced', { value: { dispatch: () => true }, writable: true }],
    ['an accessor', { get: () => undefined }],
  ])('refuses a global dispatcher that is not the one at load (%s)', (_name, descriptor) => {
    const before = Object.getOwnPropertyDescriptor(globalThis, SLOT);
    Object.defineProperty(globalThis, SLOT, { ...descriptor, configurable: true });
    try {
      expect(reasonOf(() => refuseAlteredEnvironment(local))).toBe('dispatcher');
    } finally {
      if (before) Object.defineProperty(globalThis, SLOT, before);
      else delete (globalThis as Record<symbol, unknown>)[SLOT];
    }
    expect(reasonOf(() => refuseAlteredEnvironment(local))).toBe('sent');
  });
});

describe('refusedBeforeSending (#967 r1: a refused send is never an unknown outcome)', () => {
  /** What the check threw while this realm's Object.prototype carried a stray key. */
  const thrown = (): unknown => {
    try {
      withKey(Object.prototype, 'fu249Probe', () => refuseAlteredEnvironment(local));
    } catch (error) {
      return error;
    }
    throw new Error('not refused');
  };

  it('is true only for what the check itself threw', () => {
    expect(refusedBeforeSending(thrown())).toBe(true);
    expect(refusedBeforeSending(new CredentialEnvironmentRefusedError('prototype'))).toBe(false);
    for (const value of [undefined, null, 'prototype', 0, {}])
      expect(refusedBeforeSending(value)).toBe(false);
  });

  it('is false once a transport disowned it, which hands back the same value', () => {
    const refusal = thrown();
    expect(disownRefusal(refusal)).toBe(refusal);
    expect(refusedBeforeSending(refusal)).toBe(false);
    for (const value of [undefined, null, 'x', 1]) expect(disownRefusal(value)).toBe(value);
  });
});
