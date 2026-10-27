import type { IdentityRepository } from '../identity/identity.repository';
import type { PrismaService } from '../prisma/prisma.service';
import type { KeycloakAdminClient } from './keycloak.client';
import { settleRecoveryProjections, type KeycloakProjector } from './keycloak.projector';
import type { KeycloakWriteFences } from './keycloak-write-fence';
import { grantsAnything, type PlatformAttributeName } from './platform-attributes';

/**
 * Backfill and reconcile for the Keycloak projection (ADR-060 § 5, migration
 * step 2).
 *
 * - **reconcile** reads every account's platform attributes from Keycloak and
 *   compares them with what the database says they should be. It writes
 *   nothing. The ADR's gate is this report: the guard that reads `org_roles`
 *   (migration step 3) does not ship while it shows any divergence.
 * - **backfill** projects every account, whatever Keycloak currently holds —
 *   the first run after this change, and the repair after any outage the
 *   event path could not cover.
 *
 * Both also sweep for **orphans**: an account no user row points at, under
 * the username of a user who has none, whose `rasta_user_id` names that user —
 * what a registration approval leaves when its transaction does not commit, or
 * when Keycloak's answer to its create was lost (#219 r2). The approval creates
 * it disabled and granting nothing, so such an account is harmless and the
 * request's next approval adopts it; it is reported, and the report stays
 * clean. One that is enabled or carries a grant makes reconcile unclean, and
 * backfill repairs it: disabled and its grants cleared, **kept, not deleted**
 * (`KeycloakProjector.repairOrphan`, under the registration request's lock).
 *
 * And for **pending activations**: an approval committed, but the projection
 * that enables its account has not landed yet. Reconcile reports them as
 * unclean; backfill's projection enables them.
 *
 * And for **enabled-state divergence** (#219 r4, D-049): the platform's user
 * status is the authority on whether an account may sign in. Reconcile
 * reports an account enabled for a user who is not ACTIVE, or disabled for an
 * ACTIVE one (a disable made in the Keycloak console, not the platform), as
 * unclean. Backfill disables the first; the second is left to an operator.
 *
 * And for **write fences** (D-069, #402 r2 F3): backfill ends with a drain of
 * every row of `keycloak_write_attempt` — every user that owns one, paged
 * past any page size, linked to an account or not, whether the fence is due,
 * waiting out a retry or terminal — by projecting that user, which takes over
 * every fence that is no longer live (`KeycloakProjector.write`). An unlinked
 * user's projection makes the account its fences addressed harmless and
 * clears them; a repaired orphan's earlier attempts go the same way. Then it
 * counts **every** row (`COUNT(attempt_id)`): the report says how many are left, and is
 * clean only at zero — the one state in which the migration's `down.sql`
 * accepts a rollback. A live fence (a writer still running, or not yet past
 * takeover) or a terminal one whose account is still missing keeps it unclean.
 * Reconcile counts them too, without draining.
 *
 * A late write of either mode (D-070 option D) leaves a fresh fence and a
 * recovery projection running in the background: before the count, the
 * command waits for those projections (at most {@link RECOVERY_SETTLE_MS}),
 * then **cancels** any still running and waits for them to unwind (at most
 * {@link RECOVERY_STOP_MS}; `KeycloakProjector.cancelRecoveries`, #458 r1 F2) —
 * so none of them reaches the database once the command disconnects; one
 * still unwinding then is reported (`fences.recoveriesAbandoned`, clean only
 * at zero). Then it writes every fresh fence still owed (`fences.owed`, clean
 * only at zero) — so neither is lost when the command disconnects, and the
 * count sees them.
 *
 * Separated from the CLI entry point so the sweep itself is tested without a
 * database or a Keycloak.
 */
export type ProjectionCommandMode = 'reconcile' | 'backfill';

export interface ProjectionCommandReport {
  mode: ProjectionCommandMode;
  accounts: number;
  /** reconcile: accounts whose attributes disagree with the database. */
  divergent: { userId: string; attributes: PlatformAttributeName[] }[];
  /** backfill: accounts written. */
  projected: number;
  /** Either mode: accounts that could not be read or written, by user id. */
  failed: string[];
  /**
   * Either mode: accounts no user row points at, by user id and Keycloak id,
   * as found. `repaired`: backfill disabled it and cleared its grants.
   */
  orphans: {
    userId: string;
    keycloakId: string;
    enabled: boolean;
    grants: boolean;
    repaired: boolean;
  }[];
  /** reconcile: users whose approved account has not been enabled yet. */
  activationPending: string[];
  /**
   * reconcile: accounts whose Keycloak `enabled` disagrees with the platform's
   * user status (#219 r4, D-049) — enabled for a user who is not ACTIVE, or
   * disabled for an ACTIVE user, typically from the Keycloak console. By id.
   * Backfill disables the first kind; the second is an operator's decision:
   * nothing here enables an account but its one activation.
   */
  enabledDivergent: { userId: string; keycloakEnabled: boolean; platformStatus: string }[];
  /**
   * Either mode: Keycloak write fences (D-069). `drained`: backfill projected
   * this many fence owners in its drain. `outstanding` is `COUNT(attempt_id)` over
   * `keycloak_write_attempt` after it — every row, whatever its state — and
   * the report is clean, and a rollback of the fence migration ready, only at
   * zero. `live`, `due` and `accountMissing` say why any are left. `owed`:
   * late writes' fresh fences (D-070 D) this command could not write before
   * it ends — clean only at zero. `recoveriesAbandoned`: late writes'
   * recovery projections cancelled at the end and still unwinding when the
   * command stopped waiting — they start nothing more; clean only at zero.
   */
  fences: {
    drained: number;
    owed: number;
    recoveriesAbandoned: number;
    outstanding: number;
    live: number;
    due: number;
    accountMissing: number;
  };
}

const PAGE = 200;

/** How long the command waits for late writes' recovery projections (D-070 D) before it counts. */
export const RECOVERY_SETTLE_MS = 30_000;

/** How long cancelled recovery projections are waited for to unwind, before the command counts. */
export const RECOVERY_STOP_MS = 5_000;

/**
 * The command's teardown, whatever ended it (#458 r1/r2 F2): its projector
 * stops first — no recovery starts any more, those running are cancelled
 * and waited for, a COMMIT of theirs included — and the pools close last,
 * by the same deadline: each waits for a transaction still in flight, then
 * refuses everything and disconnects. What was still unwinding or unsettled
 * at the deadline is returned, for the command to report unclean.
 */
export async function tearDownProjectionCommand(
  deps: {
    projector?: Pick<KeycloakProjector, 'stop'>;
    pools: ReadonlyArray<Pick<PrismaService, 'stop'>>;
  },
  deadlineAt: number,
): Promise<{ recoveriesUnwinding: number; transactionsUnsettled: number }> {
  const recoveriesUnwinding = (await deps.projector?.stop({ deadlineAt })) ?? 0;
  const unsettled = await Promise.all(deps.pools.map((pool) => pool.stop({ deadlineAt })));
  return {
    recoveriesUnwinding,
    transactionsUnsettled: unsettled.reduce((sum, count) => sum + count, 0),
  };
}

export async function runProjectionCommand(
  mode: ProjectionCommandMode,
  deps: {
    repository: Pick<IdentityRepository, 'listUserIdsWithAccount' | 'listUsersWithoutAccount'>;
    projector: Pick<
      KeycloakProjector,
      'project' | 'reconcile' | 'repairOrphan' | 'cancelRecoveries'
    >;
    keycloak: Pick<KeycloakAdminClient, 'findAccountByUsername'>;
    fences: Pick<KeycloakWriteFences, 'owners' | 'counts' | 'recoverOwed'>;
  },
): Promise<ProjectionCommandReport> {
  const report: ProjectionCommandReport = {
    mode,
    accounts: 0,
    divergent: [],
    projected: 0,
    failed: [],
    orphans: [],
    activationPending: [],
    enabledDivergent: [],
    fences: {
      drained: 0,
      owed: 0,
      recoveriesAbandoned: 0,
      outstanding: 0,
      live: 0,
      due: 0,
      accountMissing: 0,
    },
  };

  let after: string | null = null;
  for (;;) {
    const page = await deps.repository.listUserIdsWithAccount(after, PAGE);
    if (page.length === 0) break;

    for (const userId of page) {
      report.accounts += 1;
      try {
        if (mode === 'backfill') {
          if ((await deps.projector.project(userId, 'command')) === 'projected') {
            report.projected += 1;
          }
        } else {
          const finding = await deps.projector.reconcile(userId);
          if (finding && finding.divergent.length > 0) {
            report.divergent.push({ userId, attributes: finding.divergent });
          }
          if (finding?.activationPending) report.activationPending.push(userId);
          if (finding?.enabledDivergent) {
            report.enabledDivergent.push({ userId, ...finding.enabledDivergent });
          }
        }
      } catch {
        // One unreachable account must not hide the state of every other. It
        // is reported by id, and the command's exit status reflects it.
        report.failed.push(userId);
      }
    }

    after = page[page.length - 1]!;
  }

  await sweepOrphans(report, deps);
  if (mode === 'backfill') await drainFences(report, deps);
  // Late writes' recoveries (D-070 D), before the count and the disconnect:
  // their projections given time to finish, then the rest cancelled — they
  // start nothing more — and waited for to unwind (#458 r1 F2); then their
  // fresh fences written, a cancelled recovery's own late write's included.
  await settleRecoveryProjections(RECOVERY_SETTLE_MS);
  report.fences.recoveriesAbandoned = await deps.projector.cancelRecoveries({
    deadlineAt: Date.now() + RECOVERY_STOP_MS,
  });
  report.fences.owed = await deps.fences.recoverOwed();
  // Every row, whatever its state: an empty page of anything is not proof.
  const counts = await deps.fences.counts();
  report.fences.outstanding = counts.total;
  report.fences.live = counts.live;
  report.fences.due = counts.due;
  report.fences.accountMissing = counts.accountMissing;
  return report;
}

/**
 * Projects every user that still owns a write fence after the passes above
 * — one walk by user id, paged, over every row's owner, so none is skipped
 * for having no account, a retry deadline or a terminal fence. Each
 * projection takes over the user's fences that are no longer live.
 */
async function drainFences(
  report: ProjectionCommandReport,
  deps: {
    projector: Pick<KeycloakProjector, 'project'>;
    fences: Pick<KeycloakWriteFences, 'owners'>;
  },
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const page = await deps.fences.owners(after, PAGE);
    if (page.length === 0) break;
    for (const userId of page) {
      report.fences.drained += 1;
      try {
        await deps.projector.project(userId, 'command');
      } catch {
        if (!report.failed.includes(userId)) report.failed.push(userId);
      }
    }
    after = page.at(-1) ?? null;
    if (after === null) break;
  }
}

async function sweepOrphans(
  report: ProjectionCommandReport,
  deps: {
    repository: Pick<IdentityRepository, 'listUsersWithoutAccount'>;
    projector: Pick<KeycloakProjector, 'repairOrphan'>;
    keycloak: Pick<KeycloakAdminClient, 'findAccountByUsername'>;
  },
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const page = await deps.repository.listUsersWithoutAccount(after, PAGE);
    if (page.length === 0) break;

    for (const user of page) {
      try {
        const account = await deps.keycloak.findAccountByUsername(user.username);
        const provenance = account?.attributes.rasta_user_id ?? [];
        if (!account || provenance.length !== 1 || provenance[0] !== user.id) continue;
        const orphan = {
          userId: user.id,
          keycloakId: account.id,
          enabled: account.enabled,
          grants: grantsAnything(account.attributes),
          repaired: false,
        };
        report.orphans.push(orphan);
        if (report.mode === 'backfill' && (orphan.enabled || orphan.grants)) {
          // Decided again under the request's lock: what was read above may
          // have changed, and an approval may have adopted the account since.
          orphan.repaired =
            (await deps.projector.repairOrphan(user.id, user.username)) === 'repaired';
        }
      } catch {
        report.failed.push(user.id);
      }
    }

    // A non-empty page, so it has a last entry.
    after = page.at(-1)?.id ?? null;
    if (after === null) break;
  }
}

/**
 * Whether the report describes a clean, fully converged realm — with no
 * Keycloak write fence left at all (`fences.outstanding`, an explicit
 * `COUNT(attempt_id)`), which is also what a rollback of the fence migration needs.
 */
export function isClean(report: ProjectionCommandReport): boolean {
  return (
    report.divergent.length === 0 &&
    report.failed.length === 0 &&
    report.activationPending.length === 0 &&
    report.enabledDivergent.length === 0 &&
    report.orphans.every((orphan) => orphan.repaired || (!orphan.enabled && !orphan.grants)) &&
    report.fences.outstanding === 0 &&
    report.fences.owed === 0 &&
    report.fences.recoveriesAbandoned === 0
  );
}
