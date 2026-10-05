import type { ActorIdentity } from '@rasta/nest-common';

/**
 * What a row keeps of a person beside their user id, for a later separation-of-duties check
 * (#188): the token's verified issuer and subject **together**, or neither. Half a pair proves
 * nothing about who someone is, and the database refuses one (`ck_*_identity`).
 */
export interface StoredIdentity {
  issuer: string | null;
  subject: string | null;
}

/** The pair to store for `actor` (usually `currentActor()`): both, or neither. */
export function storedIdentityOf(actor: ActorIdentity): StoredIdentity {
  return actor.issuer !== null && actor.subject !== null
    ? { issuer: actor.issuer, subject: actor.subject }
    : { issuer: null, subject: null };
}

/**
 * A person as a row names them, ready for `compareActors`. A row written before the pair was
 * recorded has `null`s: unknown, which a separation-of-duties check refuses (fail closed).
 */
export function storedActor(
  userId: string,
  issuer: string | null | undefined,
  subject: string | null | undefined,
): ActorIdentity {
  return { userId, issuer: issuer ?? null, subject: subject ?? null };
}
