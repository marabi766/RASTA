import { Injectable, Logger } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../identity/identity.repository';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { KeycloakAdminClient } from './keycloak.client';
import {
  divergentAttributes,
  grantsAnything,
  platformAttributesFor,
  provenanceOnly,
  type PlatformAttributeName,
  type PlatformAttributes,
} from './platform-attributes';
import {
  KEYCLOAK_PROJECTION_OUTCOMES,
  keycloakProjectionsTotal,
  type KeycloakProjectionOutcome,
  type KeycloakProjectionTrigger,
} from '../observability/keycloak-projection.metrics';

/**
 * Above the Keycloak client's worst case: six calls — token, the attribute
 * GET and PUT, and on a first activation the account read and the activation
 * GET and PUT — each bounded at 10 s.
 */
const PROJECTION_TRANSACTION_TIMEOUT_MS = 65_000;

export interface ReconcileFinding {
  userId: string;
  divergent: PlatformAttributeName[];
  /** An approval committed, but its account has not been enabled yet (#219 r2). */
  activationPending: boolean;
}

/** What the orphan repair did with one account (`repairOrphan`). */
export type OrphanRepairOutcome =
  /** Disabled and its grants cleared. */
  | 'repaired'
  /** Already disabled and granting nothing: kept as it is. */
  | 'harmless'
  /** A user row names it now, or a request of the user is approved: not an orphan any more. */
  | 'owned'
  /** Its `rasta_user_id` does not name the user, or it is gone. Not touched. */
  | 'not_ours';

/**
 * Projects a user's memberships into their Keycloak attributes (ADR-060 § 5).
 *
 * `projectUserToKeycloak` in the ADR. The only writer of the four platform
 * attributes, and it always writes all four, rebuilt from the database — so
 * running it twice, or out of order, or long after the change that prompted
 * it, converges on the same attributes. That is what makes both the event
 * handler and the backfill safe to repeat.
 *
 * ## Two paths, one function
 *
 * Every membership change calls {@link projectAfterCommit} straight after its
 * transaction commits, so the next token is right in the ordinary case. That
 * write can fail — Keycloak down, a network blip — and the membership has
 * already committed, so it must not fail the request. The durable path is the
 * identity outbox: the same change enqueued `MEMBERSHIP_*` or `ROLE_*` in its
 * transaction, and `KeycloakProjectionConsumer` projects the user again when
 * it arrives. Projections of one user are serialised by a per-user database
 * lock taken before the rows are read (see {@link write}), so whichever lands
 * last also read last: Keycloak never ends on an older snapshot than the one
 * before it.
 */
@Injectable()
export class KeycloakProjector {
  private readonly logger = new Logger(KeycloakProjector.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
  ) {}

  /** What the user's Keycloak attributes should be, or null when there is no such user. */
  async expectedAttributes(userId: string): Promise<{
    keycloakId: string | null;
    attributes: PlatformAttributes;
    activationPending: boolean;
  } | null> {
    const user = await this.repository.findUserById(userId);
    if (!user) return null;
    const memberships = await this.repository.listMembershipsForUser(userId);
    return {
      keycloakId: user.keycloakId,
      attributes: platformAttributesFor(user, memberships, new Date()),
      activationPending: user.accountActivationPending,
    };
  }

  /**
   * Rebuilds and writes one user's platform attributes. Throws if the write
   * does not land.
   */
  async project(
    userId: string,
    trigger: KeycloakProjectionTrigger,
  ): Promise<KeycloakProjectionOutcome> {
    const outcome = await this.write(userId).catch((error: unknown) => {
      keycloakProjectionsTotal.inc({ trigger, outcome: KEYCLOAK_PROJECTION_OUTCOMES.FAILED });
      throw error;
    });
    keycloakProjectionsTotal.inc({ trigger, outcome });
    return outcome;
  }

  /**
   * Projection after a membership change that has already committed.
   *
   * Never throws: failing the request would report a committed change as
   * failed, and a retry would then collide with the row it already wrote. The
   * failure is logged and counted, and the outbox event from the same
   * transaction brings the projection back round (see the class comment).
   */
  async projectAfterCommit(userId: string): Promise<void> {
    try {
      await this.project(userId, 'request');
    } catch (error) {
      this.logger.error(
        `Keycloak projection failed for user ${userId}; the identity event will retry it. ` +
          `Until then their token does not match their memberships. ${describe(error)}`,
      );
    }
  }

  /**
   * Compares what Keycloak holds with what it should, without writing.
   * Null when there is nothing to compare: no such user, or no account yet.
   */
  async reconcile(userId: string): Promise<ReconcileFinding | null> {
    const expected = await this.expectedAttributes(userId);
    if (!expected || !expected.keycloakId || !this.keycloak.enabled) return null;
    const actual = await this.keycloak.getPlatformAttributes(expected.keycloakId);
    return {
      userId,
      divergent: divergentAttributes(actual, expected.attributes),
      activationPending: expected.activationPending,
    };
  }

  /**
   * Makes an orphan harmless: an account under the username of a user who has
   * none, whose `rasta_user_id` names that user — what a registration approval
   * leaves when its transaction does not commit (#219 r2). Such an account is
   * created disabled and granting nothing, so normally there is nothing to do;
   * one that is enabled or carries a grant is disabled and its grants cleared.
   * It is **kept, never deleted**: a pending request's next approval adopts
   * it, and deleting a person's identity-provider account is a retention
   * decision nothing here makes.
   *
   * Decided under the row lock of every registration request of the user —
   * the lock approval takes — and only while none of them is APPROVED and the
   * user row still names no account; the Keycloak writes happen while the lock
   * is held. So an approval that adopts the account either committed first
   * (and this finds it owned) or waits for this to finish, and its projection
   * then enables the account. Throws when Keycloak cannot be reached.
   */
  async repairOrphan(userId: string, username: string): Promise<OrphanRepairOutcome> {
    return this.repository.transaction(
      async (tx) => {
        const statuses = await this.repository.lockRegistrationRequestsOfUser(tx, userId);
        const user = await this.repository.findUserById(userId, tx);
        if (!user || user.keycloakId || statuses.includes('APPROVED')) return 'owned';

        const account = await this.keycloak.findAccountByUsername(username);
        const provenance = account?.attributes.rasta_user_id ?? [];
        if (!account || provenance.length !== 1 || provenance[0] !== userId) return 'not_ours';
        if (!account.enabled && !grantsAnything(account.attributes)) return 'harmless';

        await this.keycloak.setEnabled(account.id, false);
        await this.keycloak.replacePlatformAttributes(account.id, provenanceOnly(userId));
        this.logger.warn(
          { userId, keycloakId: account.id },
          'Orphan Keycloak account disabled and its grants cleared',
        );
        return 'repaired';
      },
      { maxWait: 10_000, timeout: PROJECTION_TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Read the rows and write Keycloak **under one per-user lock**.
   *
   * Without it, two projections of one user — the request path and an event,
   * or two events on different partitions — could interleave as read(old),
   * read(new), write(new), write(old), leaving Keycloak on the older snapshot
   * with no event left to correct it. Holding the lock from before the read
   * until after the write makes every write carry a snapshot at least as new
   * as the one before it, and the last write — which starts after the last
   * change committed — carries the newest. The lock is a database lock held by
   * this transaction, so it serialises across replicas and dies with the
   * connection.
   *
   * The transaction outlives the Keycloak calls (three, or six on a first
   * activation, each bounded at 10 s by the client), so its timeout is set
   * above that. A projection that cannot get the lock in time fails and is retried
   * by its event, as any other failed projection is.
   */
  private async write(userId: string): Promise<KeycloakProjectionOutcome> {
    if (!this.keycloak.enabled) return KEYCLOAK_PROJECTION_OUTCOMES.DISABLED;
    return this.repository.transaction(
      async (tx) => {
        await this.repository.lockUserProjection(tx, userId);
        let user = await this.repository.findUserById(userId, tx);
        if (!user) return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
        // A registration not yet approved has no account: nothing to project into.
        if (!user.keycloakId) return KEYCLOAK_PROJECTION_OUTCOMES.NO_ACCOUNT;
        const keycloakId = user.keycloakId;
        if (user.accountActivationPending) {
          // A first activation is decided on memberships no revocation can
          // end while it runs: the user row lock is the serialisation point
          // every membership change takes first (`lockUserMemberships`), so a
          // revocation either committed before this read — and there is no
          // live membership to enable for — or waits until this commits, and
          // its own projection then clears the grants (#219 r3).
          await this.repository.lockUserMemberships(tx, userId);
          user = (await this.repository.findUserById(userId, tx)) ?? user;
        }
        const memberships = await this.repository.listMembershipsForUser(userId, tx);
        const attributes = platformAttributesFor(user, memberships, new Date());
        await this.keycloak.replacePlatformAttributes(keycloakId, attributes);
        if (user.accountActivationPending) {
          await this.activateOnce(tx, user, keycloakId, attributes);
        }
        return KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED;
      },
      { maxWait: 10_000, timeout: PROJECTION_TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Enables a registration approval's account — once, provably (#219 r3).
   *
   * Runs in the projection's transaction, after the grants are written, so the
   * account's first token is already right. Three outcomes:
   *
   * - **Already activated.** The account carries `rasta_activation`: an
   *   earlier attempt's enable landed, whatever became of its answer or of the
   *   transaction that would have cleared the flag. It is never enabled again
   *   — an account an administrator has disabled since stays disabled — and
   *   only the flag is cleared.
   * - **Activated now.** The request is APPROVED, the user ACTIVE and holding
   *   a live membership (read under the user row lock): `enabled: true` and
   *   the marker are written in one representation update, then the flag is
   *   cleared. A lost answer leaves the flag set, and the next attempt finds
   *   the marker.
   * - **Withheld.** Any of those conditions does not hold: nothing is enabled
   *   and nothing cleared, so reconcile keeps reporting the user
   *   (`activationPending`) for an operator to decide. Logged by ids only.
   */
  private async activateOnce(
    tx: ExtendedPrismaClient,
    user: { id: string; status: string },
    keycloakId: string,
    attributes: PlatformAttributes,
  ): Promise<void> {
    const account = await this.keycloak.getAccount(keycloakId);
    if (account.activation === null) {
      const registrationId = await this.repository.findApprovedRegistrationId(tx, user.id);
      const withheld = !registrationId
        ? 'no_approved_registration'
        : user.status !== 'ACTIVE'
          ? 'user_not_active'
          : attributes.organization_ids.length === 0
            ? 'no_live_membership'
            : null;
      if (!registrationId || withheld !== null) {
        this.logger.warn(
          { userId: user.id, keycloakId, reason: withheld },
          'Account activation withheld; the account stays disabled and reconcile reports it',
        );
        return;
      }
      await this.keycloak.activateAccount(keycloakId, registrationId);
    }
    await runUnscoped('the activation flag is the user row, not tenant data', () =>
      tx.user.update({
        where: { id: user.id },
        data: { accountActivationPending: false },
      }),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
