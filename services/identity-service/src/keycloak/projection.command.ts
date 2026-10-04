import type { IdentityRepository } from '../identity/identity.repository';
import type { KeycloakAdminClient } from './keycloak.client';
import type { KeycloakProjector } from './keycloak.projector';
import type { PlatformAttributeName } from './platform-attributes';

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
 * Both also sweep for **orphans**: an account no user row points at, left by a
 * registration approval whose database write failed after Keycloak had
 * created it (`IdentityService.approveRegistration`). The approval disables
 * such an account and clears its grants on the way out, but when Keycloak
 * cannot be reached then it stays as created — enabled, with the roles of an
 * approval that never happened. The sweep looks up, by username, each user
 * that has no account, and reports an account whose `rasta_user_id` names that
 * user. One still enabled or still carrying an organization or role makes the
 * report unclean; a disabled one with no grants is what a pending request
 * looks like after a failed approval, and the next approval adopts it.
 * Nothing is written for an orphan in either mode: disabling one an approval
 * could not is an operator's step (`docs/runbooks/keycloak-projection.md`).
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
  /** Either mode: accounts no user row points at, by user id and Keycloak id. */
  orphans: { userId: string; keycloakId: string; enabled: boolean; grants: boolean }[];
}

const PAGE = 200;

export async function runProjectionCommand(
  mode: ProjectionCommandMode,
  deps: {
    repository: Pick<IdentityRepository, 'listUserIdsWithAccount' | 'listUsersWithoutAccount'>;
    projector: Pick<KeycloakProjector, 'project' | 'reconcile'>;
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
        const { organization_ids, organization_roles, active_organization_id } = account.attributes;
        report.orphans.push({
          userId: user.id,
          keycloakId: account.id,
          enabled: account.enabled,
          grants:
            organization_ids.length + organization_roles.length + active_organization_id.length > 0,
        });
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
    report.orphans.every((orphan) => !orphan.enabled && !orphan.grants)
  );
}
