/** Foreign diagnostics are data, including names/codes. Only registered codes may leave a client. */
const CLIENT_CODES: ReadonlySet<string> = new Set([
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

export function clientFailureCode(error: unknown): string {
  try {
    const failure = error as { errorCode?: unknown; code?: unknown; name?: unknown } | null;
    for (const code of [failure?.errorCode, failure?.code, failure?.name]) {
      if (typeof code === 'string' && CLIENT_CODES.has(code)) return code;
    }
  } catch {
    // A foreign getter is no more trusted than a foreign message.
  }
  return 'unknown';
}
