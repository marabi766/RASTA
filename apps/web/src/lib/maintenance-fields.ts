/**
 * The shape of the maintenance write forms: field names, and a blank set of
 * values for each.
 *
 * Separate from `server/maintenance-commands.ts`, which parses these and
 * reaches the gateway client, because that module pulls in `node:crypto`
 * transitively and this file is imported by client components
 * (`usage-fields.ts` documents why: the build refuses a client component that
 * imports Node's crypto).
 */

// ---------------------------------------------------------------------------
// Report maintenance work
// ---------------------------------------------------------------------------

/**
 * `scheduleId` is absent on purpose: there is no schedule screen in docs/16's
 * page map, so a request raised here is always ad hoc — a breakdown somebody
 * is standing next to, or planned work somebody noticed. A schedule-driven
 * request is raised by the service itself when the work comes due.
 */
export const REPORT_REQUEST_FIELDS = [
  'assetId',
  'type',
  'title',
  'description',
  'severity',
  'outOfServiceAt',
  'dueDate',
] as const;

export type ReportRequestField = (typeof REPORT_REQUEST_FIELDS)[number];
export type ReportRequestFormValues = Readonly<Record<ReportRequestField, string>>;

export const EMPTY_REPORT_REQUEST_FORM: ReportRequestFormValues = {
  assetId: '',
  type: 'CORRECTIVE',
  title: '',
  description: '',
  severity: '',
  outOfServiceAt: '',
  dueDate: '',
};
