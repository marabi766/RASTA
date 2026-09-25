/**
 * asset-service's closed vocabularies, as the portal sends and reads them.
 *
 * Copied, not imported: A-02 forbids reaching into `services/*\/src`, and the
 * service's `dto.ts` pulls in `@rasta/config`, which the portal does not
 * depend on. The copy is pinned instead — `labels.contract.spec.ts` reads each
 * list out of the service's source and fails the moment the two disagree.
 * That test exists because these lists once did disagree (audit finding
 * L5-02): the filter offered types asset-service had never had, and choosing
 * one turned the asset list into an error page, because the service validates
 * `type` against its enum and refused the request.
 *
 * Free of `node:*` imports, like the other `*-fields.ts` files, so a client
 * component can import it.
 */

/** `ASSET_TYPES`, `services/asset-service/src/asset/dto.ts`. */
export const ASSET_TYPES = [
  'GRADER',
  'LOADER',
  'EXCAVATOR',
  'BULLDOZER',
  'TRUCK',
  'LIGHT_TRUCK',
  'TRACTOR',
  'WATER_TANKER',
  'WASTE_COLLECTOR',
  'EMERGENCY_VEHICLE',
  'PASSENGER_VEHICLE',
  'FIXED_EQUIPMENT',
  'OTHER',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

/** `OPERATIONAL_STATUSES`, same file — the `status` an asset carries and a list filters on. */
export const ASSET_STATUSES = [
  'REGISTERED',
  'ACTIVE',
  'ASSIGNED',
  'IDLE',
  'IN_MAINTENANCE',
  'OUT_OF_SERVICE',
  'DECOMMISSIONED',
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** `TIMELINE_CATEGORIES`, same file — the dossier's sections and the timeline's filter. */
export const TIMELINE_CATEGORIES = [
  'LIFECYCLE',
  'USAGE',
  'MAINTENANCE',
  'INSURANCE',
  'INSPECTION',
  'DOCUMENT',
  'COST',
  'PROJECT',
  'TRANSFER',
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

/**
 * `result` on `createInspectionSchema`, same file — what the dossier's latest
 * inspection reports. An inline `z.enum` there rather than a named list, which
 * the contract test reads all the same.
 */
export const INSPECTION_RESULTS = ['PASSED', 'CONDITIONAL', 'FAILED'] as const;

export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

/** Narrows a query-string value to one the list endpoint will accept, or nothing. */
export function oneOf<T extends string>(
  vocabulary: readonly T[],
  value: string | undefined,
): T | undefined {
  return value !== undefined && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
