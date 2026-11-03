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
 * Closed reporting boundary for operational commands. The same registered
 * codes as SDK boundaries (#546); never stringify a foreign value or trust
 * message/name/stack/cause, even on an Error subclass. Runs before any build.
 * @param {unknown} error
 * @returns {string}
 */
function commandFailure(error) {
  return `command failed (code ${clientFailureCode(error)}); diagnostics withheld; prior work may have committed — reconcile before retrying`;
}

exports.clientFailureCode = clientFailureCode;
exports.commandFailure = commandFailure;
