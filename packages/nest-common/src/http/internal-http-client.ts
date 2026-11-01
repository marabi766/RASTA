import { jwtVerify, SignJWT } from 'jose';
import { RastaError } from '../errors/rasta-error';
import {
  expiryMillis,
  mapJoseError,
  readString,
  type InternalTokenPurpose,
  type ServiceClaims,
} from '../auth/token-verifier';
import { internalFetch } from './internal-fetch';

/** The header an internal token travels in (ADR-020). Set here and nowhere else. */
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * What a genuine {@link InternalTokenService} signs and verifies with.
 * Frozen: nothing outside this module can change the issuer or the TTL of the
 * tokens the client mints.
 */
interface SigningMaterial {
  readonly key: Uint8Array;
  readonly issuer: string;
  readonly ttlSeconds: number;
}

/**
 * The signing material of every genuine `InternalTokenService`, keyed by the
 * instance (PR #503 r2). Not exported, and nothing in this module returns it:
 * the key is no property of the instance (a TypeScript `private` field is an
 * ordinary property at run time, readable with `Reflect.get`), so the only code
 * that can sign with it is `mint` below, and the only caller of `mint` is
 * `InternalHttpClient.authorize`.
 */
const MATERIAL = new WeakMap<object, SigningMaterial>();

/**
 * Service-to-service tokens.
 *
 * MVP uses a short-lived HS256 token signed with a shared secret. This is a
 * documented simplification (risk S-03): production replaces it with mTLS and
 * per-workload identity per ADR-020. The token is scoped to a single target
 * service so a leaked token for `notification-service` cannot be replayed
 * against `economic-service`.
 *
 * An instance is a verifier and a capability to hand to `InternalHttpClient`,
 * nothing more: it cannot mint (`issue` throws) and holds no readable key. The
 * secret itself stays in the environment, where the process is the trust
 * boundary (D-086, docs/internal-token-transport-scope.md).
 */
export class InternalTokenService {
  constructor(secret: string, issuer: string, ttlSeconds: number) {
    if (secret.length < 32) {
      throw new Error('INTERNAL_TOKEN_SECRET must be at least 32 characters');
    }
    MATERIAL.set(
      this,
      Object.freeze({ key: new TextEncoder().encode(secret), issuer, ttlSeconds }),
    );
  }

  /**
   * Refused at run time, whoever calls it and however it was reached (a cast,
   * `Reflect.get`, a computed name, `call` on the prototype's method).
   * `InternalHttpClient.authorize` mints for a genuine instance without it.
   *
   * It stays declared so that a sender's unit test can stand in for the
   * service with `{ issue }`: a stand-in signs nothing a service accepts.
   */
  issue(
    _callerService: string,
    _targetService: string,
    _purpose?: InternalTokenPurpose,
    _organizationId?: string,
  ): Promise<string> {
    throw new TypeError(
      'InternalTokenService.issue is not callable: internal tokens are minted only by InternalHttpClient.authorize (@rasta/nest-common)',
    );
  }

  async verify(token: string, expectedTarget: string): Promise<ServiceClaims> {
    const material = MATERIAL.get(this);
    if (!material) {
      throw new TypeError('verify called on something that is not an InternalTokenService');
    }
    try {
      const { payload } = await jwtVerify(token, material.key, {
        issuer: material.issuer,
        audience: expectedTarget,
        algorithms: ['HS256'],
        clockTolerance: 5,
        // As for user tokens: `mint` always sets one, so this refuses only a
        // token that did not come from `mint`.
        requiredClaims: ['exp'],
      });

      if (!payload.sub) {
        throw new RastaError('TOKEN_INVALID', 'Internal token has no subject');
      }

      const purpose: InternalTokenPurpose = payload['purpose'] === 'RELAY' ? 'RELAY' : 'SERVICE';

      return {
        callerService: payload.sub,
        targetService: expectedTarget,
        // Absent means SERVICE: the stricter reading, and what every token
        // minted before the claim existed meant.
        purpose,
        // Read only for SERVICE. A relay names no actor and therefore no
        // tenant; honouring an `org_id` on one would let the gateway — the
        // component exposed to outside traffic — choose a tenant for a call it
        // is only forwarding (ADR-035).
        ...(purpose === 'SERVICE' ? { organizationId: readString(payload, 'org_id') } : {}),
        expiresAt: expiryMillis(payload),
      };
    } catch (error) {
      throw mapJoseError(error);
    }
  }
}

/**
 * Mints a token for one caller, one target and — for a tenant-scoped call —
 * one organization. Module-private: `authorize` is its only caller.
 *
 * `organizationId` goes **inside the signature**. That is the whole point of
 * ADR-035: an unsigned `X-Organization-Id` header can be written by anything
 * that reaches the service, so it cannot be the authority for which tenant a
 * service acts as. Minting per (target, organization) keeps a leaked token
 * worth exactly one organization on one service for `ttlSeconds`.
 *
 * Omit it for a platform-wide operation, and for every `RELAY` token.
 */
function mint(
  material: SigningMaterial,
  callerService: string,
  targetService: string,
  purpose: InternalTokenPurpose,
  organizationId?: string,
): Promise<string> {
  return new SignJWT({
    svc: callerService,
    purpose,
    ...(organizationId ? { org_id: organizationId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(material.issuer)
    .setAudience(targetService)
    .setSubject(callerService)
    .setIssuedAt()
    .setExpirationTime(`${material.ttlSeconds}s`)
    .sign(material.key);
}

/**
 * Who asks whom, on whose authority. The token's issuer, audience, purpose and
 * signed tenant — exactly the arguments `mint` takes.
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
    /**
     * A genuine `InternalTokenService` (production), or a sender test's
     * stand-in, which is asked through its own `issue`.
     */
    private readonly tokens: Pick<InternalTokenService, 'issue'>,
    /** Injection seam for tests; the global fetch, looked up per request, otherwise. */
    private readonly fetchImpl?: typeof fetch,
  ) {
    // A client's issuer and transport are fixed when it is built: nothing can
    // swap the transport of a client production code already holds.
    Object.freeze(this);
  }

  async authorize(grant: InternalGrant): Promise<InternalSender> {
    const material = MATERIAL.get(this.tokens);
    // The same arguments, in the same number, as the callers passed before.
    const token = material
      ? await mint(material, grant.from, grant.to, grant.purpose, grant.organizationId)
      : 'organizationId' in grant
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
