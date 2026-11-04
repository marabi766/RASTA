// @ts-check
'use strict';
/** Foreign diagnostics are data, including names/codes. Only registered codes may leave a client. */
const CLIENT_CODES = new Set([
  'ENOENT',
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ABORT_ERR',
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1008',
  'P1009',
  'P1010',
  'P1011',
  'P1012',
  'P1013',
  'P1014',
  'P1015',
  'P1016',
  'P1017',
  'P2024',
  'P2037',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'NoSuchBucket',
  'NoSuchKey',
  'NotFound',
  'PreconditionFailed',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
]);

/** @param {unknown} error @returns {string} */
function clientFailureCode(error) {
  try {
    const failure = /** @type {{ errorCode?: unknown; code?: unknown; name?: unknown } | null} */ (
      error
    );
    for (const code of [failure?.errorCode, failure?.code, failure?.name]) {
      if (typeof code === 'string' && CLIENT_CODES.has(code)) return code;
    }
  } catch {
    // A foreign getter is no more trusted than a foreign message.
  }
  return 'unknown';
}

/**
 * The closed set of refusals this repository raises itself, before or during a
 * command (FU-023). Each names one guard, so an operator — and a test — can
 * tell which one refused without the guard's text: that text may embed a
 * service, a variable or a count, and stays withheld like any other message.
 * Documented in docs/runbooks/outbox-b2-backfill.md § refusal codes.
 */
const REFUSAL_CODES = new Set([
  'usage',
  'node-env',
  'owner-credential',
  'configuration',
  'database-url-unset',
  'runtime-role',
  'runtime-role-unverified',
  'prisma-client-missing',
  'b1-precondition',
  'history-purged',
  'ordering-violation',
  'no-progress',
  'verification-mismatch',
  'no-outbox-table',
  'not-table-owner',
  'vacuum-unproven',
  'lag-unreadable',
]);

// One registry per process (held on `process`), shared by every copy of this module (scripts load
// the source; services and scripts that require @rasta/config load dist/). The
// mark is held outside the error: no property, getter, prototype or subclass of
// a foreign error can claim a code, and an unmarked error stays `unknown`.
const REGISTRY = Symbol.for('rasta.command-failure.refusals');
/** @type {WeakMap<object, string>} */
const refusals = (() => {
  // Without a Node `process` (a bundle that never runs a CLI) the map is private.
  if (typeof process !== 'object' || process === null) return new WeakMap();
  const holder = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (process));
  const existing = holder[REGISTRY];
  if (existing instanceof WeakMap) return existing;
  const created = new WeakMap();
  try {
    if (existing === undefined) Object.defineProperty(process, REGISTRY, { value: created });
  } catch {
    // Not ours to replace: this copy keeps a private registry, and a refusal
    // marked by another copy then reports as `unknown` (fail closed).
  }
  return created;
})();

/**
 * Marks `error` as the self-raised refusal `code`. An unregistered code marks
 * nothing (fail closed: the error reports as `unknown`). Returns `error`.
 * @template {object} T
 * @param {T} error
 * @param {string} code
 * @returns {T}
 */
function markRefusal(error, code) {
  if (REFUSAL_CODES.has(code)) refusals.set(error, code);
  return error;
}

/** @param {unknown} error @returns {string | undefined} */
function refusalCode(error) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null)
    return undefined;
  const code = refusals.get(error);
  return code !== undefined && REFUSAL_CODES.has(code) ? code : undefined;
}

const TAIL = 'diagnostics withheld; prior work may have committed — reconcile before retrying';

/**
 * Closed reporting boundary for operational commands. A refusal marked by
 * {@link markRefusal} reports its registered code; anything else reports the
 * same registered client codes as SDK boundaries (#546) or `unknown`. Never
 * stringifies a foreign value or trusts message/name/stack/cause, even on an
 * Error subclass. Runs before any build.
 * @param {unknown} error
 * @returns {string}
 */
function commandFailure(error) {
  const refusal = refusalCode(error);
  if (refusal !== undefined) return `command refused (code ${refusal}); ${TAIL}`;
  return `command failed (code ${clientFailureCode(error)}); ${TAIL}`;
}

exports.REFUSAL_CODES = REFUSAL_CODES;
exports.clientFailureCode = clientFailureCode;
exports.commandFailure = commandFailure;
exports.markRefusal = markRefusal;
exports.refusalCode = refusalCode;
