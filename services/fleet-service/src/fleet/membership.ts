import { z } from 'zod';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Whether a user may be registered as a driver of an organization: only a live
 * member of it may (task 095).
 *
 * A driver row names a platform user (`userId`), and everything an operator
 * may do with a machine is decided through it. Before this check any
 * well-formed id was accepted — a user who did not exist, or a member of
 * another organization — and the row then sat in the fleet as a driver
 * nobody could be. identity-service owns membership, so it is asked; nothing
 * about membership is copied into this service.
 *
 * The question is one bit: is `userId` a live member of the organization this
 * request acts for, now? identity answers it on
 * `GET /v1/users/{userId}/live-membership` under a `SERVICE` token signed
 * **for that organization** (ADR-035): the organization is the signed claim,
 * never a parameter, and the answer carries no roles, no other organization
 * and no name (identity `LIVE_MEMBERSHIP_CALLERS`).
 *
 * Fail closed: only a 200 whose body parses strictly and names this user and
 * this organization is an answer. Anything else — transport, timeout, a
 * non-200, a malformed or oversized body, an answer about someone else — is
 * refused as `UPSTREAM_UNAVAILABLE`, and nothing is written.
 */

export const IDENTITY_SERVICE = 'identity-service';

/** The only valid answer is four short fields; anything longer is not the contract. */
export const MAX_MEMBERSHIP_ANSWER_BYTES = 1024;

export interface MembershipSource {
  /** Whether `userId` is a live member of `organizationId` now. Throws when there is no answer. */
  isLiveMember(organizationId: string, userId: string): Promise<boolean>;
}

export const MEMBERSHIP_SOURCE = Symbol('MEMBERSHIP_SOURCE');

/**
 * The closed reason a registration is refused for (`details[].code`): the
 * user is not a live member of this organization. The same answer whether the
 * user does not exist, belongs to another organization, or their membership
 * lapsed — identity gives the same bit for all three, and so does this.
 */
export const NOT_A_MEMBER = 'USER_NOT_A_MEMBER';
export const NOT_A_MEMBER_MESSAGE = 'The user is not a member of this organization';

export function notAMember(): RastaError {
  return new RastaError(ERROR_CODES.BUSINESS_RULE_VIOLATION, NOT_A_MEMBER_MESSAGE, {
    details: [{ path: 'userId', message: NOT_A_MEMBER_MESSAGE, code: NOT_A_MEMBER }],
  });
}

const answerSchema = z
  .object({
    userId: z.string().min(1).max(64),
    organizationId: z.string().min(1).max(64),
    live: z.boolean(),
    asOf: z.string().datetime(),
  })
  .strict();

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface LiveMembershipClientOptions {
  readonly baseUrl: string;
  /** `FLEET_IDENTITY_REQUEST_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * The client. A timeout is refused as `503 UPSTREAM_UNAVAILABLE`, not `504`:
 * the question is asked before anything is written, so the caller is told the
 * truth — nothing was saved — rather than the "may have been saved" a `504`
 * means to the portal (`apps/web/src/server/write.ts`). Nothing from a failure
 * (URL, body, transport error) goes into the error.
 */
export class LiveMembershipClient implements MembershipSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LiveMembershipClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async isLiveMember(organizationId: string, userId: string): Promise<boolean> {
    const token = await this.options.tokens.issue(
      SERVICE_NAME,
      IDENTITY_SERVICE,
      'SERVICE',
      organizationId,
    );
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': token,
    };
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    let text: string | null;
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/+$/, '')}/v1/users/` +
          `${encodeURIComponent(userId)}/live-membership`,
        { method: 'GET', headers, signal: controller.signal },
      );
      if (response.status === 200) {
        text = await readCapped(response, MAX_MEMBERSHIP_ANSWER_BYTES);
      } else {
        await response.body?.cancel().catch(() => undefined);
        text = null;
      }
      if (controller.signal.aborted) throw new Error('deadline passed');
    } catch {
      throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
    } finally {
      clearTimeout(timer);
    }
    if (text === null) throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);

    const parsed = answerSchema.safeParse(parseJson(text));
    if (
      !parsed.success ||
      parsed.data.userId !== userId ||
      parsed.data.organizationId !== organizationId
    ) {
      throw RastaError.upstreamUnavailable(IDENTITY_SERVICE);
    }
    return parsed.data.live;
  }
}

/**
 * The body as text, or `null` once it exceeds `limit` bytes (reading stops).
 * The same reader construction-service and contract-service keep beside their
 * clients (`organization-directory.ts`).
 */
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
