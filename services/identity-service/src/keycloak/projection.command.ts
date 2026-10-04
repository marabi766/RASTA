import type { IdentityRepository } from '../identity/identity.repository';
import type { KeycloakAdminClient } from './keycloak.client';
import type { KeycloakProjector } from './keycloak.projector';
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
}

const PAGE = 200;

export async function runProjectionCommand(
  mode: ProjectionCommandMode,
  deps: {
    repository: Pick<IdentityRepository, 'listUserIdsWithAccount' | 'listUsersWithoutAccount'>;
    projector: Pick<KeycloakProjector, 'project' | 'reconcile' | 'repairOrphan'>;
    keycloak: Pick<KeycloakAdminClient, 'findAccountByUsername'>;
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
  return report;
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

/** Whether the report describes a clean, fully converged realm. */
export function isClean(report: ProjectionCommandReport): boolean {
  return (
    report.divergent.length === 0 &&
    report.failed.length === 0 &&
    report.activationPending.length === 0 &&
    report.enabledDivergent.length === 0 &&
    report.orphans.every((orphan) => orphan.repaired || (!orphan.enabled && !orphan.grants))
  );
}
