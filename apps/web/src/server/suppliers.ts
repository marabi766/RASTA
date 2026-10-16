import { z } from 'zod';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

export type { ReadResult };

/**
 * Reading suppliers through the gateway (EXP-004 slice 5, `docs/04` § 4.10).
 *
 * Read-only: no command is issued from this module — registering a profile,
 * submitting, approving or rejecting a qualification, suspending and
 * reinstating are all out of scope here — so there is no Idempotency-Key.
 * Reads follow `projects.ts` and `contracts.ts`.
 *
 * ## The two views, and the wall between them (`supplier-service/views.ts`)
 *
 * `GET /v1/suppliers` is the cross-tenant **directory**: catalogue-safe
 * fields only, open to anyone holding one of supplier-service's
 * `DIRECTORY_ROLES`. `GET /v1/suppliers/{id}` answers the supplier's
 * **private** record — the caller's own organization, or a platform operator
 * (`SYSTEM_ADMIN`/`UNION_ADMIN`) — and answers `404`, never `403`, for any
 * other organization's supplier, so its existence is not disclosed; that is
 * rendered exactly like an id that does not exist at all.
 *
 * ## What is kept, and what is dropped
 *
 * Every actor identifier the private record carries — `registeredBy`, a
 * qualification's `submittedBy` and `decidedBy`, a suspension's
 * `suspendedBy` and `reinstatedBy` — is dropped here, the same choice
 * `projects.ts` made for `createdBy` and `statusChangedBy`: an id nobody
 * reads should not travel with the page. Evidence document ids are dropped
 * too; they are opaque document-service handles this slice has no viewer
 * for, so only how many is kept.
 */

function pageSchema<S extends z.ZodTypeAny>(item: S) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().default(null),
    hasMore: z.boolean().default(false),
  });
}

/**
 * The capability and status vocabularies (`@/lib/supplier-fields`) are not
 * enforced on a response, on purpose — see `assets.ts` for why.
 */
const capability = z.string();
const supplierStatus = z.string();

/**
 * What the directory renders. `organizationId` is public on purpose
 * (`views.ts`: it is the handle a buyer uses to place an order with this
 * supplier, already carried on every offer marketplace serves).
 */
const supplierSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  displayName: z.string(),
  status: supplierStatus,
  capabilities: z.array(capability).default([]),
  qualifiedFor: z.array(capability).default([]),
  registeredAt: utcInstant,
});

export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

const supplierPageSchema = pageSchema(supplierSummarySchema);
export type SupplierPage = z.infer<typeof supplierPageSchema>;

/**
 * One capability's qualification history.
 *
 * `evidence` arrives as a list of document-service handles (`documentId`,
 * `label`); none of that reaches what this module returns — like
 * `projects.ts` dropping the operating-area polygon for a `hasArea` flag,
 * only `evidenceCount` survives the transform below.
 */
const rawQualificationSchema = z.object({
  id: z.string(),
  capability,
  state: z.string(),
  statement: z.string().nullable().default(null),
  submittedAt: utcInstant,
  decidedAt: utcInstant.nullable().default(null),
  decisionNote: z.string().nullable().default(null),
  evidence: z.array(z.unknown()).default([]),
  current: z.boolean().default(false),
});

const qualificationSchema = rawQualificationSchema.transform(({ evidence, ...rest }) => ({
  ...rest,
  evidenceCount: evidence.length,
}));

export type QualificationRecord = z.infer<typeof qualificationSchema>;

/** One suspension episode. */
const suspensionSchema = z.object({
  id: z.string(),
  reason: z.string(),
  suspendedAt: utcInstant,
  reinstatedAt: utcInstant.nullable().default(null),
  reinstatementNote: z.string().nullable().default(null),
  open: z.boolean().default(false),
});

export type SuspensionRecord = z.infer<typeof suspensionSchema>;

/** The private record: the caller's own organization, or a platform operator. */
const supplierDetailSchema = supplierSummarySchema.extend({
  qualifications: z.array(qualificationSchema).default([]),
  suspensions: z.array(suspensionSchema).default([]),
});

export type SupplierDetail = z.infer<typeof supplierDetailSchema>;

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      // supplier-service answers 404, never 403, for another organization's
      // supplier, so its existence is not disclosed. It is rendered as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export const SUPPLIERS_PER_PAGE = 20;

export interface SupplierListQuery {
  readonly status?: string;
  readonly capability?: string;
  readonly cursor?: string;
}

export function fetchSuppliers(
  session: WebSession,
  query: SupplierListQuery = {},
): Promise<ReadResult<SupplierPage>> {
  const search = new URLSearchParams({ limit: String(SUPPLIERS_PER_PAGE) });
  if (query.status) search.set('status', query.status);
  if (query.capability) search.set('capability', query.capability);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/suppliers?${search.toString()}`, supplierPageSchema);
}

export function fetchSupplier(
  session: WebSession,
  supplierId: string,
): Promise<ReadResult<SupplierDetail>> {
  return read(session, `/v1/suppliers/${encodeURIComponent(supplierId)}`, supplierDetailSchema);
}
