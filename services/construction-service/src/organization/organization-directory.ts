import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';

/** The service whose hierarchy decides "under the union" (Q-70 (7)). */
export const ORGANIZATION_SERVICE = 'organization-service';

/**
 * The only valid answer is `{ "id": "<organization id>" }` — well under this.
 * Anything longer is not the contract and is refused unread.
 */
export const MAX_RESPONSE_BYTES = 1024;

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
 * status, a body that does not name the organization or is larger than
 * `MAX_RESPONSE_BYTES`, a timeout (which covers the body read and parse, not
 * only the headers), a network error — is `UPSTREAM_UNAVAILABLE` /
 * `UPSTREAM_TIMEOUT`, and the policy write or use is refused. "Could not
 * confirm" is never read as "confirmed".
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

    const timeoutMs = this.env.CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // One deadline for the whole exchange: headers, body and parse. A server
    // that answers 200 and then stalls its body is a timeout, not a hang.
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          'x-correlation-id': getContext().correlationId,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(
          `organization-service answered ${response.status}; refusing (fail closed)`,
        );
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }

      const text = await readCapped(response, MAX_RESPONSE_BYTES);
      if (text === null) {
        this.logger.warn('organization-service answered a body larger than { id }; refusing');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      let body: { id?: unknown } | null = null;
      try {
        body = JSON.parse(text) as { id?: unknown } | null;
      } catch {
        body = null;
      }
      if (body?.id === organizationId) return true;
      this.logger.warn('organization-service answered 200 without naming the organization asked');
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted) {
        throw RastaError.upstreamTimeout(ORGANIZATION_SERVICE, timeoutMs);
      }
      throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
