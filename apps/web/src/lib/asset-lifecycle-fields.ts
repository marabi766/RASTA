/**
 * The shape of the asset lifecycle forms on `/assets/[id]`: which commands
 * exist, which statuses each is offered from, field names, and a blank set of
 * values for each form.
 *
 * Separate from `server/asset-lifecycle-commands.ts`, which parses these and
 * reaches the gateway client, for the reason `asset-form-fields.ts` gives: that
 * module pulls in `node:crypto` transitively and this file is imported by client
 * components.
 *
 * The asset a command is about, the version it was drawn at and the status it
 * was drawn from are not fields of any form. They are what the page signed
 * (`sealAssetLifecycleBaseline`), so there is nothing here a person — or a
 * script — could edit to point a command at another asset or another version.
 */

export const ASSET_LIFECYCLE_COMMANDS = ['activate', 'status', 'decommission'] as const;
export type AssetLifecycleCommand = (typeof ASSET_LIFECYCLE_COMMANDS)[number];

/**
 * The statuses a person may move an asset to through `POST /v1/assets/{id}/status`
 * (`changeStatusSchema`, `services/asset-service/src/asset/dto.ts`). `ASSIGNED`
 * and `IN_MAINTENANCE` are absent on purpose: fleet-service and
 * maintenance-service own them and arrive as events; `REGISTERED` is where an
 * asset starts and `DECOMMISSIONED` has its own command.
 */
export const CHANGE_STATUS_TARGETS = ['ACTIVE', 'IDLE', 'OUT_OF_SERVICE'] as const;
export type ChangeStatusTarget = (typeof CHANGE_STATUS_TARGETS)[number];

/**
 * What a person may do from each status — the `USER` rows of `TRANSITIONS`
 * (`services/asset-service/src/asset/lifecycle.ts`), copied and pinned to it by
 * `asset-lifecycle-commands.contract.spec.ts`. A copy is a courtesy that offers
 * only forms that can work; asset-service refuses again, and a transition this
 * table forgets is still refused there.
 */
export const USER_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  REGISTERED: ['ACTIVE', 'OUT_OF_SERVICE', 'DECOMMISSIONED'],
  ACTIVE: ['IDLE', 'OUT_OF_SERVICE', 'DECOMMISSIONED'],
  IDLE: ['ACTIVE', 'OUT_OF_SERVICE', 'DECOMMISSIONED'],
  ASSIGNED: ['OUT_OF_SERVICE'],
  IN_MAINTENANCE: ['OUT_OF_SERVICE'],
  OUT_OF_SERVICE: ['ACTIVE', 'DECOMMISSIONED'],
  DECOMMISSIONED: [],
};

/** Whether a person may activate an asset that is in `status`. */
export const canActivateFrom = (status: string): boolean => status === 'REGISTERED';

/** The statuses the change-status form offers for an asset in `status`. */
export function statusTargetsFrom(status: string): ChangeStatusTarget[] {
  const reachable = USER_TRANSITIONS[status] ?? [];
  // REGISTERED → ACTIVE is the activation command, which checks the dossier;
  // a plain status change must never be the way round that check, so this form
  // does not offer it (and asset-service refuses it on `/status`).
  return CHANGE_STATUS_TARGETS.filter(
    (target) => reachable.includes(target) && !(status === 'REGISTERED' && target === 'ACTIVE'),
  );
}

/** Whether a person may decommission an asset that is in `status`. */
export const canDecommissionFrom = (status: string): boolean =>
  (USER_TRANSITIONS[status] ?? []).includes('DECOMMISSIONED');

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * Activation has nothing to type: the button, and the version it was drawn at.
 * Its form state therefore has no fields at all.
 */
export type ActivateAssetFormValues = Readonly<Record<never, string>>;

export const CHANGE_STATUS_FIELDS = ['status', 'reason'] as const;
export type ChangeStatusField = (typeof CHANGE_STATUS_FIELDS)[number];
export type ChangeStatusFormValues = Readonly<Record<ChangeStatusField, string>>;
export const EMPTY_CHANGE_STATUS_FORM: ChangeStatusFormValues = { status: '', reason: '' };

/**
 * `confirm` is the tick that says the person read what decommissioning means.
 * It is "yes" or absent — a checkbox posts nothing when it is clear.
 * `decommissionedAt` is absent on purpose: the service stamps the moment, and a
 * back-dated end of life is not something this screen has a reason to record.
 */
export const DECOMMISSION_FIELDS = ['reason', 'confirm'] as const;
export type DecommissionField = (typeof DECOMMISSION_FIELDS)[number];
export type DecommissionFormValues = Readonly<Record<DecommissionField, string>>;
export const EMPTY_DECOMMISSION_FORM: DecommissionFormValues = { reason: '', confirm: '' };

/** What the flash a lifecycle redirect carries says happened. */
export type AssetLifecycleNotice =
  'activated' | 'statusChanged' | 'decommissioned' | 'lifecycleConflict';
