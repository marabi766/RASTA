import { isCurrentlyQualified, type QualificationStateName } from './qualification.state-machine';
import { isOpenEpisode, type SupplierStatusName } from './suspension.state-machine';
import type { SupplierCapability } from './capabilities';
import type {
  QualificationView,
  SupplierDetailView,
  SupplierDirectoryView,
  SuspensionView,
} from './dto';

/**
 * The two projections, and the wall between them.
 *
 * ## Why this is a separate file with its own tests
 *
 * The directory crosses tenant boundaries by design: `SearchSuppliers` and
 * `ListQualifiedFor` exist so a buyer in one organization can find a workshop in
 * another, and that is the whole point of a directory. Everything else in this
 * service is scoped to one tenant.
 *
 * That makes the projection the boundary. If the private view leaked into the
 * public one, a cross-tenant read that is *correct* would start returning
 * evidence document ids and reviewers' notes to anybody who could list. So the
 * two are built by two functions from two explicit field lists, and
 * `views.spec.ts` asserts the public shape by enumerating its keys rather than
 * by spot-checking a few — a new column added to `Supplier` cannot reach the
 * directory by being picked up in a spread.
 *
 * ## What the public projection never carries
 *
 *   evidence document ids   a document-service identifier is a handle. Publish
 *                           it to strangers and anyone holding document-service
 *                           credentials can try to fetch a supplier's private
 *                           licence, bypassing this service's authorization.
 *   decision notes          written by a reviewer for the platform's record.
 *   actor identifiers       who submitted, who decided, who suspended. A
 *                           directory that named the operator who suspended a
 *                           competitor would be a directory of platform staff.
 *   suspension reasons      the *fact* of a suspension is operationally
 *                           necessary — marketplace hides offers on it. The
 *                           narrative is not, and it can be defamatory.
 *   undecided submissions   "applied and awaiting review" is not a public fact,
 *                           and publishing it would let anybody watch a
 *                           competitor's application in progress.
 */

// ---------------------------------------------------------------------------
// The row shapes these functions read. Structural, not Prisma types, so the
// projection can be tested without a database.
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  documentId: string;
  label: string | null;
}

export interface QualificationRow {
  id: string;
  capability: SupplierCapability;
  state: QualificationStateName;
  statement: string | null;
  submittedBy: string;
  submittedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  evidence: EvidenceRow[];
}

export interface SuspensionRow {
  id: string;
  reason: string;
  suspendedBy: string;
  suspendedAt: Date;
  reinstatedBy: string | null;
  reinstatedAt: Date | null;
  reinstatementNote: string | null;
}

export interface SupplierRow {
  id: string;
  organizationId: string;
  displayName: string;
  status: SupplierStatusName;
  registeredBy: string;
  registeredAt: Date;
  capabilities: { capability: SupplierCapability }[];
  qualifications: QualificationRow[];
  suspensions: SuspensionRow[];
}

/** Sorted, so two equal sets never render as two different payloads. */
function sortedCapabilities(values: readonly SupplierCapability[]): SupplierCapability[] {
  return [...new Set(values)].sort();
}

/**
 * The capabilities this supplier is qualified for **right now**.
 *
 * The single expression behind `qualifiedFor` in both views, the
 * `ListQualifiedFor` result and the `current` flag on a qualification. One
 * definition, because three copies of "approved and not suspended" is three
 * chances for one of them to forget the second half.
 */
export function currentlyQualifiedFor(supplier: SupplierRow): SupplierCapability[] {
  const suspended = supplier.status === 'SUSPENDED';

  return sortedCapabilities(
    supplier.qualifications
      .filter((row) => isCurrentlyQualified({ state: row.state, supplierSuspended: suspended }))
      .map((row) => row.capability),
  );
}

/**
 * The catalogue-safe projection. Every field listed explicitly.
 *
 * Written as an object literal rather than as a pick-list over the row, because
 * a pick-list is a filter and a filter can be inverted by accident. This can
 * only ever emit what is written here.
 */
export function toDirectoryView(supplier: SupplierRow): SupplierDirectoryView {
  return {
    id: supplier.id,
    // The organization id is public: it is what a buyer uses to place an order
    // with this supplier, and it is already on every offer marketplace serves.
    organizationId: supplier.organizationId,
    displayName: supplier.displayName,
    status: supplier.status,
    capabilities: sortedCapabilities(supplier.capabilities.map((row) => row.capability)),
    qualifiedFor: currentlyQualifiedFor(supplier),
    registeredAt: supplier.registeredAt.toISOString(),
  };
}

function toQualificationView(row: QualificationRow, supplierSuspended: boolean): QualificationView {
  return {
    id: row.id,
    capability: row.capability,
    state: row.state,
    statement: row.statement,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    evidence: row.evidence.map((item) => ({ documentId: item.documentId, label: item.label })),
    current: isCurrentlyQualified({ state: row.state, supplierSuspended }),
  };
}

function toSuspensionView(row: SuspensionRow): SuspensionView {
  return {
    id: row.id,
    reason: row.reason,
    suspendedBy: row.suspendedBy,
    suspendedAt: row.suspendedAt.toISOString(),
    reinstatedBy: row.reinstatedBy,
    reinstatedAt: row.reinstatedAt?.toISOString() ?? null,
    reinstatementNote: row.reinstatementNote,
    open: isOpenEpisode(row),
  };
}

/**
 * The private projection: the supplier's own organization, or a platform
 * operator.
 *
 * Built on top of the directory view rather than beside it, so a field can
 * never be public here and private there — the containment is structural.
 * `access.ts` decides *who* reaches this function; this file only decides what
 * it contains.
 */
export function toDetailView(supplier: SupplierRow): SupplierDetailView {
  const suspended = supplier.status === 'SUSPENDED';

  return {
    ...toDirectoryView(supplier),
    registeredBy: supplier.registeredBy,
    qualifications: supplier.qualifications.map((row) => toQualificationView(row, suspended)),
    suspensions: supplier.suspensions.map(toSuspensionView),
  };
}

/**
 * The field names the public projection is allowed to contain.
 *
 * Exported so `views.spec.ts` can assert the projection's key set exactly, and
 * so adding a field to the directory is a deliberate edit to this list rather
 * than a side effect of touching the schema.
 */
export const DIRECTORY_VIEW_FIELDS = [
  'id',
  'organizationId',
  'displayName',
  'status',
  'capabilities',
  'qualifiedFor',
  'registeredAt',
] as const;
