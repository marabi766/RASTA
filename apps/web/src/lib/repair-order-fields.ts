/**
 * The shape of the repair-order write forms on `/maintenance/[id]`: field names,
 * the choices a select offers, and a blank set of values for each form.
 *
 * Separate from `server/repair-order-commands.ts`, which parses these and
 * reaches the gateway client, for the reason `maintenance-fields.ts` gives:
 * that module pulls in `node:crypto` transitively and this file is imported by
 * client components.
 *
 * The order a command is about is not a field of any form. It is what the page
 * signed (`sealRepairOrderBaseline`), so there is nothing here a person — or a
 * script — could edit to point a command at another order.
 */

// ---------------------------------------------------------------------------
// Start, complete, cancel
// ---------------------------------------------------------------------------

/**
 * `startedAt` is absent on purpose, as `assignedAt` is for a referral: the
 * service stamps the moment the repair starts, and a back-dated start is not
 * something a person at this screen has a reason to record.
 */
export const START_REPAIR_FIELDS = ['workSummary'] as const;
export type StartRepairField = (typeof START_REPAIR_FIELDS)[number];
export type StartRepairFormValues = Readonly<Record<StartRepairField, string>>;
export const EMPTY_START_REPAIR_FORM: StartRepairFormValues = { workSummary: '' };

/**
 * `completedAt` and `returnedToServiceAt` are absent for the same reason: a
 * date picker names a day, not a moment, and a completion stamped before "now"
 * is refused by the service as completing before it started. Downtime therefore
 * counts to the moment of completion; a machine collected later is not
 * something this screen can say yet.
 *
 * `expectedTotalCostMinor` is not a field either: it is the order total the
 * page showed, taken from the signed baseline.
 */
export const COMPLETE_REPAIR_FIELDS = ['workPerformed'] as const;
export type CompleteRepairField = (typeof COMPLETE_REPAIR_FIELDS)[number];
export type CompleteRepairFormValues = Readonly<Record<CompleteRepairField, string>>;
export const EMPTY_COMPLETE_REPAIR_FORM: CompleteRepairFormValues = { workPerformed: '' };

export const CANCEL_REPAIR_FIELDS = ['reason'] as const;
export type CancelRepairField = (typeof CANCEL_REPAIR_FIELDS)[number];
export type CancelRepairFormValues = Readonly<Record<CancelRepairField, string>>;
export const EMPTY_CANCEL_REPAIR_FORM: CancelRepairFormValues = { reason: '' };

// ---------------------------------------------------------------------------
// Cost: a part, labour, any other charge
// ---------------------------------------------------------------------------

/** `PART_SOURCES`, `services/maintenance-service/src/maintenance/dto.ts`. */
export const PART_SOURCES = ['INVENTORY', 'MARKETPLACE', 'WORKSHOP_SUPPLIED', 'OTHER'] as const;
export type PartSource = (typeof PART_SOURCES)[number];

/**
 * `DIRECT_COST_CATEGORIES`, same file: the categories a person may post
 * directly. `PART` and `LABOUR` are absent on purpose — those lines exist only
 * because a part or a labour entry was recorded.
 */
export const DIRECT_COST_CATEGORIES = ['SERVICE', 'EXTERNAL_REPAIR', 'OTHER'] as const;
export type DirectCostCategory = (typeof DIRECT_COST_CATEGORIES)[number];

/**
 * `currency` and `recordedAt` are absent: every order here is in rials and the
 * service stamps the time. `unitCostMinor` is typed in rials — the rial is its
 * own minor unit (`IRR.fractionDigits` is 0) — and sent as a string.
 */
export const RECORD_PART_FIELDS = [
  'partName',
  'partReference',
  'quantity',
  'unit',
  'unitCostMinor',
  'source',
  'sourceReference',
] as const;
export type RecordPartField = (typeof RECORD_PART_FIELDS)[number];
export type RecordPartFormValues = Readonly<Record<RecordPartField, string>>;
export const EMPTY_RECORD_PART_FORM: RecordPartFormValues = {
  partName: '',
  partReference: '',
  quantity: '',
  unit: 'عدد',
  unitCostMinor: '',
  source: 'WORKSHOP_SUPPLIED',
  sourceReference: '',
};

export const RECORD_LABOUR_FIELDS = [
  'description',
  'technician',
  'hours',
  'hourlyRateMinor',
] as const;
export type RecordLabourField = (typeof RECORD_LABOUR_FIELDS)[number];
export type RecordLabourFormValues = Readonly<Record<RecordLabourField, string>>;
export const EMPTY_RECORD_LABOUR_FORM: RecordLabourFormValues = {
  description: '',
  technician: '',
  hours: '',
  hourlyRateMinor: '',
};

export const RECORD_COST_FIELDS = ['category', 'amountMinor', 'description'] as const;
export type RecordCostField = (typeof RECORD_COST_FIELDS)[number];
export type RecordCostFormValues = Readonly<Record<RecordCostField, string>>;
export const EMPTY_RECORD_COST_FORM: RecordCostFormValues = {
  category: 'SERVICE',
  amountMinor: '',
  description: '',
};

// ---------------------------------------------------------------------------
// What a command's signed flash may say
// ---------------------------------------------------------------------------

/**
 * What a repair-order command's signed flash may say on `/maintenance/[id]`
 * (`server/flash.ts`). Like `REQUEST_COMMAND_NOTICES`, only a flash this server
 * signed for this session and this request can name one.
 */
export const REPAIR_COMMAND_NOTICES = [
  'repairStarted',
  'repairCompleted',
  'repairCancelled',
  'repairCostChanged',
  'partRecorded',
  'labourRecorded',
  'costRecorded',
] as const;

export type RepairCommandNotice = (typeof REPAIR_COMMAND_NOTICES)[number];

/** The commands one order's forms can send; the baseline names which it was minted for. */
export const REPAIR_COMMANDS = ['start', 'complete', 'cancel', 'part', 'labour', 'cost'] as const;
export type RepairCommandName = (typeof REPAIR_COMMANDS)[number];

/**
 * The commands an order in `status` leaves open, mirroring the service's repair
 * lifecycle (`lifecycle.ts`): start or withdraw a referral that has not begun;
 * finish or withdraw one in progress; record cost while it is still costable.
 * The screen uses it to place forms and the page to mint their baselines, and
 * the service decides again on every send.
 */
export function repairCommandsFor(status: string): readonly RepairCommandName[] {
  switch (status) {
    case 'OPEN':
      return ['start', 'cancel', 'part', 'labour', 'cost'];
    case 'IN_PROGRESS':
      return ['complete', 'cancel', 'part', 'labour', 'cost'];
    default:
      return [];
  }
}
