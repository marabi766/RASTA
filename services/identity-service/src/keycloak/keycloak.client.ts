import { Injectable, Logger } from '@nestjs/common';
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
}

/** What the admin API returns for a user — only the fields this client reads. */
interface KeycloakUserRepresentation {
  id: string;
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

export interface KeycloakClientOptions {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  /** When false every call is a no-op. Used by tests and offline development. */
  enabled: boolean;
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

  private async accessToken(): Promise<string> {
    // Refresh 30s early so a token does not expire mid-request.
    if (this.token && this.token.expiresAt > Date.now() + 30_000) {
      return this.token.value;
    }

    const response = await fetch(
      `${this.options.baseUrl}/realms/${this.options.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
      },
    );

    if (!response.ok) {
      // The body may echo the client secret back; it never reaches the log.
      throw RastaError.upstreamUnavailable('keycloak', {
        status: response.status,
        operation: 'client_credentials',
      });
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return this.token.value;
  }

  private async admin(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    return fetch(`${this.options.baseUrl}/admin/realms/${this.options.realm}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
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
        enabled: true,
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

    // Keycloak returns the new id only in the Location header.
    const location = response.headers.get('location');
    const keycloakId = location?.split('/').pop() ?? null;

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
   * any non-platform attribute: `docs/23` D-037.
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
