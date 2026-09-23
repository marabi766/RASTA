/**
 * The shape of every `/drivers` form: field names, and a blank set of values
 * for each. Five forms share this file rather than one each, because they are
 * all small and none has a life outside `/drivers`.
 *
 * Separate from `server/drivers.ts` and `server/assignments.ts`, which parse
 * these and reach the gateway client, because those modules pull in
 * `node:crypto` transitively and this file is imported by client components
 * (`usage-fields.ts` documents why: the build refuses a client component that
 * imports Node's crypto).
 */

// ---------------------------------------------------------------------------
// Register a driver
// ---------------------------------------------------------------------------

export const CREATE_DRIVER_FIELDS = [
  'userId',
  'employeeNo',
  'licenceNumber',
  'licenceClass',
  'licenceValidTo',
  'notes',
] as const;

export type CreateDriverField = (typeof CREATE_DRIVER_FIELDS)[number];
export type CreateDriverFormValues = Readonly<Record<CreateDriverField, string>>;

export const EMPTY_CREATE_DRIVER_FORM: CreateDriverFormValues = {
  userId: '',
  employeeNo: '',
  licenceNumber: '',
  licenceClass: '',
  licenceValidTo: '',
  notes: '',
};

// ---------------------------------------------------------------------------
// Edit a driver
// ---------------------------------------------------------------------------

/** `userId` is absent on purpose — fleet-service treats it as immutable. */
export const UPDATE_DRIVER_FIELDS = [
  'employeeNo',
  'licenceNumber',
  'licenceClass',
  'licenceValidTo',
  'notes',
] as const;

export type UpdateDriverField = (typeof UPDATE_DRIVER_FIELDS)[number];
export type UpdateDriverFormValues = Readonly<Record<UpdateDriverField, string>>;

export const EMPTY_UPDATE_DRIVER_FORM: UpdateDriverFormValues = {
  employeeNo: '',
  licenceNumber: '',
  licenceClass: '',
  licenceValidTo: '',
  notes: '',
};

// ---------------------------------------------------------------------------
// Change status
// ---------------------------------------------------------------------------

export const CHANGE_STATUS_FIELDS = ['status', 'reason'] as const;

export type ChangeStatusField = (typeof CHANGE_STATUS_FIELDS)[number];
export type ChangeStatusFormValues = Readonly<Record<ChangeStatusField, string>>;

export const EMPTY_CHANGE_STATUS_FORM: ChangeStatusFormValues = { status: '', reason: '' };

// ---------------------------------------------------------------------------
// Assign to a machine
// ---------------------------------------------------------------------------

/**
 * `driverId` is not a field here. The form always assigns *this* driver, the
 * one whose detail page it is rendered on, so the id reaches the server
 * action bound (`action.bind(null, driverId)`, the Next.js way to carry a
 * value a form does not collect) rather than as form content — the same
 * reasoning `endAssignmentFormSchema` applies to `assignmentId` below.
 */
export const ASSIGN_DRIVER_FIELDS = ['assetId', 'startedAt', 'purpose'] as const;

export type AssignDriverField = (typeof ASSIGN_DRIVER_FIELDS)[number];
export type AssignDriverFormValues = Readonly<Record<AssignDriverField, string>>;

export const EMPTY_ASSIGN_DRIVER_FORM: AssignDriverFormValues = {
  assetId: '',
  startedAt: '',
  purpose: '',
};

// ---------------------------------------------------------------------------
// End an assignment
// ---------------------------------------------------------------------------

/**
 * `assignmentId` is not a field. Which assignment ends is bound to the
 * action from the page's own read of the driver's active assignment, never
 * typed or hidden-submitted — there is exactly one live assignment to end,
 * and offering an id field would invite ending a different one by mistake.
 */
export const END_ASSIGNMENT_FIELDS = ['reason', 'notes'] as const;

export type EndAssignmentField = (typeof END_ASSIGNMENT_FIELDS)[number];
export type EndAssignmentFormValues = Readonly<Record<EndAssignmentField, string>>;

export const EMPTY_END_ASSIGNMENT_FORM: EndAssignmentFormValues = {
  reason: 'COMPLETED',
  notes: '',
};
