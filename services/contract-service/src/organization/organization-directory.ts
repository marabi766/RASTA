import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ContractEnv } from '../config/env';

/** The service whose hierarchy decides "under the union" (Q-70 (7)). */
export const ORGANIZATION_SERVICE = 'organization-service';

/**
 * The only valid answer is `{ "id": "<organization id>", "hierarchyVersion": <n> }` — well under
 * this. Anything longer is not the contract and is refused unread.
 */
export const MAX_RESPONSE_BYTES = 1024;

/** The body as text, or `null` once it exceeds `limit` bytes (reading stops). */
export async function readCapped(response: Response, limit: number): Promise<string | null> {
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
 * The one question contract-service asks organization-service: is `organizationId` the
 * organization `scopeOrganizationId`, or beneath it? The same question, with the same answer,
 * construction-service asks (Q-70 (7), ADR-068 § 5): a union administrator writes the signing
 * policy of the organizations under its union, and that is checked against organization-service's
 * hierarchy when the policy is written, submitted and approved — never guessed from anything this
 * service holds.
 *
 * `GET {ORGANIZATION_SERVICE_URL}/v1/organizations/{organizationId}` with an `X-Internal-Token`
 * minted for organization-service and signed for `scopeOrganizationId` — the tenant is inside the
 * signature (ADR-035). organization-service answers `{ id }` when the organization is the signed
 * one or beneath it, and 404 otherwise.
 *
 * The user's own token is deliberately not forwarded: organization-service treats `UNION_ADMIN` as
 * a platform operator that sees every organization, so a union administrator's token would prove
 * nothing about the hierarchy.
 *
 * ## Fail closed
 *
 * 200 with the same id → within. 404 → not within. Anything else — another status, a body that
 * does not name the organization or is larger than `MAX_RESPONSE_BYTES`, a timeout (which covers
 * the body read and parse, not only the headers), a network error — is `UPSTREAM_UNAVAILABLE` /
 * `UPSTREAM_TIMEOUT`, and the policy write is refused. "Could not confirm" is never read as
 * "confirmed".
 */
@Injectable()
export class OrganizationDirectory {
  private readonly logger = new Logger(OrganizationDirectory.name);

  constructor(
    @Inject(ENV) private readonly env: ContractEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  async isWithin(scopeOrganizationId: string, organizationId: string): Promise<boolean> {
    return (await this.ask(scopeOrganizationId, organizationId, false)) !== null;
  }

  /**
   * `isWithin`, and the hierarchy version of `organizationId` in the tree the answer came from
   * (D-050): `null` when it is not within. A signature that rests on "within" records the version,
   * so a later `ORGANIZATION_MOVED` is ordered against it by number, not by clock. An answer that
   * names no valid version is `UPSTREAM_UNAVAILABLE` — "within" without its version is not
   * evidence, and the signature is refused rather than recorded on it (fail closed).
   */
  async withinVersion(
    scopeOrganizationId: string,
    organizationId: string,
  ): Promise<{ hierarchyVersion: number } | null> {
    const answer = await this.ask(scopeOrganizationId, organizationId, true);
    return answer === null ? null : { hierarchyVersion: answer.hierarchyVersion as number };
  }

  /**
   * The answer and, when it is "within", the organization's CURRENT hierarchy version — `null`
   * version when the upstream names none (unlike `withinVersion`, never an error: a re-check can
   * still answer; it just cannot narrow the race review by version).
   */
  async withinAnswer(
    scopeOrganizationId: string,
    organizationId: string,
  ): Promise<{ hierarchyVersion: number | null } | null> {
    return this.ask(scopeOrganizationId, organizationId, false);
  }

  private async ask(
    scopeOrganizationId: string,
    organizationId: string,
    requireVersion: boolean,
  ): Promise<{ hierarchyVersion: number | null } | null> {
    const token = await this.tokens.issue(
      SERVICE_NAME,
      ORGANIZATION_SERVICE,
      'SERVICE',
      scopeOrganizationId,
    );
    const url =
      `${this.env.ORGANIZATION_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/organizations/${encodeURIComponent(organizationId)}`;

    const timeoutMs = this.env.CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // One deadline for the whole exchange: headers, body and parse. A server that answers 200 and
    // then stalls its body is a timeout, not a hang.
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
        return null;
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
      let body: { id?: unknown; hierarchyVersion?: unknown } | null = null;
      try {
        body = JSON.parse(text) as { id?: unknown; hierarchyVersion?: unknown } | null;
      } catch {
        body = null;
      }
      if (body?.id !== organizationId) {
        this.logger.warn('organization-service answered 200 without naming the organization asked');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      const version = body.hierarchyVersion;
      const valid = typeof version === 'number' && Number.isSafeInteger(version) && version >= 1;
      if (requireVersion && !valid) {
        this.logger.warn('organization-service answered 200 without a hierarchy version; refusing');
        throw RastaError.upstreamUnavailable(ORGANIZATION_SERVICE);
      }
      return { hierarchyVersion: valid ? version : null };
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
