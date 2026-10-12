import type { Milestone } from '../generated/prisma';
import type { MilestoneView } from './dto';

/** The planned day as `YYYY-MM-DD`: a `date` column comes back as midnight UTC of that day. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A milestone row as a response: a day is a date string, every instant ISO-8601 UTC. */
export function toMilestoneView(row: Milestone): MilestoneView {
  return {
    id: row.id,
    contractId: row.contractId,
    organizationId: row.organizationId,
    title: row.title,
    plannedDate: dayOf(row.plannedDate),
    plannedShareBp: row.plannedShareBp,
    referenced: row.firstReferencedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
