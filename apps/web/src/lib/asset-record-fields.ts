/**
 * The shape of the two record forms on `/assets/[id]`: an insurance policy and a
 * technical inspection (EXP-002, slice 6) — field names, the closed choices and a
 * blank set of values for each form.
 *
 * Separate from `server/asset-records.ts`, which parses these and reaches the
 * gateway client, for the reason `asset-lifecycle-fields.ts` gives: that module
 * pulls in `node:crypto` transitively and this file is imported by client
 * components.
 *
 * Neither form names its asset. The asset is the page's own, bound to the action
 * by the form (`action.bind(null, assetId)`), so there is nothing here a person —
 * or a script — could edit to point a record at another machine.
 */

/** `createPolicySchema.coverage`, `services/asset-service/src/asset/dto.ts` — pinned by the contract spec. */
export const POLICY_COVERAGES = [
  'THIRD_PARTY',
  'COMPREHENSIVE',
  'PASSENGER_ACCIDENT',
  'LIABILITY',
] as const;
export type PolicyCoverage = (typeof POLICY_COVERAGES)[number];

export const RECORD_POLICY_FIELDS = [
  'policyNumber',
  'insurerName',
  'coverage',
  'premium',
  'insuredValue',
  'validFrom',
  'validTo',
] as const;
export type RecordPolicyField = (typeof RECORD_POLICY_FIELDS)[number];
export type RecordPolicyFormValues = Record<RecordPolicyField, string>;

export const EMPTY_RECORD_POLICY_FORM: RecordPolicyFormValues = {
  policyNumber: '',
  insurerName: '',
  coverage: '',
  premium: '',
  insuredValue: '',
  validFrom: '',
  validTo: '',
};

export const RECORD_INSPECTION_FIELDS = [
  'certificateNo',
  'centerName',
  'inspectedAt',
  'validTo',
  'result',
  'notes',
] as const;
export type RecordInspectionField = (typeof RECORD_INSPECTION_FIELDS)[number];
export type RecordInspectionFormValues = Record<RecordInspectionField, string>;

export const EMPTY_RECORD_INSPECTION_FORM: RecordInspectionFormValues = {
  certificateNo: '',
  centerName: '',
  inspectedAt: '',
  validTo: '',
  result: '',
  notes: '',
};

/** What a record's confirmation banner can say, signed into the redirect (`server/flash.ts`). */
export const RECORD_NOTICES = ['policyRecorded', 'inspectionRecorded'] as const;
export type RecordNotice = (typeof RECORD_NOTICES)[number];

/**
 * Where a record stands against **now**, as the server judged it when it drew the
 * page (`validityWindowOf`): the window has not begun, is open, or has closed.
 * Never computed in a client component, whose clock is the visitor's.
 */
export type ValidityWindow = 'FUTURE' | 'CURRENT' | 'EXPIRED';
