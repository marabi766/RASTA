import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../identity/identity.repository';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { KeycloakAdminClient, KeycloakWriteUnconfirmedError } from './keycloak.client';
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
  KEYCLOAK_WRITE_AHEAD_OUTCOMES,
  keycloakProjectionsTotal,
  keycloakReassertMarksTotal,
  keycloakWriteAheadTotal,
  type KeycloakProjectionOutcome,
  type KeycloakProjectionTrigger,
  type KeycloakWriteAheadOutcome,
} from '../observability/keycloak-projection.metrics';
import { PROJECTION_TRANSACTION_TIMEOUT_MS } from '../config/operation-budgets';

/**
 * A second projection or repair of the same user waits on the first one's
 * lock for as long as that one may hold it, so its statements may run as long
 * as the transaction. A shorter session timeout — behind PgBouncer, the
 * runtime role's own default, which `loadEnv` cannot check against the
 * operation budgets — would cancel the wait while Keycloak is merely slow
 * (#268). Set with `SET LOCAL`, for these transactions only.
 */
export const PROJECTION_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: PROJECTION_TRANSACTION_TIMEOUT_MS,
  statementTimeoutMs: PROJECTION_TRANSACTION_TIMEOUT_MS,
} as const;

/**
 * Every transaction that takes the user lock (`lockUserMemberships`) — a
 * membership change, a switch, an expiry — may wait on a projection that
 * holds it across Keycloak calls, and a narrowing change makes one such call
 * itself (D-064). So it has the projection's bounds, not Prisma's default 5 s:
 * the wait is part of the operation, not a fault.
 */
export const USER_LOCK_TRANSACTION_OPTIONS = PROJECTION_TRANSACTION_OPTIONS;

export interface KeycloakProjectorOptions {
  /**
   * `KEYCLOAK_WRITE_SETTLE_SECONDS`: how long a write whose answer was lost may
   * still be applied, so how long a narrowing change of that user is refused
   * and when the user is re-projected (D-064).
   */
  writeSettleSeconds: number;
}

/** The injection token of {@link KeycloakProjectorOptions}; the defaults stand in when absent. */
export const KEYCLOAK_PROJECTOR_OPTIONS = Symbol('KEYCLOAK_PROJECTOR_OPTIONS');

export const DEFAULT_KEYCLOAK_PROJECTOR_OPTIONS: KeycloakProjectorOptions = {
  writeSettleSeconds: 120,
};

/**
 * A narrowing change's write to Keycloak, made inside its transaction before
 * it commits (`KeycloakProjector.narrowing`, D-064). One per change.
 */
export interface NarrowingWriteAhead {
  /**
   * Writes `attributes` — what the rows granted before the change, intersected
   * with what they grant after it (`intersectAttributes`) — to the user's
   * account. Called in the change's transaction, under the user lock, after
   * the rows changed and **before** any event is enqueued: the event's
   * `occurredAt` is stamped after this returns, and is the gateway's cutoff.
   *
   * Proceeds without writing when there is nothing to narrow: no account
   * (`keycloakId` null — no token can exist), or Keycloak answers 404 for it,
   * or Keycloak sync is off (development and test only; refused at boot
   * elsewhere, `assertNarrowingEnforced`). Throws `KEYCLOAK_UNAVAILABLE` when
   * the write did not land, or when an earlier write of the user may still.
   */
  write(
    tx: ExtendedPrismaClient,
    attributes: PlatformAttributes,
  ): Promise<KeycloakWriteAheadOutcome>;
  /**
   * After the transaction failed: records what Keycloak may now hold, and
   * returns what to throw — `KEYCLOAK_UNAVAILABLE` when Keycloak was the
   * reason, the error itself otherwise.
   */
  settle(error: unknown): Promise<unknown>;
}

/**
 * 503 `KEYCLOAK_UNAVAILABLE`: a narrowing change was refused because Keycloak
 * could not be written first. Nothing committed, no event; the same request
 * may be sent again. The body says nothing of what Keycloak answered.
 */
export function keycloakUnavailable(cause: unknown, retryAfterSeconds?: number): RastaError {
  return new RastaError(
    ERROR_CODES.KEYCLOAK_UNAVAILABLE,
    'The identity provider could not be written before the change; nothing was changed',
    {
      internalContext: { service: 'keycloak', operation: 'writeAhead' },
      cause,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  );
}

/** Keycloak has no account under the id: there is nothing to write, and nothing can mint a token. */
function isAccountMissing(error: unknown): boolean {
  return error instanceof RastaError && error.code === ERROR_CODES.NOT_FOUND;
}

export interface ReconcileFinding {
  userId: string;
  divergent: PlatformAttributeName[];
  /** An approval committed, but its account has not been enabled yet (#219 r2). */
  activationPending: boolean;
  /**
   * Keycloak's `enabled` disagrees with the platform's user status (#219 r4,
   * D-049): enabled while the user is not ACTIVE, or disabled while the user
   * is ACTIVE and no activation is pending — an account disabled in the
   * Keycloak console rather than through the platform. Null when they agree.
   */
  enabledDivergent: { keycloakEnabled: boolean; platformStatus: string } | null;
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
 * ## Widening after commit, narrowing before it (D-064)
 *
 * A change that grants — a membership added, a role added — commits first and
 * calls {@link projectAfterCommit} straight after, so the next token is right
 * in the ordinary case. That write can fail, and the change has committed, so
 * it must not fail the request: the change also enqueued `MEMBERSHIP_*`,
 * `ROLE_*` or `USER_ACTIVATED` in its transaction, and
 * `KeycloakProjectionConsumer` projects the user again when it arrives.
 *
 * A change that takes something away — a role removed, a membership revoked
 * or lapsed, the narrowing half of a mixed change — writes Keycloak **before**
 * it commits ({@link narrowing}): what the rows granted before and after it,
 * intersected, so Keycloak is never wider than the rows whichever way the
 * transaction ends. Its event is enqueued after that write returns, so the
 * event's `occurredAt` — the gateway's cutoff — is later than every token
 * Keycloak minted with the old grant. A write that does not land refuses the
 * change: 503 `KEYCLOAK_UNAVAILABLE`, nothing committed. Then it projects the
 * full new state after commit, like any other change.
 *
 * ## One lock, every writer
 *
 * Every write of a user's attributes — a narrowing change's write-ahead, a
 * projection after a request, the consumer's backstop, the backfill, the
 * re-assertion sweep, a first activation, the orphan repair — happens in a
 * transaction that took that user's row lock (`lockUserMemberships`) **before
 * it read** what it writes, and holds it until after the write. Membership
 * changes take the same lock first, so a write always carries rows that were
 * current while it was made: no write can carry state older than one made
 * before it, and none can carry state another transaction is about to
 * change. Locks are always taken in one order — a registration request (an
 * approval, the orphan repair), then the user, then their memberships, then
 * the outbox stream counter — so this lock adds no cycle.
 *
 * ## A write whose answer was lost
 *
 * Aborting a request does not cancel it: a write past its deadline, cut off
 * mid-answer or answered 5xx may be applied by Keycloak later, after a newer
 * write, and leave Keycloak wider than the rows. Every writer here records
 * such a write against the user (`keycloak_reassert_at`, now +
 * `KEYCLOAK_WRITE_SETTLE_SECONDS`): until then a narrowing change of that user
 * is refused, because it could not be the last write; once it passes, the
 * expiry sweep projects the user again, under the lock, from the rows. A
 * write that did land in a transaction that then did not commit is recorded
 * as due at once, and projected again straight away.
 */
@Injectable()
export class KeycloakProjector {
  private readonly logger = new Logger(KeycloakProjector.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
    @Optional()
    @Inject(KEYCLOAK_PROJECTOR_OPTIONS)
    private readonly options: KeycloakProjectorOptions = DEFAULT_KEYCLOAK_PROJECTOR_OPTIONS,
  ) {}

  /** What the user's Keycloak attributes should be, or null when there is no such user. */
  async expectedAttributes(userId: string): Promise<{
    keycloakId: string | null;
    attributes: PlatformAttributes;
    activationPending: boolean;
    status: string;
  } | null> {
    const user = await this.repository.findUserById(userId);
    if (!user) return null;
    const memberships = await this.repository.listMembershipsForUser(userId);
    return {
      keycloakId: user.keycloakId,
      attributes: platformAttributesFor(user, memberships, new Date()),
      activationPending: user.accountActivationPending,
      status: user.status,
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
   * transaction brings the projection back round (see the class comment). For
   * a narrowing change Keycloak already holds no more than the rows grant: what
   * is late is only what it added.
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
   * Starts one narrowing change's write-ahead (D-064). The caller holds the
   * user lock in its transaction, computes the attributes from rows read
   * under it, calls `write` before it enqueues its event, and passes any
   * failure of the transaction through `settle`.
   */
  narrowing(userId: string): NarrowingWriteAhead {
    /**
     * idle → writing → landed | unconfirmed | refused | absent, or settling
     * when refused before writing. `writing` that outlives the transaction —
     * it timed out with the call in flight — counts as unconfirmed.
     */
    let phase: 'idle' | 'writing' | 'landed' | 'unconfirmed' | 'refused' | 'absent' | 'settling' =
      'idle';
    const outcome = (value: KeycloakWriteAheadOutcome) => {
      keycloakWriteAheadTotal.inc({ outcome: value });
      return value;
    };

    return {
      write: async (tx, attributes) => {
        if (phase !== 'idle') throw new Error('one write-ahead per narrowing change');
        if (!this.keycloak.enabled) return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.DISABLED);
        const state = await this.repository.keycloakWriteState(tx, userId);
        // No account: nothing was ever enabled to sign in with, so no token of
        // this user exists to narrow (an approval links the account in the
        // transaction that activates it).
        if (!state?.keycloakId) return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.NO_ACCOUNT);
        if (state.settlingForSeconds !== null) {
          phase = 'settling';
          outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.SETTLING);
          throw keycloakUnavailable(null, state.settlingForSeconds);
        }
        phase = 'writing';
        try {
          await this.keycloak.replacePlatformAttributes(state.keycloakId, attributes);
        } catch (error) {
          if (isAccountMissing(error)) {
            // Deleted in Keycloak: it can mint nothing more, and every token
            // it minted before is older than the event this change emits.
            phase = 'absent';
            return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.NO_ACCOUNT);
          }
          phase = error instanceof KeycloakWriteUnconfirmedError ? 'unconfirmed' : 'refused';
          outcome(
            phase === 'unconfirmed'
              ? KEYCLOAK_WRITE_AHEAD_OUTCOMES.UNCONFIRMED
              : KEYCLOAK_WRITE_AHEAD_OUTCOMES.REFUSED,
          );
          throw error;
        }
        phase = 'landed';
        return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.WRITTEN);
      },

      settle: async (error) => {
        if (phase === 'writing' || phase === 'unconfirmed') {
          // May land at any time: hold narrowing back until it no longer can.
          await this.markReassert(userId, 'unconfirmed');
        } else if (phase === 'landed') {
          // Keycloak holds less than the rows that did not commit: put the
          // rows back now, and leave the mark for the sweep if that fails.
          await this.markReassert(userId, 'rolled_back');
          await this.projectAfterCommit(userId);
        }
        if (phase === 'settling') return error;
        if (phase === 'writing' || phase === 'unconfirmed' || phase === 'refused') {
          return keycloakUnavailable(error);
        }
        return error;
      },
    };
  }

  /**
   * Compares what Keycloak holds with what it should, without writing.
   * Null when there is nothing to compare: no such user, or no account yet.
   */
  async reconcile(userId: string): Promise<ReconcileFinding | null> {
    const expected = await this.expectedAttributes(userId);
    if (!expected || !expected.keycloakId || !this.keycloak.enabled) return null;
    const account = await this.keycloak.getAccount(expected.keycloakId);
    // The platform's user status is the authority (ADR-060: Keycloak is a
    // projection): an account may be enabled only for an ACTIVE user whose
    // activation has landed.
    const shouldBeEnabled = expected.status === 'ACTIVE' && !expected.activationPending;
    return {
      userId,
      divergent: divergentAttributes(account.attributes, expected.attributes),
      activationPending: expected.activationPending,
      enabledDivergent:
        account.enabled === shouldBeEnabled
          ? null
          : { keycloakEnabled: account.enabled, platformStatus: expected.status },
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
    return this.repository.transaction(async (tx) => {
      const statuses = await this.repository.lockRegistrationRequestsOfUser(tx, userId);
      // The one lock of every Keycloak writer of the user, after the request
      // lock as an approval takes it (see the header).
      await this.repository.lockUserMemberships(tx, userId);
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
    }, PROJECTION_TRANSACTION_OPTIONS);
  }

  /**
   * Read the rows and write Keycloak **under the user lock** (see the header).
   *
   * Without it, two projections of one user — the request path and an event,
   * or two events on different partitions — could interleave as read(old),
   * read(new), write(new), write(old), leaving Keycloak on the older snapshot
   * with no event left to correct it; and a projection that read before a
   * narrowing change committed could write the old grant after that change's
   * write-ahead. Holding the lock from before the read until after the write
   * makes every write carry a snapshot at least as new as the one before it,
   * and the last write — which starts after the last change committed —
   * carries the newest. The lock is a database lock held by this transaction,
   * so it serialises across replicas and dies with the connection. It is the
   * lock a first activation needs as well (#219 r3), so it is taken before
   * the user is read, activation or not.
   *
   * The transaction outlives the Keycloak calls (three, or six on a first
   * activation, each bounded at 10 s by the client), so its timeout is set
   * above that. A projection that cannot get the lock in time fails and is retried
   * by its event, as any other failed projection is. A write whose answer was
   * lost marks the user for re-assertion (`markReassert`); one that lands
   * clears a mark that has passed.
   */
  private async write(userId: string): Promise<KeycloakProjectionOutcome> {
    if (!this.keycloak.enabled) return KEYCLOAK_PROJECTION_OUTCOMES.DISABLED;
    // Set when a write may have been sent and its answer never came.
    const writes = { unconfirmed: false, inFlight: 0 };
    const tracked = async (call: () => Promise<void>): Promise<void> => {
      writes.inFlight += 1;
      try {
        await call();
      } catch (error) {
        if (error instanceof KeycloakWriteUnconfirmedError) writes.unconfirmed = true;
        throw error;
      } finally {
        writes.inFlight -= 1;
      }
    };
    try {
      return await this.repository.transaction(async (tx) => {
        // First, before anything is read: the one lock of every writer.
        if (!(await this.repository.lockUserMemberships(tx, userId))) {
          return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
        }
        const user = await this.repository.findUserById(userId, tx);
        if (!user) return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
        // A registration not yet approved has no account: nothing to project into.
        if (!user.keycloakId) return KEYCLOAK_PROJECTION_OUTCOMES.NO_ACCOUNT;
        const keycloakId = user.keycloakId;
        // A first activation is decided on memberships no revocation can end
        // while it runs: the lock above is the one every membership change
        // takes first, so a revocation either committed before this read —
        // and there is no live membership to enable for — or waits until this
        // commits, and its own write-ahead then clears the grants (#219 r3).
        const memberships = await this.repository.listMembershipsForUser(userId, tx);
        const attributes = platformAttributesFor(user, memberships, new Date());
        await tracked(() => this.keycloak.replacePlatformAttributes(keycloakId, attributes));
        if (user.accountActivationPending) {
          await this.activateOnce(tx, user, keycloakId, attributes, tracked);
        }
        if (user.status !== 'ACTIVE') {
          await this.disableIfEnabled(user.id, keycloakId, tracked);
        }
        await this.repository.clearDueKeycloakReassert(tx, userId);
        return KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED;
      }, PROJECTION_TRANSACTION_OPTIONS);
    } catch (error) {
      if (writes.unconfirmed || writes.inFlight > 0) await this.markReassert(userId, 'unconfirmed');
      throw error;
    }
  }

  /**
   * Marks the user for re-assertion (`keycloak_reassert_at`): after
   * `KEYCLOAK_WRITE_SETTLE_SECONDS` for a write whose answer was lost, at once
   * for one that landed in a transaction that did not commit. Never throws —
   * the caller is already failing for its own reason — but a mark that cannot
   * be stored is logged and counted (`outcome="failed"`), and alerted on.
   */
  private async markReassert(userId: string, reason: 'unconfirmed' | 'rolled_back'): Promise<void> {
    const afterSeconds = reason === 'unconfirmed' ? this.options.writeSettleSeconds : 0;
    try {
      await this.repository.markKeycloakReassert(userId, afterSeconds);
      keycloakReassertMarksTotal.inc({ reason, outcome: 'recorded' });
    } catch (error) {
      keycloakReassertMarksTotal.inc({ reason, outcome: 'failed' });
      this.logger.error(
        `Could not mark user ${userId} for Keycloak re-assertion (${reason}); ` +
          `run keycloak:backfill once the database is back. ${describe(error)}`,
      );
    }
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
    tracked: (call: () => Promise<void>) => Promise<void>,
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
      await tracked(() => this.keycloak.activateAccount(keycloakId, registrationId));
    }
    await runUnscoped('the activation flag is the user row, not tenant data', () =>
      tx.user.update({
        where: { id: user.id },
        data: { accountActivationPending: false },
      }),
    );
  }

  /**
   * The platform's user status is the authority on whether an account may be
   * enabled (#219 r4, ADR-060: Keycloak is a projection). A user who is not
   * ACTIVE never keeps an enabled account: every projection of them disables
   * it. Only ever in that direction — a projection never enables an account
   * but once, on activation (`activateOnce`) — so an administrator's disable
   * is never undone, and a status change that commits after an activation is
   * carried to Keycloak by the projection that change triggers.
   */
  private async disableIfEnabled(
    userId: string,
    keycloakId: string,
    tracked: (call: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const account = await this.keycloak.getAccount(keycloakId);
    if (!account.enabled) return;
    await tracked(() => this.keycloak.setEnabled(keycloakId, false));
    this.logger.warn(
      { userId, keycloakId },
      'Account disabled: the platform user is not ACTIVE, and its status is the authority',
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
