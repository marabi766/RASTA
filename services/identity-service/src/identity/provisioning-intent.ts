import { createHash } from 'node:crypto';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { IDEMPOTENCY_KEY_PATTERN } from '../idempotency-key';
import type { CreateUserDto, UserView } from './dto';

/**
 * A direct provisioning's intent (`POST /v1/users`, task 117 F6).
 *
 * `createUser` makes a disabled Keycloak account, then commits the user row.
 * When the transaction failed after the account was made, nothing on the
 * platform named the account: the next attempt minted a new user id, Keycloak
 * answered 409 for the username, and every attempt after it did the same.
 * Registration approval never had this problem, because the user row — and so
 * the user id the account is created with — exists before Keycloak is asked
 * (`submitRegistration`), and an approval adopts an account only when its
 * `rasta_user_id` names exactly that user.
 *
 * This gives direct provisioning the same footing. The intent is committed
 * **before** the account is created, carrying the user id (and membership id)
 * the provisioning will use. A retry is the same request only when it comes
 * from the same verified actor, with the same `Idempotency-Key`, acting for
 * the same organization, with the same normalised body; then it creates under
 * the same id, or adopts the account an earlier attempt created — the same
 * provenance rule as approval, never anybody else's account. Once the user
 * committed, the intent holds the answer and a retry replays it (docs/06
 * § 6.8). Concurrent retries take the intent's row lock and run one after the
 * other; the lock order is intent, then users, then memberships, then the
 * outbox — the intent stands where a registration request does.
 */
export interface ProvisioningIntent {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly actingOrganizationId: string | null;
  readonly requestHash: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly completedAt: Date | null;
  readonly responseBody: unknown;
}

/** What makes a retry the same request as the intent's: all four must match. */
export interface ProvisioningBinding {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly actingOrganizationId: string | null;
  readonly requestHash: string;
}

/** The `Idempotency-Key` `POST /v1/users` requires, or `400` naming it. */
export function provisioningIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw RastaError.validation([
      {
        path: 'headers.idempotency-key',
        message:
          'Provisioning a user creates an identity-provider account and requires an ' +
          'Idempotency-Key header of 1-255 printable characters',
        code: 'required',
      },
    ]);
  }
  return key;
}

/**
 * SHA-256 of the request body as validated (`createUserSchema` has trimmed it
 * and lower-cased the email), normalised so two spellings of one request hash
 * the same: keys sorted, line endings LF, roles as a sorted set — a membership
 * holds roles, not an order. Omitted stays omitted (`phone`).
 */
export function hashProvisioningRequest(dto: CreateUserDto): string {
  const text = (value: string) => value.replace(/\r\n?/g, '\n');
  const normalised: Record<string, unknown> = {
    email: text(dto.email),
    firstName: text(dto.firstName),
    lastName: text(dto.lastName),
    organizationId: dto.organizationId,
    roles: [...new Set(dto.roles)].sort(),
    username: text(dto.username),
  };
  if (dto.phone !== undefined) normalised.phone = text(dto.phone);
  const sorted = Object.fromEntries(
    Object.keys(normalised)
      .sort()
      .map((key) => [key, normalised[key]]),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Refuses a retry that is not the intent's request: another body, or another
 * acting organization, under the same actor and key. The platform's refusal,
 * nothing stored in it (docs/06 § 6.8).
 */
export function assertSameProvisioning(
  intent: ProvisioningIntent,
  binding: ProvisioningBinding,
): void {
  if (
    intent.actorId !== binding.actorId ||
    intent.idempotencyKey !== binding.idempotencyKey ||
    intent.actingOrganizationId !== binding.actingOrganizationId ||
    intent.requestHash !== binding.requestHash
  ) {
    throw RastaError.idempotencyKeyReused();
  }
}

/**
 * The stored answer, rebuilt in one fixed key order: JSONB reorders keys, and a
 * replay must serialise exactly as the original did.
 */
export function replayedUserView(stored: unknown): UserView {
  const body = stored as UserView;
  return {
    id: body.id,
    username: body.username,
    email: body.email,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    status: body.status,
    activeOrganizationId: body.activeOrganizationId,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  };
}

/** The closed codes a provisioning answers with when its account cannot be resolved. */
export const PROVISIONING_ACCOUNT_CODES = {
  /** Keycloak did not confirm the account, and none carrying this request's id is found. */
  ACCOUNT_NOT_CONFIRMED: 'ACCOUNT_NOT_CONFIRMED',
  /** The account carrying this request's id is enabled or grants something: not adopted. */
  ACCOUNT_NOT_HARMLESS: 'ACCOUNT_NOT_HARMLESS',
} as const;

/**
 * 503: Keycloak answered the create without saying which account it made, and
 * none carrying this request's user id is found. Nothing committed; the same
 * request again resolves it.
 */
export function provisioningAccountUnconfirmed(): RastaError {
  const message =
    'The identity provider did not confirm the account; nothing was provisioned and the same request can be sent again';
  return new RastaError(ERROR_CODES.UPSTREAM_UNAVAILABLE, message, {
    details: [{ path: 'user', code: PROVISIONING_ACCOUNT_CODES.ACCOUNT_NOT_CONFIRMED, message }],
    internalContext: { resourceType: 'KeycloakUser' },
  });
}

/**
 * 409: the account carrying this request's user id was enabled or given a
 * grant outside the platform — nothing on the platform writes an account no
 * user row names. Not adopted, nothing committed: an operator decides.
 */
export function provisioningAccountNotHarmless(): RastaError {
  const message =
    'The identity-provider account of this request was changed outside the platform and is not adopted';
  return new RastaError(ERROR_CODES.ALREADY_EXISTS, message, {
    details: [{ path: 'user', code: PROVISIONING_ACCOUNT_CODES.ACCOUNT_NOT_HARMLESS, message }],
    internalContext: { resourceType: 'KeycloakUser' },
  });
}
