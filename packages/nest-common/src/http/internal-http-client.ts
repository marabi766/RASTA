import type { InternalTokenPurpose, InternalTokenService } from '../auth/token-verifier';
import { internalFetch } from './internal-fetch';

/** The header an internal token travels in (ADR-020). Set here and nowhere else. */
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Who asks whom, on whose authority. The token's issuer, audience, purpose and
 * signed tenant — exactly the arguments `InternalTokenService.issue` takes.
 */
export type InternalGrant =
  | {
      /** The calling service: the token's issuer and subject. */
      readonly from: string;
      /** The service asked: the token's audience. */
      readonly to: string;
      readonly purpose: 'SERVICE';
      /**
       * Signed into the token (ADR-035). Omit it for a platform-wide read; a
       * property present but `undefined` is passed on as such.
       */
      readonly organizationId?: string;
    }
  | {
      readonly from: string;
      readonly to: string;
      /** A forwarded request: names no actor and therefore no tenant. */
      readonly purpose: Extract<InternalTokenPurpose, 'RELAY'>;
      readonly organizationId?: never;
    };

/** Sends requests carrying one minted token. The token itself is never exposed. */
export interface InternalSender {
  /**
   * One exchange through {@link internalFetch}: redirects refused, every
   * other status the caller's to judge. A caller-provided internal-token
   * header, in any letter case or header representation, is replaced.
   */
  send(input: string | URL, init: Omit<RequestInit, 'redirect'>): Promise<Response>;
}

/**
 * The one place an internal token is minted and put on an outbound request
 * (PR #423 follow-up 1): issuance and sending stay together, so no caller
 * holds a token it could send some other way.
 *
 * `authorize` mints the token when it is called — callers keep issuance where
 * it was, before their deadline starts — and the sender it returns may be used
 * for several requests (one resolution's pages).
 */
export class InternalHttpClient {
  constructor(
    private readonly tokens: Pick<InternalTokenService, 'issue'>,
    /** Injection seam for tests; the global fetch, looked up per request, otherwise. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async authorize(grant: InternalGrant): Promise<InternalSender> {
    // The same arguments, in the same number, as the callers passed before.
    const token =
      'organizationId' in grant
        ? await this.tokens.issue(grant.from, grant.to, grant.purpose, grant.organizationId)
        : await this.tokens.issue(grant.from, grant.to, grant.purpose);
    const fetchImpl = this.fetchImpl;
    return {
      send: (input, init) =>
        internalFetch(
          input,
          { ...init, headers: withInternalToken(init.headers, token) },
          fetchImpl,
        ),
    };
  }
}

type HeaderInput = NonNullable<RequestInit['headers']>;

/** The caller's headers, in the representation given, with only this token in the internal header. */
function withInternalToken(headers: RequestInit['headers'], token: string): HeaderInput {
  const isInternal = (name: string) => name.toLowerCase() === INTERNAL_TOKEN_HEADER;
  if (headers === undefined || isPlainObject(headers)) {
    const record: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!isInternal(name)) record[name] = value;
    }
    record[INTERNAL_TOKEN_HEADER] = token;
    return record as HeaderInput;
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([name]) => !isInternal(String(name))),
      [INTERNAL_TOKEN_HEADER, token],
    ];
  }
  // A Headers instance or any other iterable: Headers replaces case-insensitively.
  const normalized = new Headers(headers);
  normalized.set(INTERNAL_TOKEN_HEADER, token);
  return normalized;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
