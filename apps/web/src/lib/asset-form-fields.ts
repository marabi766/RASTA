/**
 * The shape of the asset write forms: field names, and a blank set of values
 * for each.
 *
 * Separate from `server/asset-commands.ts`, which parses these and reaches the
 * gateway client, because that module pulls in `node:crypto` transitively and
 * this file is imported by client components (`usage-fields.ts` documents why:
 * the build refuses a client component that imports Node's crypto).
 *
 * The closed vocabularies these forms offer (`ASSET_TYPES`) live in
 * `asset-fields.ts`, where `labels.contract.spec.ts` pins them to the service.
 */

// ---------------------------------------------------------------------------
// Register a machine
// ---------------------------------------------------------------------------

/**
 * Deliberately short of what asset-service accepts. Three things are not here:
 *
 * - `specifications` is free-form, type-specific JSON with no screen in docs/16
 *   to edit it; the service defaults it to `{}`.
 * - A coordinate. The portal drops coordinates from every read
 *   (`server/assets.ts`), so a form that *wrote* one would collect what the
 *   portal will not show back.
 * - Documents, insurance and inspections. They are separate writes
 *   (`/v1/assets/:id/documents`…) and not part of registering a machine.
 */
export const REGISTER_ASSET_FIELDS = [
  'name',
  'type',
  'assetTag',
  'manufacturer',
  'model',
  'serialNumber',
  'manufactureYear',
  'siteName',
  'addressLine',
] as const;

export type RegisterAssetField = (typeof REGISTER_ASSET_FIELDS)[number];
export type RegisterAssetFormValues = Readonly<Record<RegisterAssetField, string>>;

export const EMPTY_REGISTER_ASSET_FORM: RegisterAssetFormValues = {
  name: '',
  type: '',
  assetTag: '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  manufactureYear: '',
  siteName: '',
  addressLine: '',
};

// ---------------------------------------------------------------------------
// Edit a machine
// ---------------------------------------------------------------------------

/**
 * `type` and `serialNumber` are absent on purpose: asset-service's update
 * schema has neither. A serial number identifies one physical machine
 * worldwide, so changing it means the row now describes a different object,
 * which is a new asset and not an edit; the type is fixed at registration.
 */
export const UPDATE_ASSET_FIELDS = [
  'name',
  'assetTag',
  'manufacturer',
  'model',
  'manufactureYear',
] as const;

export type UpdateAssetField = (typeof UPDATE_ASSET_FIELDS)[number];
export type UpdateAssetFormValues = Readonly<Record<UpdateAssetField, string>>;

export const EMPTY_UPDATE_ASSET_FORM: UpdateAssetFormValues = {
  name: '',
  assetTag: '',
  manufacturer: '',
  model: '',
  manufactureYear: '',
};
