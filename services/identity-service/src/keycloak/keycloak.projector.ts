import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../identity/identity.repository';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import {
  KeycloakAdminClient,
  KeycloakWriteUnconfirmedError,
  type KeycloakAccount,
  type KeycloakWriteContext,
} from './keycloak.client';
import {
  KeycloakWriteFences,
  type KeycloakWriteAttempt,
  type KeycloakWriteFence,
} from './keycloak-write-fence';
import {
  divergentAttributes,
  grantsAnything,
  platformAttributesFor,
  provenanceOnly,
  sameAttributes,
  type PlatformAttributeName,
  type PlatformAttributes,
} from './platform-attributes';
import {
  KEYCLOAK_PROJECTION_OUTCOMES,
  KEYCLOAK_WRITE_AHEAD_OUTCOMES,
  keycloakProjectionsTotal,
  keycloakWriteAheadTotal,
  keycloakWriteFenceEventsTotal,
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
   * `KEYCLOAK_WRITE_SETTLE_SECONDS`: how long after its deadline a write whose
   * answer was lost may still be applied — so how long its fence stays live
   * and a narrowing change of that user is refused (D-064, D-069).
   */
  writeSettleSeconds: number;
}

/** The injection token of {@link KeycloakProjectorOptions}; the defaults stand in when absent. */
export const KEYCLOAK_PROJECTOR_OPTIONS = Symbol('KEYCLOAK_PROJECTOR_OPTIONS');

export const DEFAULT_KEYCLOAK_PROJECTOR_OPTIONS: KeycloakProjectorOptions = {
  writeSettleSeconds: 120,
};

/** How a projection may be asked for. */
export interface ProjectOptions {
  /**
   * Cancels the Keycloak calls in flight and refuses every further step: the
   * sweep's shutdown (#402 r1 F4). A write cut off mid-flight keeps its fence.
   */
  signal?: AbortSignal;
}

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
   * `committed` is what the rows grant after the change: when the two are the
   * same, the write's fence is deleted in this transaction, so with its commit.
   *
   * Refused, before anything is sent, while a fence of the user is live — an
   * earlier write that may still land could overtake this one (503
   * `KEYCLOAK_WRITE_SETTLING`, D-069). Proceeds without writing when there is
   * nothing to narrow: no account (`keycloakId` null — no token can exist), or
   * Keycloak answers 404 for it, or Keycloak sync is off (development and test
   * only; refused at boot elsewhere, `assertNarrowingEnforced`). Throws when
   * the write did not land; `settle` turns that into `KEYCLOAK_UNAVAILABLE`.
   */
  write(
    tx: ExtendedPrismaClient,
    attributes: PlatformAttributes,
    committed: PlatformAttributes,
  ): Promise<KeycloakWriteAheadOutcome>;
  /**
   * After the transaction committed: projects the full new state, which
   * takes over the write-ahead's fence when that write carried less than the
   * rows now grant (a mixed change: made due when it landed). Never throws.
   */
  afterCommit(): Promise<void>;
  /**
   * After the transaction failed: when the write landed, makes its fence due
   * and puts the rows back (Keycloak now holds less than they grant), and
   * returns what to throw —
   * `KEYCLOAK_UNAVAILABLE` when Keycloak was the reason, the error itself
   * otherwise. A write whose outcome is unknown keeps its fence, and the
   * sweep takes it over (D-069): nothing here is best-effort.
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

/**
 * 503 `KEYCLOAK_WRITE_SETTLING` (D-069): a narrowing change of this user was
 * refused before anything was sent, because an earlier Keycloak write of the
 * same user may still land and could overtake it. Keycloak itself may be
 * healthy; the refusal concerns this one user, for at most `retryAfterSeconds`
 * (`Retry-After`). Nothing committed, no event; the same request may be sent
 * again then. Only ever after the caller was authorized for the change.
 */
export function keycloakWriteSettling(retryAfterSeconds: number): RastaError {
  return new RastaError(
    ERROR_CODES.KEYCLOAK_WRITE_SETTLING,
    'An earlier identity-provider write of this user may still land; nothing was changed',
    {
      internalContext: { service: 'keycloak', operation: 'writeAhead', reason: 'settling' },
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    },
  );
}

/** Keycloak has no account under the id: there is nothing to write, and nothing can mint a token. */
function isAccountMissing(error: unknown): boolean {
  return error instanceof RastaError && error.code === ERROR_CODES.NOT_FOUND;
}

/**
 * The fenced Keycloak writes of one transaction that holds the user lock
 * (D-069). Each write opens its own attempt right before its PUT; an attempt
 * provably not applied is released at once, one whose outcome is unknown is
 * left in place, and one that landed is listed for the caller to settle.
 */
class FencedWrites {
  readonly landed: string[] = [];

  /**
   * Makes every attempt that landed due at once (`confirmLanded`): for a
   * transaction that will not delete them — it failed, or committed something
   * they do not carry. Not before the transaction's own `settle`.
   */
  async confirmLanded(): Promise<void> {
    if (this.landed.length === 0) return;
    const confirmed = await this.fences.confirmLanded(this.landed);
    keycloakWriteFenceEventsTotal.inc(
      { event: confirmed ? 'confirmed' : 'confirm_failed' },
      this.landed.length,
    );
  }

  constructor(
    private readonly fences: KeycloakWriteFences,
    private readonly tx: ExtendedPrismaClient,
    private readonly userId: string,
    private readonly timing: { timeoutMs: number; settleSeconds: number },
    readonly cancel: AbortSignal | undefined,
  ) {}

  async write(
    keycloakId: string,
    call: (context: KeycloakWriteContext) => Promise<void>,
  ): Promise<void> {
    let attempt: KeycloakWriteAttempt | null = null;
    const fence: KeycloakWriteFence = async (operation) => {
      if (attempt) throw new Error('one PUT per fenced write');
      attempt = await this.fences.open(this.tx, {
        userId: this.userId,
        keycloakId,
        operation,
        ...this.timing,
        cancel: this.cancel,
      });
      keycloakWriteFenceEventsTotal.inc({ event: 'opened' });
      return attempt;
    };
    try {
      await call({ fence, cancel: this.cancel });
    } catch (error) {
      const opened = attempt as KeycloakWriteAttempt | null;
      // Provably not applied — never sent, refused, 404, its deadline passed
      // before dispatch: nothing can land, so its fence goes now. Unknown: it
      // stays, and holds narrowing back until the sweep takes it over.
      if (opened && !(error instanceof KeycloakWriteUnconfirmedError)) {
        const released = await this.fences.release(opened.id);
        keycloakWriteFenceEventsTotal.inc({ event: released ? 'released' : 'release_failed' });
      }
      throw error;
    }
    const opened = attempt as KeycloakWriteAttempt | null;
    if (opened) this.landed.push(opened.id);
  }
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
 * Every write of a user's account — a narrowing change's write-ahead, a
 * projection after a request, the consumer's backstop, the backfill, the
 * re-assertion sweep, a first activation, an approval's adoption, the orphan
 * repair — happens in a transaction that took that user's row lock
 * (`lockUserMemberships`) **before it read** what it writes, and holds it
 * until after the write. Membership changes take the same lock first, so a
 * write always carries rows that were current while it was made. Locks are
 * always taken in one order — a registration request (an approval, the orphan
 * repair), then the user, then their memberships, then the outbox stream
 * counter — so this lock adds no cycle.
 *
 * ## The in-flight fence (D-069)
 *
 * Aborting a request does not cancel it: a write past its deadline, cut off
 * mid-answer or answered 5xx may be applied by Keycloak later, after a newer
 * write. So before **every** PUT, the writer commits a fence row for that one
 * attempt on its own connection pool (`KeycloakWriteFences`), and only a
 * confirmed outcome removes it — never a rollback, a timeout or an exit. Every
 * writer reads the user's fences under the user lock, on the database's clock
 * read after it:
 *
 * - a narrowing change refuses while one is **live** (503
 *   `KEYCLOAK_WRITE_SETTLING`): it could not be the last write;
 * - a first activation waits while one is live: a late disable or clear could
 *   land after the enable and leave an approved account unusable;
 * - a projection whose writes all landed deletes, with its commit, its own
 *   fences and every one that was already **due** — past `takeover_at`, or
 *   landed and confirmed by its owner — when it read them: its write of the
 *   committed state is the re-assertion that takes them over. The sweep runs
 *   one for every user with a due fence.
 *
 * What remains is stated in ADR-060's D-069 addendum: a sender paused between
 * its final deadline check and the socket write for longer than the settle
 * window, or a request delivered later than that.
 */
@Injectable()
export class KeycloakProjector {
  private readonly logger = new Logger(KeycloakProjector.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
    private readonly fences: KeycloakWriteFences,
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
      attributes: platformAttributesFor(
        user,
        memberships,
        await this.repository.databaseNow(this.repository.client),
      ),
      activationPending: user.accountActivationPending,
      status: user.status,
    };
  }

  /**
   * Rebuilds and writes one user's platform attributes. Throws if a write
   * does not land.
   */
  async project(
    userId: string,
    trigger: KeycloakProjectionTrigger,
    options: ProjectOptions = {},
  ): Promise<KeycloakProjectionOutcome> {
    const outcome = await this.write(userId, options).catch((error: unknown) => {
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
  async projectAfterCommit(userId: string, options: ProjectOptions = {}): Promise<void> {
    try {
      await this.project(userId, 'request', options);
    } catch (error) {
      this.logger.error(
        `Keycloak projection failed for user ${userId}; the identity event will retry it. ` +
          `Until then their token does not match their memberships. ${describe(error)}`,
      );
    }
  }

  /**
   * Starts one narrowing change's write-ahead (D-064, D-069). The caller holds
   * the user lock in its transaction, computes the attributes from rows read
   * under it on the database's clock, calls `write` before it enqueues its
   * event, `afterCommit` once it committed, and passes any failure of the
   * transaction through `settle`.
   */
  narrowing(userId: string, options: { signal?: AbortSignal } = {}): NarrowingWriteAhead {
    /**
     * idle → writing → landed | unconfirmed | refused | absent, or settling
     * when refused before writing. `writing` that outlives the transaction —
     * it timed out with the call in flight — counts as unconfirmed.
     */
    let phase: 'idle' | 'writing' | 'landed' | 'unconfirmed' | 'refused' | 'absent' | 'settling' =
      'idle';
    /** The write's attempts once it landed; empty when there was none to fence. */
    let writes: FencedWrites | null = null;
    const outcome = (value: KeycloakWriteAheadOutcome) => {
      keycloakWriteAheadTotal.inc({ outcome: value });
      return value;
    };

    return {
      write: async (tx, attributes, committed) => {
        if (phase !== 'idle') throw new Error('one write-ahead per narrowing change');
        if (!this.keycloak.enabled) return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.DISABLED);
        options.signal?.throwIfAborted();
        const now = await this.repository.databaseNow(tx);
        const user = await this.repository.findUserById(userId, tx);
        // No account: nothing was ever enabled to sign in with, so no token of
        // this user exists to narrow (an approval links the account in the
        // transaction that activates it).
        if (!user?.keycloakId) return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.NO_ACCOUNT);
        const keycloakId = user.keycloakId;
        // Read under the user lock: every fence of every write that can be in
        // flight for this user is here (`KeycloakWriteFences.open`). Decided
        // only now, after the caller authorized the change under that lock.
        const live = (await this.fences.ofUser(tx, userId, now)).filter((fence) => fence.live);
        if (live.length > 0) {
          phase = 'settling';
          outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.SETTLING);
          throw keycloakWriteSettling(Math.max(...live.map((fence) => fence.settlesInSeconds)));
        }
        phase = 'writing';
        const fenced = this.fencedWrites(tx, userId, options.signal);
        writes = fenced;
        try {
          await fenced.write(keycloakId, (context) =>
            this.keycloak.replacePlatformAttributes(keycloakId, attributes, context),
          );
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
        if (sameAttributes(attributes, committed)) {
          // Landed, and carrying exactly what this transaction commits: the
          // fence goes with the commit, and stays if it rolls back.
          await this.fences.settle(tx, userId, fenced.landed);
        } else {
          // A mixed change: less than the rows grant after it. Landed, so it
          // can no longer land: due now, taken over by the projection after
          // commit (or the sweep's). Before this transaction's last statement.
          await fenced.confirmLanded();
        }
        return outcome(KEYCLOAK_WRITE_AHEAD_OUTCOMES.WRITTEN);
      },

      afterCommit: async () => {
        await this.projectAfterCommit(userId, { signal: options.signal });
      },

      settle: async (error) => {
        if (phase === 'landed' && writes) {
          // Keycloak holds less than the rows that did not commit. The write
          // landed, so it cannot land again: due now (its delete rolled back
          // with the rest), and the rows are put back at once.
          await writes.confirmLanded();
          await this.projectAfterCommit(userId, { signal: options.signal });
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
   * is held, each fenced (D-069). So an approval that adopts the account
   * either committed first (and this finds it owned) or waits for this to
   * finish, and its projection then enables the account. Throws when Keycloak
   * cannot be reached.
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

      const writes = this.fencedWrites(tx, userId);
      await this.makeHarmless(writes, userId, account);
      // Harmless is what an account no user row names should be: the writes
      // carried the committed state, and their fences go with this commit.
      await this.fences.settle(tx, userId, writes.landed);
      this.logger.warn(
        { userId, keycloakId: account.id },
        'Orphan Keycloak account disabled and its grants cleared',
      );
      return 'repaired';
    }, PROJECTION_TRANSACTION_OPTIONS);
  }

  /**
   * An approval adopting its request's own earlier account (#219 r3), in the
   * approval's transaction, under the request lock and the user lock: disabled
   * and its grants cleared when it carries any, each write fenced (D-069).
   * Every attempt that landed is made due at once, even when a later one
   * fails: the approval commits ACTIVE, which those writes do not carry, so
   * whichever way it ends its projection after commit — or the sweep's —
   * takes them over. Returns whether anything was written.
   */
  async adoptHarmless(
    tx: ExtendedPrismaClient,
    userId: string,
    account: KeycloakAccount,
  ): Promise<boolean> {
    if (!account.enabled && !grantsAnything(account.attributes)) return false;
    const writes = this.fencedWrites(tx, userId);
    try {
      await this.makeHarmless(writes, userId, account);
    } finally {
      await writes.confirmLanded();
    }
    return true;
  }

  /** Disabled, then cleared to its provenance: two fenced writes, the disable first. */
  private async makeHarmless(
    writes: FencedWrites,
    userId: string,
    account: KeycloakAccount,
  ): Promise<void> {
    if (account.enabled) {
      await writes.write(account.id, (context) => this.keycloak.disable(account.id, context));
    }
    await writes.write(account.id, (context) =>
      this.keycloak.replacePlatformAttributes(account.id, provenanceOnly(userId), context),
    );
  }

  private fencedWrites(tx: ExtendedPrismaClient, userId: string, cancel?: AbortSignal) {
    return new FencedWrites(
      this.fences,
      tx,
      userId,
      {
        timeoutMs: this.keycloak.requestTimeoutMs,
        settleSeconds: this.options.writeSettleSeconds,
      },
      cancel,
    );
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
   * Every validity decision is made on the database's clock read after the
   * lock (#402 r1 F3). Every PUT is fenced (D-069); the fences this projection
   * may delete are listed in the header, and are deleted as its last
   * statements, so with its commit. An account Keycloak no longer has (404) is
   * `account_missing`: the due fences of it become terminal, and are alerted
   * on.
   *
   * The transaction outlives the Keycloak calls (three, or six on a first
   * activation, each bounded at 10 s by the client), so its timeout is set
   * above that. A projection that cannot get the lock in time fails and is
   * retried by its event, as any other failed projection is.
   */
  private async write(userId: string, options: ProjectOptions): Promise<KeycloakProjectionOutcome> {
    if (!this.keycloak.enabled) return KEYCLOAK_PROJECTION_OUTCOMES.DISABLED;
    const { signal } = options;
    signal?.throwIfAborted();
    let missing: string[] = [];
    let writes: FencedWrites | null = null;
    const outcome = await this.repository
      .transaction(async (tx) => {
        // First, before anything is read: the one lock of every writer.
        if (!(await this.repository.lockUserMemberships(tx, userId))) {
          return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
        }
        // The clock every decision below is made on — a later statement than
        // the lock, so it cannot be older than the wait for it.
        const now = await this.repository.databaseNow(tx);
        const user = await this.repository.findUserById(userId, tx);
        if (!user) return KEYCLOAK_PROJECTION_OUTCOMES.NO_USER;
        const fences = await this.fences.ofUser(tx, userId, now);
        // Due now, so due before any write below is sent: no write of theirs
        // can land after ours, and ours carries the committed state. Terminal
        // ones (`account_missing`) too: past takeover like any due fence, they
        // only wait for an account to write to — the sweep no longer retries
        // them, but a projection that lands (the account restored, or the
        // user linked to another) takes them over like the rest.
        const due = fences.filter((fence) => !fence.live);
        // Live: may still land.
        const uncertain = fences.filter((fence) => fence.live);
        const fenced = this.fencedWrites(tx, userId, signal);
        writes = fenced;
        const linked = user.keycloakId;

        // Fences of an account the user does not (or no longer) link: an
        // approval's adoption that did not commit, or an orphan repair. What it
        // should hold is harmless.
        const others = due.filter((fence) => fence.keycloakId !== linked);
        for (const keycloakId of new Set(others.map((fence) => fence.keycloakId))) {
          await this.reassertUnlinked(fenced, userId, keycloakId, signal);
        }
        const takenOver = due.map((fence) => fence.attemptId);

        // A registration not yet approved has no account: nothing to project into.
        if (!linked) {
          signal?.throwIfAborted();
          await this.fences.settle(tx, userId, [...fenced.landed, ...takenOver]);
          return KEYCLOAK_PROJECTION_OUTCOMES.NO_ACCOUNT;
        }
        // A first activation is decided on memberships no revocation can end
        // while it runs: the lock above is the one every membership change
        // takes first, so a revocation either committed before this read —
        // and there is no live membership to enable for — or waits until this
        // commits, and its own write-ahead then clears the grants (#219 r3).
        const memberships = await this.repository.listMembershipsForUser(userId, tx);
        const attributes = platformAttributesFor(user, memberships, now);
        try {
          await fenced.write(linked, (context) =>
            this.keycloak.replacePlatformAttributes(linked, attributes, context),
          );
        } catch (error) {
          if (!isAccountMissing(error)) throw error;
          missing = due
            .filter((fence) => fence.keycloakId === linked && !fence.accountMissing)
            .map((fence) => fence.attemptId);
          // An unlinked account's repair that landed above: due, for the sweep.
          await fenced.confirmLanded();
          return KEYCLOAK_PROJECTION_OUTCOMES.ACCOUNT_MISSING;
        }
        signal?.throwIfAborted();
        if (user.accountActivationPending) {
          await this.activateOnce(tx, user, linked, attributes, fenced, uncertain.length, signal);
        }
        if (user.status !== 'ACTIVE') {
          await this.disableIfEnabled(user.id, linked, fenced, signal);
        }
        signal?.throwIfAborted();
        // Every write landed and carried the committed state: its own fences
        // and the due ones go with this commit — and stay if it does not
        // commit. The last fence statement of this transaction.
        await this.fences.settle(tx, userId, [...fenced.landed, ...takenOver]);
        return KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED;
      }, PROJECTION_TRANSACTION_OPTIONS)
      .catch(async (error: unknown) => {
        // Did not commit: what landed can no longer land, so it is due now and
        // holds nothing back; the sweep re-asserts it. Not when cancelled — a
        // stop starts nothing more (#402 r1 F4); those stay live until takeover.
        const current = writes as FencedWrites | null;
        if (current && !signal?.aborted) await current.confirmLanded();
        throw error;
      });

    if (missing.length > 0) {
      // Terminal: there is nothing to re-assert into, and nothing can mint a
      // token for it. Recorded on the fence pool, counted and alerted on.
      await this.fences.markAccountMissing(missing);
      keycloakWriteFenceEventsTotal.inc({ event: 'account_missing' }, missing.length);
      this.logger.error(
        { userId, fences: missing.length },
        'Keycloak has no account for this user any more; its write fences are terminal ' +
          '(account_missing) and need an operator',
      );
    } else if (outcome === KEYCLOAK_PROJECTION_OUTCOMES.ACCOUNT_MISSING) {
      this.logger.warn({ userId }, 'Keycloak has no account for this user; nothing projected');
    }
    return outcome;
  }

  /**
   * Re-asserts an account the user does not link (D-069 takeover): harmless —
   * disabled, granting nothing — when its provenance names them and it is not.
   * Gone (404) or not theirs: nothing to write.
   */
  private async reassertUnlinked(
    writes: FencedWrites,
    userId: string,
    keycloakId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let account: KeycloakAccount;
    try {
      account = await this.keycloak.getAccount(keycloakId, signal);
    } catch (error) {
      if (isAccountMissing(error)) return;
      throw error;
    }
    signal?.throwIfAborted();
    const provenance = account.attributes.rasta_user_id;
    if (provenance.length !== 1 || provenance[0] !== userId) return;
    if (!account.enabled && !grantsAnything(account.attributes)) return;
    await this.makeHarmless(writes, userId, account);
  }

  /**
   * Enables a provisioned account — once, provably (#219 r3).
   *
   * Runs in the projection's transaction, after the grants are written, so the
   * account's first token is already right. Three outcomes, and a fourth while
   * an earlier write of the user may still land (`inFlight`, D-069):
   *
   * - **Already activated.** The account carries `rasta_activation`: an
   *   earlier attempt's enable landed, whatever became of its answer or of the
   *   transaction that would have cleared the flag. It is never enabled again
   *   — an account an administrator has disabled since stays disabled — and
   *   only the flag is cleared.
   * - **Activated now.** The user's provisioning is decided — the registration
   *   request APPROVED, or the user created by an operator, who has no request
   *   (`findActivationSource`) — the user ACTIVE and holding a live membership
   *   (read under the user row lock): `enabled: true` and the marker are
   *   written in one representation update, then the flag is cleared. A lost
   *   answer leaves the flag set, and the next attempt finds the marker.
   * - **Withheld.** Any of those conditions does not hold: nothing is enabled
   *   and nothing cleared, so reconcile keeps reporting the user
   *   (`activationPending`) for an operator to decide. Logged by ids only.
   * - **Deferred.** It would enable now, but a fence of the user is live: a
   *   late disable or clear could land after the enable and leave the account
   *   unusable with its flag cleared. Nothing is sent or cleared; the sweep
   *   projects the user again once those fences are due, and activates then.
   *   Only the enable waits: an account that already carries the marker sends
   *   nothing, and has its flag cleared at once.
   */
  private async activateOnce(
    tx: ExtendedPrismaClient,
    user: { id: string; status: string },
    keycloakId: string,
    attributes: PlatformAttributes,
    writes: FencedWrites,
    inFlight: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const account = await this.keycloak.getAccount(keycloakId, signal);
    signal?.throwIfAborted();
    if (account.activation === null) {
      const activationId = await this.repository.findActivationSource(tx, user.id);
      const withheld = !activationId
        ? 'no_activation_source'
        : user.status !== 'ACTIVE'
          ? 'user_not_active'
          : attributes.organization_ids.length === 0
            ? 'no_live_membership'
            : null;
      if (!activationId || withheld !== null) {
        this.logger.warn(
          { userId: user.id, keycloakId, reason: withheld },
          'Account activation withheld; the account stays disabled and reconcile reports it',
        );
        return;
      }
      if (inFlight > 0) {
        this.logger.warn(
          { userId: user.id, keycloakId, inFlight },
          'Account activation deferred until earlier Keycloak writes of it can no longer land',
        );
        return;
      }
      await writes.write(keycloakId, (context) =>
        this.keycloak.activateAccount(keycloakId, activationId, context),
      );
      signal?.throwIfAborted();
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
    writes: FencedWrites,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const account = await this.keycloak.getAccount(keycloakId, signal);
    signal?.throwIfAborted();
    if (!account.enabled) return;
    await writes.write(keycloakId, (context) => this.keycloak.disable(keycloakId, context));
    this.logger.warn(
      { userId, keycloakId },
      'Account disabled: the platform user is not ACTIVE, and its status is the authority',
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
