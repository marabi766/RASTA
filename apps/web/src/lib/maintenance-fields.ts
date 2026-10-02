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

// ---------------------------------------------------------------------------
// Commands on a request: refer to a workshop, approve the cost, cancel
// ---------------------------------------------------------------------------

/**
 * `assignedAt` is absent on purpose: the service stamps the moment the referral
 * is made, and a back-dated referral is not something a person at this screen
 * has a reason to record.
 */
export const ASSIGN_WORKSHOP_FIELDS = [
  'workshopOrganizationId',
  'workshopName',
  'workSummary',
] as const;

export type AssignWorkshopField = (typeof ASSIGN_WORKSHOP_FIELDS)[number];
export type AssignWorkshopFormValues = Readonly<Record<AssignWorkshopField, string>>;

export const EMPTY_ASSIGN_WORKSHOP_FORM: AssignWorkshopFormValues = {
  workshopOrganizationId: '',
  workshopName: '',
  workSummary: '',
};

/**
 * `expectedTotalCostMinor` is not typed by anybody: it is the total this screen
 * showed, carried in the form so the service can refuse an approval whose
 * figure has moved since (docs/17's mandatory control). It is a field of the
 * form so a refusal can keep it, but the person never edits it.
 */
export const APPROVE_REQUEST_FIELDS = ['expectedTotalCostMinor', 'notes'] as const;

export type ApproveRequestField = (typeof APPROVE_REQUEST_FIELDS)[number];
export type ApproveRequestFormValues = Readonly<Record<ApproveRequestField, string>>;

export const CANCEL_REQUEST_FIELDS = ['reason'] as const;

export type CancelRequestField = (typeof CANCEL_REQUEST_FIELDS)[number];
export type CancelRequestFormValues = Readonly<Record<CancelRequestField, string>>;

export const EMPTY_CANCEL_REQUEST_FORM: CancelRequestFormValues = { reason: '' };

/**
 * What a command's signed flash may say on `/maintenance/[id]`
 * (`server/flash.ts`). The page accepts only these from a flash this server
 * signed for this session and this request; nothing in the query can name one.
 */
export const REQUEST_COMMAND_NOTICES = [
  'assigned',
  'approved',
  'cancelled',
  'costChanged',
] as const;

export type RequestCommandNotice = (typeof REQUEST_COMMAND_NOTICES)[number];
