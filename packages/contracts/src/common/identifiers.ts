import { z } from 'zod';

/**
 * Rasta identifier scheme.
 *
 * Every durable business object carries a prefixed, human-readable, globally
 * unique identifier. Two rules drive this design:
 *
 *  1. **Organization-agnostic (ADR-012).** An `AssetId` must never encode
 *     "Yazd", "dehyari", or the owning organization. Assets are transferred
 *     between organizations, organizations are merged, and the platform is
 *     meant to scale from 328 village councils to a national marketplace.
 *     Ownership is a *relationship*, not part of the identity.
 *
 *  2. **Self-describing in logs.** `AST_01J...` in a trace tells an operator
 *     what they are looking at without a lookup.
 *
 * The suffix is a ULID: 26 crockford-base32 characters, lexicographically
 * sortable by creation time, generated without coordination.
 */

/** Crockford base32 alphabet used by ULID (excludes I, L, O, U). */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ULID_REGEX = ULID_PATTERN;

export const ID_PREFIXES = {
  organization: 'ORG',
  user: 'USR',
  membership: 'MBR',
  asset: 'AST',
  driver: 'DRV',
  usageRecord: 'USG',
  maintenanceRequest: 'MNT',
  repairOrder: 'RPO',
  insurancePolicy: 'INS',
  supplier: 'SUP',
  product: 'PRD',
  offer: 'OFR',
  order: 'ORD',
  shipment: 'SHP',
  demandRequest: 'DMD',
  rfq: 'RFQ',
  quotation: 'QOT',
  purchaseOrder: 'PO',
  warehouse: 'WHS',
  project: 'PRJ',
  tender: 'TND',
  bid: 'BID',
  contract: 'CTR',
  progressReport: 'PRG',
  statement: 'STM',
  approval: 'APR',
  wallet: 'WLT',
  ledgerAccount: 'ACC',
  journal: 'JRN',
  ledgerEntry: 'LGE',
  transaction: 'TXN',
  payment: 'PAY',
  commission: 'CMS',
  reward: 'RWD',
  document: 'DOC',
  notification: 'NTF',
  auditEvent: 'AUD',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/**
 * Builds a zod schema for one prefixed identifier, e.g. `AST_01JBQ...`.
 * Seeded/demo data may use readable ids (`ORG-UNION-YAZD`); those are accepted
 * only by {@link seedIdSchema} so they can never leak into a production path.
 */
export function prefixedIdSchema(prefix: IdPrefix) {
  return z
    .string()
    .refine(
      (value) => {
        const [head, tail] = splitOnce(value, '_');
        return head === prefix && tail !== undefined && ULID_PATTERN.test(tail);
      },
      { message: `Expected an identifier of the form ${prefix}_<ULID>` },
    )
    .describe(`${prefix} identifier`);
}

/** Accepts either a real prefixed ULID or a readable seed identifier. */
export function seedIdSchema(prefix: IdPrefix) {
  return z.union([prefixedIdSchema(prefix), z.string().regex(new RegExp(`^${prefix}-[A-Z0-9-]{1,48}$`))]);
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export const organizationIdSchema = seedIdSchema(ID_PREFIXES.organization);
export const userIdSchema = seedIdSchema(ID_PREFIXES.user);
export const assetIdSchema = seedIdSchema(ID_PREFIXES.asset);

export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type UserId = z.infer<typeof userIdSchema>;
export type AssetId = z.infer<typeof assetIdSchema>;
