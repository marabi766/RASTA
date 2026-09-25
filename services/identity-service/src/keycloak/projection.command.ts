import type { IdentityRepository } from '../identity/identity.repository';
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
}

const PAGE = 200;

export async function runProjectionCommand(
  mode: ProjectionCommandMode,
  deps: {
    repository: Pick<IdentityRepository, 'listUserIdsWithAccount'>;
    projector: Pick<KeycloakProjector, 'project' | 'reconcile'>;
  },
): Promise<ProjectionCommandReport> {
  const report: ProjectionCommandReport = {
    mode,
    accounts: 0,
    divergent: [],
    projected: 0,
    failed: [],
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

  return report;
}

/** Whether the report describes a clean, fully converged realm. */
export function isClean(report: ProjectionCommandReport): boolean {
  return report.divergent.length === 0 && report.failed.length === 0;
}
