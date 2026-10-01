import type { Tender } from '../generated/prisma';
import type { TenderSummaryView, TenderView } from './dto';
import type { TenderStateName } from './tender.state-machine';

/**
 * Rows to response shapes. Time leaves as ISO-8601 UTC (`Z`), so a deadline is
 * read the same way by every client.
 */

export function toTenderView(row: Tender): TenderView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    title: row.title,
    scopeOfWork: row.scopeOfWork,
    procurementNature: row.procurementNature,
    visibility: row.visibility,
    bidOpeningAt: row.bidOpeningAt?.toISOString() ?? null,
    bidClosingAt: row.bidClosingAt?.toISOString() ?? null,
    status: row.status as TenderStateName,
    statusReason: row.statusReason,
    statusReasonCode: row.statusReasonCode,
    statusChangedAt: row.statusChangedAt.toISOString(),
    statusChangedBy: row.statusChangedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    version: row.version,
  };
}

export function toTenderSummaryView(row: Tender): TenderSummaryView {
  const { scopeOfWork: _scopeOfWork, ...summary } = toTenderView(row);
  return summary;
}
