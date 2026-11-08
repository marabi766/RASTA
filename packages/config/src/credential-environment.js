// @ts-check
'use strict';
// -----------------------------------------------------------------------------
// The one check every credential transport runs before it sends (FU-249):
// internalFetch (@rasta/nest-common), the portal's credentialFetch and
// putToSignedUrl, and the root scripts' credentialFetch.
//
// Node's fetch builds its option objects inside Node, and they inherit from
// `Object.prototype` even when the caller's init has no prototype. A key set
// there is read by every credentialed request: an inherited `dispatcher`
// receives the request, bearer header included; an inherited `body` is sent as
// the body of a request that had none. Fetch also sends through the dispatcher
// in Node's global slot, so a replaced one receives every request too.
//
// Plain CommonJS, like url-reader.js: the scripts import this file itself, and
// TypeScript consumers import it through `@rasta/config`.
// -----------------------------------------------------------------------------

/** The own keys of `Object.prototype` in ECMAScript, Annex B included. */
const STANDARD_OBJECT_KEYS = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** Where Node's fetch finds its default dispatcher (undici's global slot). */
const DISPATCHER_SLOT = Symbol.for('undici.globalDispatcher.1');
// Constructing a request installs Node's default dispatcher if there is none
// yet, with no I/O, so the one captured is the one in force at load.
if (typeof Request === 'function') new Request('http://127.0.0.1/');
/** The global dispatcher slot as it is now: its value, or an accessor someone put there. */
function dispatcherInForce() {
  return Object.getOwnPropertyDescriptor(globalThis, DISPATCHER_SLOT);
}
const DISPATCHER_AT_LOAD = dispatcherInForce();

/**
 * What a credential transport throws, before anything is sent, when the
 * runtime it would send through is not the one it loaded with. Names no key,
 * URL or credential.
 */
class CredentialEnvironmentRefusedError extends Error {
  /** @param {'prototype' | 'dispatcher'} reason what was altered */
  constructor(reason) {
    super('Credential send refused: the runtime environment was altered');
    this.name = 'CredentialEnvironmentRefusedError';
    /** @readonly */
    this.reason = reason;
  }
}

/**
 * The refusals {@link refuseAlteredEnvironment} threw, each before its
 * transport sent anything. Weak, module-private: nothing else can add one.
 * @type {WeakSet<object>}
 */
const refusedBeforeSend = new WeakSet();

/**
 * Whether `error` is a refusal this check threw before its transport sent
 * anything: the one transport failure whose outcome is known, nothing was
 * sent (checklist A1). False for anything else, including a refusal that
 * escaped from inside a transport after its own request may have left
 * ({@link disownRefusal}), so a caller that cannot tell reads it as unknown.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function refusedBeforeSending(error) {
  return typeof error === 'object' && error !== null && refusedBeforeSend.has(error);
}

/**
 * What a transport rethrows for anything its `fetchImpl` threw: the same
 * value, no longer {@link refusedBeforeSending} — a refusal of some nested
 * send says nothing about whether this transport's request left.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function disownRefusal(error) {
  if (typeof error === 'object' && error !== null) refusedBeforeSend.delete(error);
  return error;
}

/**
 * The `Object.prototype` of the realm `transport` was created in: this
 * module's own in production, the host's when a test runner sandboxes the
 * module but hands it the host's fetch. `null` when it cannot be told.
 *
 * @param {unknown} transport
 * @returns {unknown}
 */
function realmObjectPrototype(transport) {
  try {
    /** @type {unknown} */
    let object = Object.getPrototypeOf(transport);
    for (let depth = 0; depth < 32; depth += 1) {
      const next = Object.getPrototypeOf(object);
      if (next === null) return object;
      object = next;
    }
  } catch {
    // A revoked proxy, or a chain that is not an object's: refused below.
  }
  return null;
}

/**
 * Throws {@link CredentialEnvironmentRefusedError} unless a credential may be
 * sent through `transport` now: Node's global dispatcher is the one present at
 * load, and `Object.prototype` — this realm's and the one `transport` comes
 * from — has only its ECMAScript keys. A key scan and two identity checks: no
 * I/O, nothing read from the request. What it throws is
 * {@link refusedBeforeSending}.
 *
 * @param {unknown} transport the fetch the caller is about to send through
 * @returns {void}
 */
function refuseAlteredEnvironment(transport) {
  try {
    checkEnvironment(transport);
  } catch (error) {
    // Whatever the check throws, it threw before anything was sent.
    if (typeof error === 'object' && error !== null) refusedBeforeSend.add(error);
    throw error;
  }
}

/** @param {unknown} transport */
function checkEnvironment(transport) {
  const dispatcher = dispatcherInForce();
  if (
    dispatcher?.value !== DISPATCHER_AT_LOAD?.value ||
    dispatcher?.get !== DISPATCHER_AT_LOAD?.get
  ) {
    throw new CredentialEnvironmentRefusedError('dispatcher');
  }
  for (const prototype of [Object.prototype, realmObjectPrototype(transport)]) {
    if (typeof prototype !== 'object' || prototype === null) {
      throw new CredentialEnvironmentRefusedError('prototype');
    }
    const keys = [
      ...Object.getOwnPropertyNames(prototype),
      ...Object.getOwnPropertySymbols(prototype),
    ];
    if (keys.some((key) => typeof key !== 'string' || !STANDARD_OBJECT_KEYS.has(key))) {
      throw new CredentialEnvironmentRefusedError('prototype');
    }
  }
}

exports.CredentialEnvironmentRefusedError = CredentialEnvironmentRefusedError;
exports.disownRefusal = disownRefusal;
exports.refuseAlteredEnvironment = refuseAlteredEnvironment;
exports.refusedBeforeSending = refusedBeforeSending;
