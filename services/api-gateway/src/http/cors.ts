import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * The gateway's CORS policy, for the origins `GATEWAY_CORS_ORIGINS` names.
 *
 * `exposedHeaders` is the list of response headers a browser lets the calling
 * script read; anything off it (and off the CORS-safelisted few) is invisible
 * to the script even though it arrived. `retry-after` is on it because the
 * platform promises it on the in-flight idempotency `409` (docs/06 § 6.8) and
 * on a rate-limit `429`: a browser client that cannot read the header cannot
 * keep that promise's other half and wait.
 */
export function corsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    credentials: true,
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-correlation-id',
      'x-organization-id',
      'idempotency-key',
      'if-match',
    ],
    exposedHeaders: ['x-correlation-id', 'x-request-id', 'x-trace-id', 'etag', 'retry-after'],
    maxAge: 600,
  };
}
