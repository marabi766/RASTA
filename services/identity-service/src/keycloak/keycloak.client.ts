import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  PLATFORM_ATTRIBUTE_NAMES,
  readPlatformAttributes,
  type PlatformAttributes,
} from './platform-attributes';

/**
 * Thin client over the Keycloak Admin API.
 *
 * The boundary this maintains (ADR-008): Keycloak owns authentication —
 * passwords, sessions, MFA, token issuance. This service owns membership. The
 * reason to call Keycloak at all is to project membership into the four user
 * attributes that become token claims (`platform-attributes.ts`, ADR-060 § 5).
 *
 * Those claims are what every service authorizes against, so a projection
 * that did not land means a token that says something the database does not.
 */

export interface CreateKeycloakUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  /** The whole platform attribute set, from the first write (ADR-060 § 5). */
  attributes: PlatformAttributes;
  /**
   * Whether the account can sign in from the start. A registration approval
   * creates it disabled, with no grants, and the projector enables it once the
   * database has committed the approval (#219 r2).
   */
  enabled: boolean;
}

/** What the admin API returns for a user — only the fields this client reads. */
interface KeycloakUserRepresentation {
  id: string;
  username?: string;
  enabled?: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string[]>;
  [field: string]: unknown;
}

/**
 * The body of the platform-attribute write: exactly these keys, and nothing
 * else from the representation (see `replacePlatformAttributes`). The three
 * profile fields are here only because Keycloak erases them when a body with
 * `attributes` leaves them out.
 */
function platformAttributesWrite(
  current: KeycloakUserRepresentation,
  attributes: Record<string, string[]>,
): Pick<KeycloakUserRepresentation, 'email' | 'firstName' | 'lastName' | 'attributes'> {
  return {
    email: current.email,
    firstName: current.firstName,
    lastName: current.lastName,
    attributes,
  };
}

/**
 * The admin-only attribute that records a registration approval's account was
 * enabled, carrying the registration request id (#219 r3). Written together
 * with `enabled: true` in one representation update (`activateAccount`), so
 * its presence proves the enable was applied even when Keycloak's answer to it
 * was lost — and an account that carries it is never enabled again by the
 * platform. Declared admin-only in the realm's user profile, and mapped to no
 * token claim. Not a platform attribute: the projection never rewrites it.
 */
export const ACTIVATION_ATTRIBUTE = 'rasta_activation';

/** One account as the client reads it: no profile data, only what decisions need. */
export interface KeycloakAccount {
  id: string;
  enabled: boolean;
  attributes: PlatformAttributes;
  /** `rasta_activation`: the registration request whose approval enabled it, or null. */
  activation: string | null;
}

/**
 * Keycloak answered a create with success but no usable id (#219 r3): the
 * account may exist, and nothing here can say which it is. The caller resolves
 * it by looking the account up, or does not commit.
 */
export class KeycloakCreateUnconfirmedError extends RastaError {
  constructor() {
    super(ERROR_CODES.UPSTREAM_UNAVAILABLE, 'The identity provider did not confirm the account', {
      internalContext: { service: 'keycloak', operation: 'createUser', reason: 'no-id' },
    });
    this.name = 'KeycloakCreateUnconfirmedError';
  }
}

/** A Keycloak user id as the Location header carries it: one path segment, nothing else. */
const KEYCLOAK_ID = /^[A-Za-z0-9-]{1,64}$/;

function toAccount(found: KeycloakUserRepresentation): KeycloakAccount {
  return {
    id: found.id,
    enabled: found.enabled === true,
    attributes: readPlatformAttributes(found.attributes),
    activation: found.attributes?.[ACTIVATION_ATTRIBUTE]?.[0] ?? null,
  };
}

export interface KeycloakClientOptions {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** When false every call is a no-op. Used by tests and offline development. */
  enabled: boolean;
  /**
   * The deadline of every call to Keycloak — the token request included —
   * covering the connection, the response and its body. Several are made
   * while a database lock is held (an approval, a projection), so none may
   * wait without one (#219 r4). Defaults to {@link KEYCLOAK_REQUEST_TIMEOUT_MS}.
   */
  requestTimeoutMs?: number;
}

/** The default deadline of one Keycloak call: connection, response and body. */
export const KEYCLOAK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A Keycloak call that did not answer — its deadline passed, or the
 * connection failed — as the upstream error every caller already handles,
 * rather than a bare `TimeoutError` or `TypeError` from `fetch`. Nothing of
 * the request is carried, so neither a token nor a secret can reach a log.
 */
async function unreachableAsUpstream<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RastaError) throw error;
    const reason =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'deadline'
        : 'unreachable';
    throw RastaError.upstreamUnavailable('keycloak', { operation, reason });
  }
}

@Injectable()
export class KeycloakAdminClient {
  private readonly logger = new Logger(KeycloakAdminClient.name);
  private token?: { value: string; expiresAt: number };

  constructor(private readonly options: KeycloakClientOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  // -------------------------------------------------------------------------
  // Token handling
  // -------------------------------------------------------------------------

  /** A fresh deadline for one call (`requestTimeoutMs`). */
  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.options.requestTimeoutMs ?? KEYCLOAK_REQUEST_TIMEOUT_MS);
  }

  private async accessToken(): Promise<string> {
    // Refresh 30s early so a token does not expire mid-request.
    if (this.token && this.token.expiresAt > Date.now() + 30_000) {
      return this.token.value;
    }

    // The same deadline as every admin call: a token endpoint that accepts
    // the connection and never answers would otherwise hold the caller — and
    // the database lock an approval or a projection holds around it —
    // without bound (#219 r4). The signal also bounds reading the body below.
    const deadline = this.deadline();
    const response = await unreachableAsUpstream('client_credentials', () =>
      fetch(`${this.options.baseUrl}/realms/${this.options.realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
        signal: deadline,
      }),
    );

    if (!response.ok) {
      // The body may echo the client secret back; it never reaches the log.
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'client_credentials',
      });
    }

    const body = await unreachableAsUpstream(
      'client_credentials',
      () => response.json() as Promise<{ access_token: string; expires_in: number }>,
    );
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return this.token.value;
  }

  private async admin(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return unreachableAsUpstream('admin', () =>
      fetch(`${this.options.baseUrl}/admin/realms/${this.options.realm}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        signal: this.deadline(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Provisions an account and returns its Keycloak id.
   *
   * No password is set. The user completes a first-login credential flow in
   * Keycloak, which keeps password handling entirely inside the identity
   * provider — this service never sees, transports or stores one.
   */
  async createUser(input: CreateKeycloakUserInput): Promise<string | null> {
    if (!this.options.enabled) {
      this.logger.debug(`Keycloak sync disabled; skipping createUser for ${input.username}`);
      return null;
    }

    const response = await this.admin('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: input.username,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        enabled: input.enabled,
        emailVerified: false,
        requiredActions: ['UPDATE_PASSWORD'],
        // All four, including `rasta_user_id` — which was never written before,
        // so every API-provisioned token fell back to `sub` for the user id.
        attributes: input.attributes,
      }),
    });

    if (response.status === 409) {
      throw RastaError.alreadyExists('User');
    }
    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'createUser',
      });
    }

    // Keycloak returns the new id only in the Location header. A success
    // without a usable one is not "no account": the account may well exist,
    // so it is reported as unconfirmed rather than as null, which a caller
    // would store as "no account" with nothing left to repair it (#219 r3).
    const location = response.headers.get('location') ?? '';
    const keycloakId = /\/users\/([^/?#]+)$/.exec(location)?.[1] ?? '';
    if (!KEYCLOAK_ID.test(keycloakId)) throw new KeycloakCreateUnconfirmedError();

    // No realm roles. A role is granted in one organization and travels in
    // `organization_roles`; the guard ignores every realm role but
    // SYSTEM_ADMIN, which the API cannot grant to anybody (ADR-060 § 2, #77).
    // Mapping the realm role here only produced a misleading token claim.
    return keycloakId;
  }

  /**
   * Replaces the platform attributes of one user — all four, in one write —
   * and sends nothing it does not own.
   *
   * Measured on Keycloak 26.0.8 (ADR-060 § 5): the admin `PUT` has no version
   * check (no ETag; `If-Match` is ignored) and no attribute-level form, but it
   * changes only the fields present in its body — except that a body carrying
   * `attributes` removes every attribute it omits, the profile's `email`,
   * `firstName` and `lastName` included. So the body is an allowlist: those
   * three as read a moment before, the attributes this service does not own as
   * read, and the four platform attributes. `requiredActions`, `enabled`,
   * `emailVerified` and the rest of the representation are never sent, so a
   * concurrent change to them — an administrator disabling the account, a
   * user completing `UPDATE_PASSWORD` — is never undone by a projection.
   *
   * What is still read-then-written, and so can still lose a change made in
   * the few milliseconds between the two, is those three profile fields and
   * any non-platform attribute — and the email is a sign-in and reset
   * identifier in this realm, not display data: `docs/23` D-037.
   *
   * Throws when the write does not land. Whether that is fatal is the
   * caller's decision (`KeycloakProjector`), not this client's.
   */
  async replacePlatformAttributes(
    keycloakId: string,
    attributes: PlatformAttributes,
  ): Promise<void> {
    if (!this.options.enabled) return;

    const current = await this.getUser(keycloakId, 'replacePlatformAttributes');
    const others = Object.fromEntries(
      Object.entries(current.attributes ?? {}).filter(
        ([name]) => !(PLATFORM_ATTRIBUTE_NAMES as readonly string[]).includes(name),
      ),
    );

    const response = await this.admin(`/users/${keycloakId}`, {
      method: 'PUT',
      body: JSON.stringify(platformAttributesWrite(current, { ...others, ...attributes })),
    });

    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'replacePlatformAttributes',
      });
    }
  }

  /**
   * The account Keycloak holds under one username, or null — what an approval
   * reads after `createUser` answered 409, and what reconcile reads to find an
   * account no user row points at (`approveRegistration`). Usernames are
   * case-insensitive in Keycloak, which stores them lower-cased; `exact=true`
   * stops `foo` from matching `foobar`, and the comparison below stops
   * anything else.
   */
  async findAccountByUsername(username: string): Promise<KeycloakAccount | null> {
    if (!this.options.enabled) return null;

    const query = new URLSearchParams({ username, exact: 'true' });
    const response = await this.admin(`/users?${query.toString()}`);
    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'findAccountByUsername',
      });
    }
    const found = ((await response.json()) as KeycloakUserRepresentation[]).find(
      (account) => account.username?.toLowerCase() === username.toLowerCase(),
    );
    return found ? toAccount(found) : null;
  }

  /** One account by its id, as a decision needs it (`KeycloakAccount`). */
  async getAccount(keycloakId: string): Promise<KeycloakAccount> {
    return toAccount(await this.getUser(keycloakId, 'getAccount'));
  }

  /**
   * Enables a registration approval's account and marks it activated, in
   * **one** representation update: `enabled: true` and `rasta_activation`
   * travel together, so either both landed or neither did. A caller that did
   * not hear the answer reads the account back (`getAccount`) and finds the
   * marker, and never enables it again (#219 r3).
   *
   * The body is the same allowlist as `replacePlatformAttributes` — the three
   * profile fields Keycloak would otherwise erase, every attribute as read,
   * and the marker — plus `enabled`. Nothing else in the representation is
   * sent.
   */
  async activateAccount(keycloakId: string, registrationId: string): Promise<void> {
    if (!this.options.enabled) return;

    const current = await this.getUser(keycloakId, 'activateAccount');
    const response = await this.admin(`/users/${keycloakId}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...platformAttributesWrite(current, {
          ...(current.attributes ?? {}),
          [ACTIVATION_ATTRIBUTE]: [registrationId],
        }),
        enabled: true,
      }),
    });
    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'activateAccount',
      });
    }
  }

  /** The platform attributes Keycloak currently holds for one user, for reconcile. */
  async getPlatformAttributes(keycloakId: string): Promise<PlatformAttributes> {
    const current = await this.getUser(keycloakId, 'getPlatformAttributes');
    return readPlatformAttributes(current.attributes);
  }

  private async getUser(
    keycloakId: string,
    operation: string,
  ): Promise<KeycloakUserRepresentation> {
    const response = await this.admin(`/users/${keycloakId}`);
    if (response.status === 404) {
      throw RastaError.notFound('KeycloakUser', keycloakId);
    }
    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', { status: response.status, operation });
    }
    return (await response.json()) as KeycloakUserRepresentation;
  }

  async setEnabled(keycloakId: string | null, enabled: boolean): Promise<void> {
    if (!this.options.enabled || !keycloakId) return;

    const response = await this.admin(`/users/${keycloakId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });

    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'setEnabled' });
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.options.enabled) return true;
    try {
      await this.accessToken();
      return true;
    } catch {
      return false;
    }
  }
}
