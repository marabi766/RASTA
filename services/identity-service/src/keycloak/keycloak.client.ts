import { Injectable, Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';

/**
 * Thin client over the Keycloak Admin API.
 *
 * The boundary this maintains (ADR-008): Keycloak owns authentication —
 * passwords, sessions, MFA, token issuance. This service owns membership. The
 * only reason to call Keycloak at all is to keep two attributes in sync so
 * they land in the token:
 *
 *   active_organization_id -> the `org_id` claim
 *   organization_ids       -> the `org_ids` claim
 *
 * Those claims are what the gateway checks `X-Organization-Id` against, so a
 * failure to sync means a user cannot act for an organization they belong to.
 */

export interface CreateKeycloakUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  roles: string[];
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
        attributes: {
          active_organization_id: [input.organizationId],
          organization_ids: [input.organizationId],
        },
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

    if (keycloakId) {
      await this.assignRealmRoles(keycloakId, input.roles);
    }

    return keycloakId;
  }

  async assignRealmRoles(keycloakId: string, roles: readonly string[]): Promise<void> {
    if (!this.options.enabled || roles.length === 0) return;

    const available = await this.admin('/roles');
    if (!available.ok) {
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'listRoles' });
    }

    const all = (await available.json()) as Array<{ id: string; name: string }>;
    const wanted = all.filter((role) => roles.includes(role.name));

    // A role present locally but absent in Keycloak means the realm and the
    // platform have drifted. Log it rather than failing the whole operation:
    // the membership is still valid, and the drift is an operations problem.
    const missing = roles.filter((name) => !all.some((role) => role.name === name));
    if (missing.length > 0) {
      this.logger.warn(`Roles missing from Keycloak realm: ${missing.join(', ')}`);
    }
    if (wanted.length === 0) return;

    const response = await this.admin(`/users/${keycloakId}/role-mappings/realm`, {
      method: 'POST',
      body: JSON.stringify(wanted),
    });

    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'assignRealmRoles' });
    }
  }

  /** Mirrors the membership set into the attribute that becomes `org_ids`. */
  async syncMemberships(
    keycloakId: string | null,
    userId: string,
    organizationIds: readonly string[],
  ): Promise<void> {
    if (!this.options.enabled || !keycloakId) return;

    const response = await this.admin(`/users/${keycloakId}`, {
      method: 'PUT',
      body: JSON.stringify({ attributes: { organization_ids: [...organizationIds] } }),
    });

    if (!response.ok) {
      // Deliberately not fatal. The membership is already committed; failing
      // here would roll back a valid change because a downstream sync blipped.
      // Surfaced loudly because the user cannot act for the new organization
      // until their next token refresh picks the attribute up.
      this.logger.error(
        `Failed to sync memberships for user ${userId} (status ${response.status}). ` +
          'Their token will not carry the new organization until this is retried.',
      );
    }
  }

  async setActiveOrganization(keycloakId: string | null, organizationId: string): Promise<void> {
    if (!this.options.enabled || !keycloakId) return;

    const response = await this.admin(`/users/${keycloakId}`, {
      method: 'PUT',
      body: JSON.stringify({ attributes: { active_organization_id: [organizationId] } }),
    });

    if (!response.ok) {
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'setActiveOrganization' });
    }
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
