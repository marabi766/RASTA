import { FleetRepository } from './fleet.repository';

/**
 * Empties the insurance windows (and the retained-coverage list) of every machine that has ever been
 * transferred (docs/24 Q-101, runbook `insurance-reprojection.md`, "changing
 * the following-coverage list").
 *
 * ## Why it exists
 *
 * Which coverages follow a vehicle across a transfer is asset-service's
 * setting (`INSURANCE_COVERAGES_FOLLOWING_VEHICLE`). A transfer keeps the
 * windows of the coverages that followed *at the time*. Narrowing the setting
 * afterwards would otherwise leave the windows it no longer lets follow in
 * force for the new owner, and widening it would leave out ones it now lets
 * follow. Neither is a live code path: the change is an operational one, and
 * this command is its first half. The second is `insurance:reproject` in
 * asset-service, run straight after with `--reissue` (it generates its own fresh run id), which says
 * every window again under today's rule. Between the two the machines concerned
 * are refused for dispatch: fail closed.
 *
 * ## What makes it safe
 *
 *   - **Only windows and the retained list.** Lapses, the ownership generation
 *     and every other column stay; `synced_at` moves. The retained list goes
 *     with the windows: a delayed old-owner `INSURANCE_RECORDED` for a coverage
 *     that followed at transfer time would otherwise still be exempted from the
 *     owner check and restore a window for the new owner. After the clear only
 *     the current owner's events (or ones at/after the replica's generation)
 *     apply, and a re-projection emits with the current owner.
 *   - **Under the asset's lock.** The page only names candidates; each row is
 *     decided again under {@link FleetRepository.lockAssetRef}, in its own page
 *     transaction, so an event or a transfer that committed since is seen.
 *   - **Bounded.** Keyset pages of `pageSize`, one short transaction each.
 *   - **Tenant-correct.** `organizationId` limits the run to machines that
 *     organization owns now; the counts are per **current** owner.
 */

export const MAX_PAGE_SIZE = 500;

export interface ClearTransferredOptions {
  /** Count what would be cleared and write nothing. */
  readonly dryRun: boolean;
  /** Also rows whose generation is unknown: after a rollback of the generation migration. */
  readonly includeUnknownGeneration: boolean;
  /** Only machines this organization owns now. Omitted: every organization. */
  readonly organizationId?: string;
  /** Rows decided per transaction. */
  readonly pageSize: number;
}

export interface ClearTransferredReport {
  dryRun: boolean;
  /** Rows that qualified when the page was read. */
  scanned: number;
  /** Rows whose windows were emptied (in a dry run, would be). */
  cleared: number;
  /** Rows that no longer qualified under the lock. */
  skipped: number;
  /** Per current owner. */
  byOrganization: Record<string, number>;
}

export async function clearTransferredInsurance(
  repository: FleetRepository,
  options: ClearTransferredOptions,
): Promise<ClearTransferredReport> {
  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const report: ClearTransferredReport = {
    dryRun: options.dryRun,
    scanned: 0,
    cleared: 0,
    skipped: 0,
    byOrganization: {},
  };
  const filter = {
    includeUnknownGeneration: options.includeUnknownGeneration,
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  };

  let cursor = '';
  for (;;) {
    const page = await repository.listClearableInsuranceRefs({
      ...filter,
      after: cursor,
      limit: options.pageSize,
    });
    if (page.length === 0) break;

    if (options.dryRun) {
      for (const id of page) {
        report.scanned += 1;
        report.cleared += 1;
        await countOwner(repository, report, id);
      }
    } else {
      await repository.transaction(async (tx) => {
        // Ascending by id in every run, so two runs cannot lock in opposite orders.
        for (const id of page) {
          report.scanned += 1;
          await repository.lockAssetRef(tx, id);
          const owner = (await repository.findAssetRefUnscoped(id, tx))?.organizationId;
          if (await repository.clearInsuranceCover(tx, id, filter)) {
            report.cleared += 1;
            if (owner) report.byOrganization[owner] = (report.byOrganization[owner] ?? 0) + 1;
          } else {
            report.skipped += 1;
          }
        }
      });
    }

    cursor = page.at(-1) ?? cursor;
    if (page.length < options.pageSize) break;
  }
  return report;
}

async function countOwner(
  repository: FleetRepository,
  report: ClearTransferredReport,
  assetId: string,
): Promise<void> {
  const owner = (await repository.findAssetRefUnscoped(assetId))?.organizationId;
  if (owner) report.byOrganization[owner] = (report.byOrganization[owner] ?? 0) + 1;
}
