import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';

/** The service whose hierarchy decides "under the union" (Q-70 (7)). */
export const ORGANIZATION_SERVICE = 'organization-service';

/**
 * The one question construction-service asks organization-service: is
 * `organizationId` the organization `scopeOrganizationId`, or beneath it?
 *
 * Q-70 (7), decided 2026-09-26: a union administrator writes approval
 * policies for the organizations under its union, and that is checked against
 * organization-service's hierarchy when the policy is written — never guessed
 * from anything this service holds.
 *
 * ## The call
 *
 * `GET {ORGANIZATION_SERVICE_URL}/v1/organizations/{organizationId}` with an
 * `X-Internal-Token` minted for organization-service and signed for
 * `scopeOrganizationId` — the tenant is inside the signature (ADR-035).
 * organization-service answers a construction-service token with `{ id }`
 * when the organization is the signed one or beneath it, and 404 otherwise
 * (its contract test, `construction-hierarchy-contract.int-spec.ts`).
 *
 * The user's own token is deliberately not forwarded: organization-service
 * treats `UNION_ADMIN` as a platform operator that sees every organization,
 * so a union administrator's token would prove nothing about the hierarchy.
 *
 * ## Fail closed
 *
 * 200 with the same id → within. 404 → not within. Anything else — another
 * status, a body that does not name the organization, a timeout, a network
 * error — is `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT`, and the policy write
 * is refused. "Could not confirm" is never read as "confirmed".
 */
@Injectable()
export class OrganizationDirectory {
  private readonly logger = new Logger(OrganizationDirectory.name);

  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async isWithin(scopeOrganizationId: string, organizationId: string): Promise<boolean> {
    const token = await this.tokens.issue(
      SERVICE_NAME,
      ORGANIZATION_SERVICE,
      'SERVICE',
      scopeOrganizationId,
    );
    const url =
      `${this.env.ORGANIZATION_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/organizations/${encodeURIComponent(organizationId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.ORGANIZATION_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          'x-correlation-id': getContext().correlationId,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw RastaError.upstreamTimeout(
          ORGANIZATION_SERVICE,
          this.env.ORGANIZATION_REQUEST_TIMEOUT_MS,
        );
      }
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) return false;
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (body?.id === organizationId) return true;
      this.logger.warn('organization-service answered 200 without naming the organization asked');
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
    }

    this.logger.warn(`organization-service answered ${response.status}; refusing (fail closed)`);
    throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
  }
}
